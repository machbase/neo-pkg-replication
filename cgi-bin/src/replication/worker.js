'use strict';

/**
 * @fileoverview Worker — 파티션 단위 복제 상태 머신
 *
 * 상태 전이: RESOLVE_START → [STARTUP_INTEGRITY] → STEADY_REPLICATION
 */

const path = require('path');
const CheckpointStore = require('../db/checkpoint.js');
const RetryHandler = require('../lib/retry.js');
const { MachbaseClient } = require('../db/client.js');
const { createQueryClient, parseEpochNsLike } = require('../db/remote.js');
const { TagDataTable, TagTable, LogTable } = require('../db/table.js');
const { getInstance: getLogger } = require('../lib/logger.js');
const { FLAG_METADATA, FLAG_PRIMARY, FLAG_BASETIME } = require('../db/types.js');
const { applyTransformRules, collectReferencedColumns } = require('./rules.js');

const CHECKPOINT_BASE = path.resolve(path.dirname(process.argv[1]));
const CHECKPOINT_DIRECTORY = path.join(CHECKPOINT_BASE, 'data');
const INTEGRITY_BATCH_LIMIT = 500;

async function _withRetry({ fn, retry, shutdownFlag, logCtx, exhaustedMsg, retryMsg, phase }) {
  const ctx = phase ? { ...logCtx, phase } : logCtx;
  let attempt = 0;
  let lastDetail = null;
  while (true) {
    if (shutdownFlag.value) return { ok: false };
    if (attempt > 0) {
      if (retry.isExhausted(attempt)) {
        getLogger().error('worker', { ...ctx, msg: exhaustedMsg });
        return { ok: false };
      }
      const delay = retry.nextDelay(attempt - 1);
      if (retryMsg) {
        const warnFields = { ...ctx, attempt };
        if (lastDetail) warnFields.cause = lastDetail;
        warnFields.msg = `${retryMsg}, delay=${delay}ms`;
        getLogger().warn('worker', warnFields);
      }
      const signal = await retry.sleepOrShutdown(delay, shutdownFlag);
      if (signal === 'shutdown') return { ok: false };
    }
    const result = await fn();
    if (result.done) return { ok: true, value: result.value };
    lastDetail = result.detail || null;
    if (!result.retryable) {
      getLogger().error('worker', { ...ctx, msg: result.msg });
      return { ok: false };
    }
    attempt++;
  }
}

async function _appendRows(dstTable, outRows, retry, shutdownFlag, logCtx) {
  const result = await _withRetry({
    fn: async () => {
      const err = await dstTable.append(outRows);
      if (err) return { done: false, retryable: retry.shouldRetry(err), msg: `non-retryable append error: ${err.message}`, detail: err.message };
      return { done: true, value: true };
    },
    retry,
    shutdownFlag,
    logCtx,
    exhaustedMsg: 'append retry exhausted, skipping job',
    retryMsg: 'append retry',
  });
  return result.ok;
}

async function _readRows(srcTable, startRid, endRid, batchSize, options, retry, shutdownFlag, logCtx, phase) {
  const result = await _withRetry({
    fn: async () => {
      const readResult = await srcTable.read(startRid, endRid, batchSize, options);
      if (readResult.err) {
        return {
          done: false,
          retryable: retry.shouldRetry(readResult.err),
          msg: `non-retryable read error: ${readResult.err.message}`,
          detail: readResult.err.message,
        };
      }
      return { done: true, value: readResult };
    },
    retry,
    shutdownFlag,
    logCtx,
    exhaustedMsg: 'read retry exhausted, stopping worker',
    retryMsg: 'read retry',
    phase,
  });
  return result.ok ? result.value : null;
}

function _uniqueNames(values) {
  const seen = {};
  const result = [];
  for (const value of values || []) {
    if (!value || seen[value]) continue;
    seen[value] = true;
    result.push(value);
  }
  return result;
}

function _toEpochNs(value) {
  return parseEpochNsLike(value);
}

class Worker {
  constructor(config, dataTable, srcSchema, dstSchema, shutdownFlag, metaSyncManager) {
    this.config = config;
    this.dataTable = dataTable;
    this.srcSchema = srcSchema;
    this.dstSchema = dstSchema;
    this.shutdownFlag = shutdownFlag;
    this.metaSyncManager = metaSyncManager || null;
  }

  async run(signal) {
    const logCtx = {
      src: `${this.config.source.host}:${this.config.source.port}/${this.config.source.table}`,
      partition: this.dataTable,
    };

    if (signal.aborted) return;

    const { shutdownFlag } = this;
    const effectiveShutdownFlag = {
      get value() { return signal.aborted || shutdownFlag.value; },
    };

    let srcTable;
    let dstTable;
    if (this.srcSchema.tableType === 'TAG') {
      srcTable = new TagDataTable(this.dataTable, this.config.source);
      srcTable.setSchema(this.srcSchema);
      dstTable = new TagTable(this.config.target, this.config.target.table);
      dstTable.setSchema(this.dstSchema);
    } else {
      srcTable = new LogTable(this.dataTable, this.config.source);
      srcTable.setSchema(this.srcSchema);
      dstTable = new LogTable(this.config.target.table, this.config.target);
      dstTable.setSchema(this.dstSchema);
    }

    try {
      await srcTable.open();
      await dstTable.open();
      await this._runStateMachine({
        srcTable,
        dstTable,
        shutdownFlag: effectiveShutdownFlag,
      });
    } finally {
      try { await dstTable.close(); } catch (err) {
        getLogger().error('worker', { ...logCtx, msg: `dstTable.close failed: ${err.message}` });
      }
      try { await srcTable.close(); } catch (err) {
        getLogger().error('worker', { ...logCtx, msg: `srcTable.close failed: ${err.message}` });
      }
    }
  }

  /**
   * worker가 반복적으로 참조하는 transport별 실행 정책을 한 번만 계산한다.
   *
   * 의도:
   * - state machine 내부에서는 source/target type 분기를 매번 다시 해석하지 않게 한다.
   * - native/http target은 schema 조회와 restart integrity가 가능하므로 복구 경로를 적극 사용한다.
   * - mqtt-api/mqtt-publish target은 write 중심 target으로 간주하고 payload 기반 write만 수행한다.
   *
   * 주의:
   * - target type 정책을 바꿀 때는 metadata 전달 방식, 별도 metadata insert 여부,
   *   integrity 가능 여부를 함께 조정해야 재시작/중복방지 동작이 깨지지 않는다.
   */
  _buildPlan() {
    const sourceColumns = Array.isArray(this.config.source.columns) ? this.config.source.columns.slice() : [];
    const targetColumns = Array.isArray(this.config.target.columns) ? this.config.target.columns.slice() : [];
    const sourceMeta = Array.isArray(this.config.source.meta) ? this.config.source.meta.slice() : [];
    const targetMeta = Array.isArray(this.config.target.meta) ? this.config.target.meta.slice() : [];
    const repTargetCond = this.config.source.rep_target_cond || null;
    const transform = Array.isArray(this.config.source.transform) ? this.config.source.transform : [];

    const sourcePrimaryCol = this.srcSchema.columns.find((column) => column.flag & FLAG_PRIMARY) || null;
    const sourceBaseTimeCol = this.srcSchema.columns.find((column) => column.flag & FLAG_BASETIME) || null;
    const targetPrimaryCol = this.dstSchema.columns.find((column) => column.flag & FLAG_PRIMARY) || null;
    const targetBaseTimeCol = this.dstSchema.columns.find((column) => column.flag & FLAG_BASETIME) || null;
    const sourceDataCols = this.srcSchema.columns.filter((column) => !(column.flag & FLAG_METADATA)).map((column) => column.name);
    const targetDataCols = this.dstSchema.columns.filter((column) => !(column.flag & FLAG_METADATA)).map((column) => column.name);
    const targetMetaCols = this.dstSchema.columns.filter((column) => column.flag & FLAG_METADATA).map((column) => column.name);
    const targetType = String(this.config.target?.type || 'native').toLowerCase();
    // http/mqtt 계열은 한 번의 payload에 data+meta를 실어 보낼 수 있다.
    const targetUsesPayloadMeta = targetType === 'http'
      || targetType === 'mqtt-api'
      || targetType === 'mqtt-publish';
    // native/http는 기존 DB 동작과 동일하게 metadata를 별도 insert 경로로도 맞춰 준다.
    const targetSeparateMetadataInsert = targetType === 'native' || targetType === 'http';
    // restart 시 target 상태를 조회해 시작점을 조정할 수 있는 transport만 integrity를 수행한다.
    const supportsIntegrity = targetType === 'native' || targetType === 'http';
    const integrityUsesEpochNs = supportsIntegrity;
    const referencedColumns = collectReferencedColumns(repTargetCond, transform);
    const readColumns = _uniqueNames(
      sourceColumns.filter((name) => !!name)
        .concat(referencedColumns)
        .concat(sourcePrimaryCol ? [sourcePrimaryCol.name] : [])
        .concat(sourceBaseTimeCol ? [sourceBaseTimeCol.name] : [])
    );

    return {
      sourceColumns,
      targetColumns,
      sourceMeta,
      targetMeta,
      repTargetCond,
      transform,
      readColumns,
      sourcePrimaryColName: sourcePrimaryCol ? sourcePrimaryCol.name : null,
      sourceBaseTimeColName: sourceBaseTimeCol ? sourceBaseTimeCol.name : null,
      targetPrimaryColName: targetPrimaryCol ? targetPrimaryCol.name : null,
      targetBaseTimeColName: targetBaseTimeCol ? targetBaseTimeCol.name : null,
      targetDataCols,
      targetMetaCols,
      appendColumns: targetUsesPayloadMeta ? targetDataCols.concat(targetMetaCols) : targetDataCols.slice(),
      targetUsesPayloadMeta,
      payloadMetaFromSource: targetType === 'mqtt-api' || targetType === 'mqtt-publish',
      targetSeparateMetadataInsert,
      supportsIntegrity,
      integrityUsesEpochNs,
      isTag: this.srcSchema.tableType === 'TAG',
    };
  }

  _buildTargetRow(sourceRow, plan) {
    const out = {};
    for (const name of plan.targetDataCols) {
      out[name] = null;
    }
    for (let i = 0; i < plan.targetColumns.length; i++) {
      const targetName = plan.targetColumns[i];
      if (!targetName) continue;
      const sourceName = plan.sourceColumns[i];
      out[targetName] = sourceName ? sourceRow[sourceName] : null;
    }
    return out;
  }

  _buildTargetPayloadRow(sourceRow, plan) {
    const out = this._buildTargetRow(sourceRow, plan);
    for (const name of plan.targetMetaCols) {
      out[name] = null;
    }
    if (!plan.payloadMetaFromSource) {
      return out;
    }
    for (let i = 0; i < plan.targetMeta.length; i++) {
      const targetName = plan.targetMeta[i];
      if (!targetName) continue;
      const sourceName = plan.sourceMeta[i];
      out[targetName] = sourceName ? sourceRow[sourceName] : null;
    }
    return out;
  }

  _processRows(rows, plan, logCtx) {
    const appendRows = [];
    const resolved = [];
    let maxSourceTagId = null;

    for (const item of rows) {
      const transformed = applyTransformRules(item.data, plan.transform);
      if (transformed.dropped) continue;

      const targetRow = plan.targetUsesPayloadMeta
        ? this._buildTargetPayloadRow(transformed.row, plan)
        : this._buildTargetRow(transformed.row, plan);
      if (plan.isTag) {
        const canonical = targetRow[plan.targetPrimaryColName];
        const time = targetRow[plan.targetBaseTimeColName];
        if (canonical == null || time == null) {
          getLogger().warn('worker', { ...logCtx, rid: String(item.rid), msg: 'target key columns resolved to null, row skipped' });
          continue;
        }
        resolved.push({ rid: item.rid, canonical, time });
        if (plan.integrityUsesEpochNs) {
          resolved[resolved.length - 1].time = _toEpochNs(time);
        }
        if (item.tagId != null) {
          const sourceTagId = BigInt(item.tagId);
          if (maxSourceTagId == null || sourceTagId > maxSourceTagId) {
            maxSourceTagId = sourceTagId;
          }
        }
      }
      appendRows.push(targetRow);
    }

    return { appendRows, resolved, maxSourceTagId };
  }

  _saveCheckpoint(checkpointStore, rid, totalRowsWritten, stats, hasMore, queryLimit) {
    checkpointStore.save({
      lastSuccessRid: rid,
      totalRowsWritten,
      sourceServer: this.config.source.host,
      sourceTable: this.config.source.table,
    }, stats, {
      onSaveFailure: this.config.onSaveFailure,
      queryLimit,
      hasMore,
    });
  }

  async _getMaxRid(srcTable, retry, shutdownFlag, logCtx, phase) {
    const result = await _withRetry({
      fn: async () => {
        try {
          return { done: true, value: await srcTable.getMaxRid() };
        } catch (err) {
          return {
            done: false,
            retryable: retry.shouldRetry(err),
            msg: `non-retryable getMaxRid error: ${err.message}`,
          };
        }
      },
      retry,
      shutdownFlag,
      logCtx,
      exhaustedMsg: 'getMaxRid retry exhausted, stopping worker',
      retryMsg: 'getMaxRid retry',
      phase,
    });
    return result.ok ? result.value : null;
  }

  async _runStateMachine({ srcTable, dstTable, shutdownFlag }) {
    const batchSize = this.config.queryLimit;
    const pollIntervalMs = this.config.pollIntervalMs;
    const logCtx = { job_id: this.config.id, partition: this.dataTable };
    const retry = new RetryHandler(this.config.retry || {});
    const checkpointStore = new CheckpointStore(path.join(CHECKPOINT_DIRECTORY, this.config.id), this.dataTable);
    const plan = this._buildPlan();
    if (typeof dstTable.setAppendColumns === 'function') {
      dstTable.setAppendColumns(plan.appendColumns);
    }

    if (plan.isTag && (!plan.sourcePrimaryColName || !plan.sourceBaseTimeColName || !plan.targetPrimaryColName || !plan.targetBaseTimeColName)) {
      getLogger().error('worker', { ...logCtx, msg: 'TAG key columns not found in source/target schema' });
      return;
    }

    const { cp, exists: cpExists } = checkpointStore.load();
    let startRid;
    let totalRowsWritten = cpExists && cp && cp.totalRowsWritten != null ? BigInt(String(cp.totalRowsWritten)) : 0n;
    if (cpExists && cp) {
      startRid = cp.lastSuccessRid + 1n;
      getLogger().debug('worker', { ...logCtx, startRid: String(startRid), msg: 'resume from checkpoint' });
      getLogger().info('worker', {
        ...logCtx,
        checkpointRid: String(cp.lastSuccessRid),
        startRid: String(startRid),
        msg: 'start position loaded from checkpoint',
      });
    } else {
      const startMode = this.config.startMode;
      if (startMode === 'now') {
        const maxRid = await this._getMaxRid(srcTable, retry, shutdownFlag, logCtx, 'RESOLVE_START');
        if (maxRid == null) return;
        startRid = maxRid + 1n;
      } else if (startMode === 'ridAfter') {
        startRid = BigInt(this.config.ridAfter);
      } else {
        startRid = 0n;
      }
      getLogger().debug('worker', { ...logCtx, startMode: this.config.startMode, startRid: String(startRid), msg: 'worker start' });
      const initialCpRid = startRid > 0n ? (startRid - 1n) : -1n;
      this._saveCheckpoint(checkpointStore, initialCpRid, totalRowsWritten, {
        rowsRead: 0,
        rowsWritten: 0,
        droppedNoMeta: 0,
        skippedExists: 0,
      }, false, batchSize);
    }

    if (plan.isTag) {
      const loadErr = await srcTable.cacheTagMetaAll();
      if (loadErr) {
        getLogger().warn('worker', { ...logCtx, msg: `loadTagMetaCache failed, falling back to per-row DB lookup: ${loadErr.message}` });
      }
    }
    const doIntegrity = plan.isTag && plan.supportsIntegrity && cpExists;
    try {
      if (doIntegrity) {
        const originalStartRid = startRid;
        const result = await this._runStartupIntegrity({
          startRid,
          totalRowsWritten,
          srcTable,
          dstTable,
          retry,
          shutdownFlag,
          logCtx,
          checkpointStore,
          plan,
        });
        if (result === null) return;
        startRid = result.startRid;
        totalRowsWritten = result.totalRowsWritten;
        if (startRid !== originalStartRid) {
          getLogger().info('worker', {
            ...logCtx,
            fromRid: String(originalStartRid),
            toRid: String(startRid),
            msg: 'start position adjusted by target integrity check',
          });
        }
      }

      while (!shutdownFlag.value) {
        const maxRid = await this._getMaxRid(srcTable, retry, shutdownFlag, logCtx, 'STEADY_MAXRID');
        if (maxRid == null) return;

        if (startRid > maxRid) {
          const idleCpRid = startRid > 0n ? (startRid - 1n) : -1n;
          this._saveCheckpoint(checkpointStore, idleCpRid, totalRowsWritten, {
            rowsRead: 0,
            rowsWritten: 0,
            droppedNoMeta: 0,
            skippedExists: 0,
          }, false, batchSize);
          const signal = await retry.sleepOrShutdown(pollIntervalMs, shutdownFlag);
          if (signal === 'shutdown') return;
          continue;
        }

        let endRid = startRid + BigInt(batchSize) - 1n;
        if (endRid > maxRid) endRid = maxRid;

        const readResult = await _readRows(srcTable, startRid, endRid, batchSize, {
          selectColumns: plan.readColumns,
          repTargetCond: plan.repTargetCond,
          transform: plan.transform,
        }, retry, shutdownFlag, logCtx, 'STEADY_READ');
        if (readResult == null) return;

        const processed = this._processRows(readResult.rows, plan, logCtx);
        if (shutdownFlag.value) return;

        if (plan.isTag && plan.targetSeparateMetadataInsert && processed.maxSourceTagId != null && this.metaSyncManager) {
          const metadataOk = await this.metaSyncManager.ensureUpToTagId(processed.maxSourceTagId, logCtx);
          if (!metadataOk) return;
        }

        if (processed.appendRows.length > 0) {
          const ok = await _appendRows(dstTable, processed.appendRows, retry, shutdownFlag, logCtx);
          if (!ok) return;
        }

        totalRowsWritten += BigInt(processed.appendRows.length);
        getLogger().debug('worker_batch', {
          ...logCtx,
          phase: 'STEADY',
          fromRid: String(startRid),
          toRid: String(endRid),
          rowsRead: readResult.rows.length,
          rowsWritten: processed.appendRows.length,
          droppedNoMeta: 0,
          skippedExists: 0,
          totalRowsWritten: totalRowsWritten.toString(),
        });
        this._saveCheckpoint(checkpointStore, endRid, totalRowsWritten, {
          rowsRead: readResult.rows.length,
          rowsWritten: processed.appendRows.length,
          droppedNoMeta: 0,
          skippedExists: 0,
        }, endRid < maxRid, batchSize);

        startRid = endRid + 1n;
      }
    } finally {
      // metadata sync client는 worker마다 열지 않고 replicator-level manager가 소유한다.
    }
  }

  async _runStartupIntegrity({ startRid, totalRowsWritten, srcTable, dstTable, retry, shutdownFlag, logCtx, checkpointStore, plan }) {
    getLogger().debug('worker', { ...logCtx, fromRid: String(startRid), msg: 'integrity check start' });

    let integrityRid = startRid;
    const integrityBatchSize = Math.min(this.config.queryLimit, INTEGRITY_BATCH_LIMIT);

    while (!shutdownFlag.value) {
      const maxRid = await this._getMaxRid(srcTable, retry, shutdownFlag, logCtx, 'STARTUP_MAXRID');
      if (maxRid == null) return null;
      if (integrityRid > maxRid) {
        startRid = integrityRid;
        break;
      }

      let endRid = integrityRid + BigInt(integrityBatchSize) - 1n;
      if (endRid > maxRid) endRid = maxRid;

      const readResult = await _readRows(srcTable, integrityRid, endRid, integrityBatchSize, {
        selectColumns: plan.readColumns,
        repTargetCond: plan.repTargetCond,
        transform: plan.transform,
      }, retry, shutdownFlag, logCtx, 'STARTUP_INTEGRITY_READ');
      if (readResult == null) return null;

      const processed = this._processRows(readResult.rows, plan, logCtx);
      if (processed.resolved.length === 0) {
        this._saveCheckpoint(checkpointStore, endRid, totalRowsWritten, {
          rowsRead: 0,
          rowsWritten: 0,
          droppedNoMeta: 0,
          skippedExists: 0,
        }, endRid < maxRid, integrityBatchSize);
        integrityRid = endRid + 1n;
        continue;
      }

      const targetType = String(this.config.target?.type || 'native').toLowerCase();
      const intConn = targetType === 'native'
        ? new MachbaseClient(this.config.target)
        : createQueryClient(this.config.target);
      try {
        await intConn.connect();
        const result = await dstTable.findFirstMissRow(processed.resolved, intConn, this.dataTable);
        if (result.err) {
          getLogger().error('worker', { ...logCtx, msg: `findFirstMissRow failed: ${result.err.message}` });
          return null;
        }

        if (result.firstMissIdx !== null) {
          const firstMissRid = processed.resolved[result.firstMissIdx].rid;
          const safeCpRid = firstMissRid > 0n ? firstMissRid - 1n : 0n;
          totalRowsWritten += BigInt(result.firstMissIdx);
          this._saveCheckpoint(checkpointStore, safeCpRid, totalRowsWritten, {
            rowsRead: readResult.rows.length,
            rowsWritten: 0,
            droppedNoMeta: 0,
            skippedExists: result.firstMissIdx,
          }, true, integrityBatchSize);
          getLogger().debug('worker', { ...logCtx, firstMissRid: String(firstMissRid), safeCpRid: String(safeCpRid), msg: 'integrity check: first missing row found' });
          startRid = firstMissRid;
          break;
        }

        totalRowsWritten += BigInt(processed.appendRows.length);
        getLogger().debug('worker_batch', {
          ...logCtx,
          phase: 'STARTUP_INTEGRITY',
          fromRid: String(integrityRid),
          toRid: String(endRid),
          rowsRead: readResult.rows.length,
          rowsWritten: 0,
          droppedNoMeta: 0,
          skippedExists: processed.resolved.length,
          totalRowsWritten: totalRowsWritten.toString(),
        });
        this._saveCheckpoint(checkpointStore, endRid, totalRowsWritten, {
          rowsRead: readResult.rows.length,
          rowsWritten: 0,
          droppedNoMeta: 0,
          skippedExists: processed.resolved.length,
        }, endRid < maxRid, integrityBatchSize);
        integrityRid = endRid + 1n;
      } finally {
        try { await intConn.close(); } catch (_) {}
      }
    }

    if (shutdownFlag.value) return null;
    return { startRid, totalRowsWritten };
  }
}

module.exports = { Worker };
