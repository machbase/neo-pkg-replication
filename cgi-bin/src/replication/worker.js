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
  while (true) {
    if (shutdownFlag.value) return { ok: false };
    if (attempt > 0) {
      if (retry.isExhausted(attempt)) {
        getLogger().error('worker', { ...ctx, msg: exhaustedMsg });
        return { ok: false };
      }
      const delay = retry.nextDelay(attempt - 1);
      if (retryMsg) {
        getLogger().warn('worker', { ...ctx, attempt, msg: `${retryMsg}, delay=${delay}ms` });
      }
      const signal = await retry.sleepOrShutdown(delay, shutdownFlag);
      if (signal === 'shutdown') return { ok: false };
    }
    const result = fn();
    if (result.done) return { ok: true, value: result.value };
    if (!result.retryable) {
      getLogger().error('worker', { ...ctx, msg: result.msg });
      return { ok: false };
    }
    attempt++;
  }
}

async function _appendRows(dstTable, outRows, retry, shutdownFlag, logCtx) {
  const result = await _withRetry({
    fn: () => {
      const err = dstTable.append(outRows);
      if (err) return { done: false, retryable: retry.shouldRetry(err), msg: `non-retryable append error: ${err.message}` };
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

function _isDuplicateMetadataError(err) {
  const message = err && err.message ? String(err.message).toLowerCase() : '';
  return message.indexOf('duplicate') >= 0
    || message.indexOf('already exists') >= 0
    || message.indexOf('unique') >= 0;
}

class Worker {
  constructor(config, dataTable, srcSchema, dstSchema, shutdownFlag) {
    this.config = config;
    this.dataTable = dataTable;
    this.srcSchema = srcSchema;
    this.dstSchema = dstSchema;
    this.shutdownFlag = shutdownFlag;
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
      srcTable.open();
      dstTable.open();
      await this._runStateMachine({
        srcTable,
        dstTable,
        shutdownFlag: effectiveShutdownFlag,
      });
    } finally {
      try { dstTable.close(); } catch (err) {
        getLogger().error('worker', { ...logCtx, msg: `dstTable.close failed: ${err.message}` });
      }
      try { srcTable.close(); } catch (err) {
        getLogger().error('worker', { ...logCtx, msg: `srcTable.close failed: ${err.message}` });
      }
    }
  }

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

  _buildTargetMetaValues(sourceRow, plan) {
    const values = [];
    for (let i = 0; i < plan.targetMeta.length; i++) {
      const targetName = plan.targetMeta[i];
      if (!targetName) continue;
      const sourceName = plan.sourceMeta[i];
      values.push(sourceName ? sourceRow[sourceName] : null);
    }
    return values;
  }

  _processRows(rows, plan, logCtx) {
    const targetRows = [];
    const resolved = [];
    const pendingMetaByName = {};

    for (const item of rows) {
      const transformed = applyTransformRules(item.data, plan.transform);
      if (transformed.dropped) continue;

      const targetRow = this._buildTargetRow(transformed.row, plan);
      if (plan.isTag) {
        const canonical = targetRow[plan.targetPrimaryColName];
        const time = targetRow[plan.targetBaseTimeColName];
        if (canonical == null || time == null) {
          getLogger().warn('worker', { ...logCtx, rid: String(item.rid), msg: 'target key columns resolved to null, row skipped' });
          continue;
        }
        resolved.push({ rid: item.rid, canonical, time });
        if (!pendingMetaByName[canonical]) {
          pendingMetaByName[canonical] = this._buildTargetMetaValues(transformed.row, plan);
        }
      }
      targetRows.push(targetRow);
    }

    const metadataRows = Object.keys(pendingMetaByName).map((name) => ({
      name,
      values: pendingMetaByName[name],
    }));

    return { targetRows, resolved, metadataRows };
  }

  _saveCheckpoint(checkpointStore, rid, stats, hasMore, queryLimit) {
    checkpointStore.save({
      lastSuccessRid: rid,
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
      fn: () => {
        try {
          return { done: true, value: srcTable.getMaxRid() };
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

  async _ensureTagMetadata(metaClient, targetMetaNames, metadataRows, retry, shutdownFlag, logCtx) {
    if (!metaClient || !Array.isArray(metadataRows) || metadataRows.length === 0) return true;

    for (const row of metadataRows) {
      if (shutdownFlag.value) return false;
      if (targetMetaNames[row.name]) continue;
      const ok = await _withRetry({
        fn: () => {
          try {
            metaClient.insertTagMeta(this.config.target.table, [row.name].concat(row.values));
            targetMetaNames[row.name] = true;
            return { done: true, value: true };
          } catch (err) {
            if (_isDuplicateMetadataError(err)) {
              targetMetaNames[row.name] = true;
              return { done: true, value: true };
            }
            return {
              done: false,
              retryable: retry.shouldRetry(err),
              msg: `non-retryable metadata insert error: ${err.message}`,
            };
          }
        },
        retry,
        shutdownFlag,
        logCtx: { ...logCtx, tag_name: row.name },
        exhaustedMsg: 'metadata insert retry exhausted, stopping worker',
        retryMsg: 'metadata insert retry',
        phase: 'METADATA',
      });
      if (!ok.ok) return false;
    }
    return true;
  }

  async _runStateMachine({ srcTable, dstTable, shutdownFlag }) {
    const batchSize = this.config.queryLimit;
    const pollIntervalMs = this.config.pollIntervalMs;
    const logCtx = { job_id: this.config.id, partition: this.dataTable };
    const retry = new RetryHandler(this.config.retry || {});
    const checkpointStore = new CheckpointStore(path.join(CHECKPOINT_DIRECTORY, this.config.id), this.dataTable);
    const plan = this._buildPlan();

    if (plan.isTag && (!plan.sourcePrimaryColName || !plan.sourceBaseTimeColName || !plan.targetPrimaryColName || !plan.targetBaseTimeColName)) {
      getLogger().error('worker', { ...logCtx, msg: 'TAG key columns not found in source/target schema' });
      return;
    }

    let metaClient = null;
    let targetMetaNames = {};

    const { cp, exists: cpExists } = checkpointStore.load();
    let startRid;
    if (cpExists && cp) {
      startRid = cp.lastSuccessRid + 1n;
      getLogger().info('worker', { ...logCtx, startRid: String(startRid), msg: 'resume from checkpoint' });
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
      getLogger().info('worker', { ...logCtx, startMode: this.config.startMode, startRid: String(startRid), msg: 'worker start' });
      const initialCpRid = startRid > 0n ? (startRid - 1n) : -1n;
      this._saveCheckpoint(checkpointStore, initialCpRid, {
        rowsRead: 0,
        rowsWritten: 0,
        droppedNoMeta: 0,
        skippedExists: 0,
      }, false, batchSize);
    }

    if (plan.isTag) {
      const loadErr = srcTable.cacheTagMetaAll();
      if (loadErr) {
        getLogger().warn('worker', { ...logCtx, msg: `loadTagMetaCache failed, falling back to per-row DB lookup: ${loadErr.message}` });
      }
      metaClient = new MachbaseClient(this.config.target);
      try {
        metaClient.connect();
        const rows = metaClient.selectTagNames(this.config.target.table);
        for (const row of (rows || [])) {
          targetMetaNames[row.name] = true;
        }
      } catch (err) {
        getLogger().error('worker', { ...logCtx, msg: `target metadata preload failed: ${err.message}` });
        return;
      }
    }

    try {
      const doIntegrity = plan.isTag && cpExists && this.config.integrity !== false;
      if (doIntegrity) {
        const result = await this._runStartupIntegrity({
          startRid,
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
      }

      while (!shutdownFlag.value) {
        const maxRid = await this._getMaxRid(srcTable, retry, shutdownFlag, logCtx, 'STEADY_MAXRID');
        if (maxRid == null) return;

        if (startRid > maxRid) {
          const idleCpRid = startRid > 0n ? (startRid - 1n) : -1n;
          this._saveCheckpoint(checkpointStore, idleCpRid, {
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

        const readResult = srcTable.read(startRid, endRid, batchSize, {
          selectColumns: plan.readColumns,
          repTargetCond: plan.repTargetCond,
          transform: plan.transform,
        });
        if (readResult.err) {
          getLogger().error('worker', { ...logCtx, phase: 'STEADY', msg: `read failed: ${readResult.err.message}` });
          return;
        }

        const processed = this._processRows(readResult.rows, plan, logCtx);
        if (shutdownFlag.value) return;

        if (plan.isTag) {
          const metadataOk = await this._ensureTagMetadata(metaClient, targetMetaNames, processed.metadataRows, retry, shutdownFlag, logCtx);
          if (!metadataOk) return;
        }

        if (processed.targetRows.length > 0) {
          const ok = await _appendRows(dstTable, processed.targetRows, retry, shutdownFlag, logCtx);
          if (!ok) return;
        }

        this._saveCheckpoint(checkpointStore, endRid, {
          rowsRead: readResult.rows.length,
          rowsWritten: processed.targetRows.length,
          droppedNoMeta: 0,
          skippedExists: 0,
        }, endRid < maxRid, batchSize);

        startRid = endRid + 1n;
      }
    } finally {
      try { metaClient && metaClient.close(); } catch (_) {}
    }
  }

  async _runStartupIntegrity({ startRid, srcTable, dstTable, retry, shutdownFlag, logCtx, checkpointStore, plan }) {
    getLogger().info('worker', { ...logCtx, fromRid: String(startRid), msg: 'integrity check start' });

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

      const readResult = srcTable.read(integrityRid, endRid, integrityBatchSize, {
        selectColumns: plan.readColumns,
        repTargetCond: plan.repTargetCond,
        transform: plan.transform,
      });
      if (readResult.err) {
        getLogger().error('worker', { ...logCtx, phase: 'STARTUP_INTEGRITY', msg: `read failed: ${readResult.err.message}` });
        return null;
      }

      const processed = this._processRows(readResult.rows, plan, logCtx);
      if (processed.resolved.length === 0) {
        this._saveCheckpoint(checkpointStore, endRid, {
          rowsRead: 0,
          rowsWritten: 0,
          droppedNoMeta: 0,
          skippedExists: 0,
        }, endRid < maxRid, integrityBatchSize);
        integrityRid = endRid + 1n;
        continue;
      }

      const intConn = new MachbaseClient(this.config.target);
      try {
        intConn.connect();
        const result = dstTable.findFirstMissRow(processed.resolved, intConn, this.dataTable);
        if (result.err) {
          getLogger().error('worker', { ...logCtx, msg: `findFirstMissRow failed: ${result.err.message}` });
          return null;
        }

        if (result.firstMissIdx !== null) {
          const firstMissRid = processed.resolved[result.firstMissIdx].rid;
          const safeCpRid = firstMissRid > 0n ? firstMissRid - 1n : 0n;
          this._saveCheckpoint(checkpointStore, safeCpRid, {
            rowsRead: readResult.rows.length,
            rowsWritten: 0,
            droppedNoMeta: 0,
            skippedExists: result.firstMissIdx,
          }, true, integrityBatchSize);
          getLogger().info('worker', { ...logCtx, firstMissRid: String(firstMissRid), safeCpRid: String(safeCpRid), msg: 'integrity check: first missing row found' });
          startRid = firstMissRid;
          break;
        }

        this._saveCheckpoint(checkpointStore, endRid, {
          rowsRead: readResult.rows.length,
          rowsWritten: 0,
          droppedNoMeta: 0,
          skippedExists: processed.resolved.length,
        }, endRid < maxRid, integrityBatchSize);
        integrityRid = endRid + 1n;
      } finally {
        try { intConn.close(); } catch (_) {}
      }
    }

    if (shutdownFlag.value) return null;
    return { startRid };
  }
}

module.exports = { Worker };
