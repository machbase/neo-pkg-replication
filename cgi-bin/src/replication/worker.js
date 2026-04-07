'use strict';

const path = require('path');
const CheckpointStore = require('../db/checkpoint.js');
const RetryHandler = require('../lib/retry.js');
const { MachbaseClient } = require('../db/client.js');
const { TagDataTable, TagTable, LogTable } = require('../db/table.js');
const { getInstance: getLogger } = require('../lib/logger.js');

const CHECKPOINT_BASE = path.resolve(path.dirname(process.argv[1]));
const CHECKPOINT_DIRECTORY = path.join(CHECKPOINT_BASE, 'data');

// ─── 상수 ────────────────────────────────────────────────────────────────────

// STARTUP_INTEGRITY 배치 크기 상한: VOLATILE TABLE에 한 번에 INSERT할 행 수 제한
const INTEGRITY_BATCH_LIMIT = 500;

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────


/**
 * transform[] 적용: (value + add) * multiply, prefix/suffix
 * number 타입 컬럼에만 add/multiply 적용, BigInt/null/string은 skip
 */
function _applyTransform(rows, transform) {
  if (!transform || transform.length === 0) return rows;
  return rows.map(row => {
    const out = { ...row };
    for (const t of transform) {
      const val = out[t.column];
      if (typeof val === 'number') {
        out[t.column] = (val + t.add) * t.multiply;
      }
    }
    return out;
  });
}

/**
 * 공통 retry 루프
 */
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

/**
 * dstTable.append 을 retry 포함하여 호출
 * @returns {Promise<boolean>} true on success, false on exhausted/shutdown
 */
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

// ─── Worker 클래스 ────────────────────────────────────────────────────────────

/**
 * data_table 단위 복제 Worker
 *
 * 상태 전이:
 *   RESOLVE_START → [STARTUP_INTEGRITY] → STEADY_REPLICATION
 */
class Worker {
  constructor(config, dataTable, srcSchema, dstSchema, shutdownFlag) {
    this.config = config;
    this.dataTable = dataTable;
    this.srcSchema = srcSchema;
    this.dstSchema = dstSchema;
    this.shutdownFlag = shutdownFlag;
  }

  /**
   * 연결 생성 + 전체 실행
   */
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

    let srcTable, dstTable;
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
      try {
        dstTable.close();
      } catch (err) {
        getLogger().error('worker', { ...logCtx, msg: `dstTable.close failed: ${err.message}` });
      }
      try {
        srcTable.close();
      } catch (err) {
        getLogger().error('worker', { ...logCtx, msg: `srcTable.close failed: ${err.message}` });
      }
    }
  }

  /**
   * 상태 머신: RESOLVE_START → [STARTUP_INTEGRITY] → STEADY_REPLICATION
   */
  async _runStateMachine({ srcTable, dstTable, shutdownFlag }) {
    const batchSize      = this.config.queryLimit;
    const ridRangeSize   = this.config.ridRangeSize;
    const pollIntervalMs = this.config.pollIntervalMs;
    const sourceColumns  = this.config.source.columns;
    const filter    = this.config.source.filter    ?? null;
    const transform = this.config.source.transform ?? null;
    const nameRule  = transform?.find(t => t.column === 'NAME') ?? null;
    const retry = new RetryHandler(this.config.retry ?? {});
    const checkpointStore = new CheckpointStore(path.join(CHECKPOINT_DIRECTORY, this.config.id), this.dataTable);
    const logCtx = { job_id: this.config.id, partition: this.dataTable };

    // ═══════════════════════════════════════════════════════════
    // RESOLVE_START — 시작 RID 결정
    // ═══════════════════════════════════════════════════════════

    const { cp, exists: cpExists } = checkpointStore.load();
    let startRid;

    if (cpExists && cp) {
      startRid = cp.lastSuccessRid + 1n;
      getLogger().info('worker', { ...logCtx, startRid: String(startRid), msg: 'resume from checkpoint' });
    } else {
      const startMode = this.config.startMode;
      if (startMode === 'now') {
        try {
          startRid = srcTable.getMaxRid() + 1n;
        } catch (err) {
          getLogger().error('worker', { ...logCtx, msg: `getMaxRid failed (startMode=now): ${err.message}` });
          return;
        }
      } else if (startMode === 'ridAfter') {
        startRid = BigInt(this.config.ridAfter);
      } else {
        startRid = 0n; // 'full'
      }
      getLogger().info('worker', { ...logCtx, startMode, startRid: String(startRid), msg: 'worker start' });
    }

    // TAG alias cache 로드
    if (this.srcSchema.tableType === 'TAG') {
      const loadErr = srcTable.cacheTagMetaAll();
      if (loadErr) {
        getLogger().warn('worker', { ...logCtx, msg: `loadTagMetaCache failed, falling back to per-row DB lookup: ${loadErr.message}` });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // STARTUP_INTEGRITY
    // ═══════════════════════════════════════════════════════════

    const doIntegrity = this.srcSchema.tableType === 'TAG'
      && cpExists
      && this.config.integrity !== false;

    if (doIntegrity) {
      const result = await this._runStartupIntegrity({
        startRid,
        srcTable,
        dstTable,
        nameRule,
        sourceColumns,
        filter,
        batchSize,
        ridRangeSize,
        retry,
        shutdownFlag,
        logCtx,
        checkpointStore,
      });
      if (result === null) return;
      startRid = result.startRid;
    }

    // ═══════════════════════════════════════════════════════════
    // STEADY_REPLICATION — 메인 복제 루프
    // ═══════════════════════════════════════════════════════════

    while (!shutdownFlag.value) {
      let readResult;
      if (this.srcSchema.tableType === 'TAG') {
        readResult = srcTable.read(startRid, batchSize, ridRangeSize, nameRule, sourceColumns, filter);
      } else {
        readResult = srcTable.read(startRid, batchSize, ridRangeSize, filter);
      }
      const { rows, rangeMaxRid, err: readErr } = readResult;
      if (readErr) {
        getLogger().error('worker', { ...logCtx, phase: 'STEADY', msg: `read failed: ${readErr.message}` });
        return;
      }

      if (rows.length === 0) {
        if (rangeMaxRid > 0n) {
          // 배치 내 모든 행이 필터로 차단됨 — checkpoint만 진행
          checkpointStore.save({
            lastSuccessRid: rangeMaxRid,
            sourceHost:   this.config.source.host,
            sourceTable:    this.config.source.table,
          }, { rowsRead: 0, rowsWritten: 0, droppedNoMeta: 0, skippedExists: 0 },
          { onSaveFailure: this.config.onSaveFailure, queryLimit: batchSize });
          startRid = rangeMaxRid + 1n;
          continue;
        }
        const signal = await retry.sleepOrShutdown(pollIntervalMs, shutdownFlag);
        if (signal === 'shutdown') return;
        continue;
      }

      const outRows = _applyTransform(
        rows.map(row => row.data),
        transform
      );
      const droppedNoMeta = 0;

      if (shutdownFlag.value) return;

      if (outRows.length > 0) {
        const ok = await _appendRows(dstTable, outRows, retry, shutdownFlag, logCtx);
        if (!ok) return;
      }

      const batchStats = {
        rowsRead:      rows.length,
        rowsWritten:   outRows.length,
        droppedNoMeta,
        skippedExists: 0,
      };
      checkpointStore.save({
        lastSuccessRid: rangeMaxRid,
        sourceHost:   this.config.source.host,
        sourceTable:    this.config.source.table,
      }, batchStats, { onSaveFailure: this.config.onSaveFailure, queryLimit: batchSize });

      startRid = rangeMaxRid + 1n;
    }
  }

  /**
   * STARTUP_INTEGRITY 단계 실행
   * @returns {Promise<{ startRid: BigInt }|null>}
   */
  async _runStartupIntegrity({
    startRid,
    srcTable,
    dstTable,
    nameRule,
    sourceColumns,
    filter,
    batchSize,
    ridRangeSize,
    retry,
    shutdownFlag,
    logCtx,
    checkpointStore,
  }) {
    getLogger().info('worker', { ...logCtx, fromRid: String(startRid), msg: 'integrity check start' });
    let integrityRid = startRid;
    const integrityBatchSize = Math.min(batchSize, INTEGRITY_BATCH_LIMIT);

    while (!shutdownFlag.value) {
      const intConn = new MachbaseClient(this.config.target);
      let outcome = 'continue';

      try {
        intConn.connect();

        const { rows, rangeMaxRid: batchRangeMaxRid, err: readErr } = srcTable.read(integrityRid, integrityBatchSize, ridRangeSize, nameRule, sourceColumns, filter);
        if (readErr) {
          getLogger().error('worker', { ...logCtx, phase: 'STARTUP_INTEGRITY', msg: `read failed: ${readErr.message}` });
          outcome = 'return'; break;
        }

        if (rows.length === 0) {
          if (batchRangeMaxRid > 0n) {
            // 모든 행이 필터로 차단됨 — checkpoint 진행 후 계속
            checkpointStore.save({
              lastSuccessRid: batchRangeMaxRid,
              sourceHost:     this.config.source.host,
              sourceTable:    this.config.source.table,
            }, { rowsRead: 0, rowsWritten: 0, droppedNoMeta: 0, skippedExists: 0 },
            { onSaveFailure: this.config.onSaveFailure, queryLimit: integrityBatchSize });
            integrityRid = batchRangeMaxRid + 1n;
          } else {
            startRid = integrityRid;
            getLogger().debug('worker', { ...logCtx, toRid: String(integrityRid), msg: 'integrity check: all rows confirmed' });
            outcome = 'break';
          }
          break;
        }
        const resolved = rows.map(row => ({ rid: row.rid, canonical: row.data.NAME, time: row.data.TIME }));

        if (shutdownFlag.value) { outcome = 'return'; break; }

        const { firstMissIdx, err: batchErr } = resolved.length === 0
          ? { firstMissIdx: null, err: null }
          : dstTable.findFirstMissRow(resolved, intConn, this.dataTable);

        if (batchErr) {
          getLogger().error('worker', { ...logCtx, msg: `findFirstMissRow failed: ${batchErr.message}` });
          outcome = 'return'; break;
        }
        if (shutdownFlag.value) { outcome = 'return'; break; }

        let firstMissRid = null;
        let skippedExists = 0;
        if (firstMissIdx !== null) {
          firstMissRid = resolved[firstMissIdx].rid;
          skippedExists = firstMissIdx;
        } else {
          skippedExists = resolved.length;
        }
        if (shutdownFlag.value) { outcome = 'return'; break; }

        const batchStats = {
          rowsRead:      rows.length,
          rowsWritten:   0,
          droppedNoMeta: 0,
          skippedExists,
        };

        if (firstMissRid !== null) {
          const safeCpRid = firstMissRid > 0n ? firstMissRid - 1n : 0n;
          checkpointStore.save({
            lastSuccessRid: safeCpRid,
            sourceHost:     this.config.source.host,
            sourceTable:    this.config.source.table,
          }, batchStats, { onSaveFailure: this.config.onSaveFailure, queryLimit: integrityBatchSize });
          startRid = firstMissRid;
          getLogger().info('worker', { ...logCtx, firstMissRid: String(firstMissRid), safeCpRid: String(safeCpRid), msg: 'integrity check: first missing row found' });
          outcome = 'break'; break;
        }

        checkpointStore.save({
          lastSuccessRid: batchRangeMaxRid,
          sourceHost:   this.config.source.host,
          sourceTable:    this.config.source.table,
        }, batchStats, { onSaveFailure: this.config.onSaveFailure, queryLimit: integrityBatchSize });
        integrityRid = batchRangeMaxRid + 1n;
        getLogger().debug('worker', { ...logCtx, nextRid: String(integrityRid), msg: 'integrity check: batch confirmed' });
      } finally {
        try { intConn.close(); } catch (_) {}
      }

      if (outcome === 'return') return null;
      if (outcome === 'break')  break;
    }

    if (shutdownFlag.value) return null;
    return { startRid };
  }
}

module.exports = { Worker };
