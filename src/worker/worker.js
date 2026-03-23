'use strict';

const CheckpointStore = require('../db/checkpoint.js');
const RetryHandler = require('../lib/retry.js');
const { MachbaseClient } = require('../db/client.js');
const { TagDataTable, TagTable, LogTable } = require('../db/table.js');
const { getInstance: getLogger } = require('../lib/logger.js');
const { CHECKPOINT_DIRECTORY } = require('../config/config.js');

// ─── 상수 ────────────────────────────────────────────────────────────────────

// machcli는 statement ID 소진 문제가 없으나 안전을 위해 일정 주기마다 연결 갱신
const STMT_REFRESH_THRESHOLD = 900;

// STARTUP_INTEGRITY 배치 크기 상한: VOLATILE TABLE에 한 번에 INSERT할 행 수 제한
const INTEGRITY_BATCH_LIMIT = 500;

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

/**
 * rows 배열에서 최대 RID 반환 (BigInt)
 * @param {Array<{ rid: BigInt }>} rows
 * @returns {BigInt}
 */
function maxRid(rows) {
  return rows.reduce((acc, row) => row.rid > acc ? row.rid : acc, 0n);
}

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
  constructor(jobConfig, tableType, dataTable,
              srcSchema, dstSchema, srcConfig, dstConfig, shutdownFlag) {
    this.jobConfig = jobConfig;
    this.tableType = tableType;
    this.dataTable = dataTable;
    this.srcSchema = srcSchema;
    this.dstSchema = dstSchema;
    this.srcConfig = srcConfig;
    this.dstConfig = dstConfig;
    this.shutdownFlag = shutdownFlag;
  }

  /**
   * 연결 생성 + 전체 실행
   */
  async run(signal) {
    const { jobConfig, tableType, dataTable,
            srcSchema, dstSchema, srcConfig, dstConfig, shutdownFlag } = this;
    const logCtx = {
      job_id: jobConfig.id,
      partition: dataTable,
    };

    if (signal.aborted) return;

    const effectiveShutdownFlag = {
      get value() { return signal.aborted || shutdownFlag.value; },
    };

    let srcTable, dstTable;
    if (tableType === 'TAG') {
      srcTable = new TagDataTable(dataTable, srcConfig);
      srcTable.setSchema(srcSchema);
      dstTable = new TagTable(dstConfig, jobConfig.target.table);
      dstTable.setSchema(dstSchema);
    } else {
      srcTable = new LogTable(dataTable, srcConfig);
      srcTable.setSchema(srcSchema);
      dstTable = new LogTable(jobConfig.target.table, dstConfig);
      dstTable.setSchema(dstSchema);
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
    const { jobConfig, tableType, dataTable } = this;
    const batchSize      = jobConfig.queryLimit;
    const ridRangeSize   = jobConfig.ridRangeSize;
    const pollIntervalMs = jobConfig.pollIntervalMs;
    const sourceColumns  = jobConfig.source.columns;
    const filter    = jobConfig.source.filter    ?? null;
    const transform = jobConfig.source.transform ?? null;
    const nameRule  = transform?.find(t => t.column === 'NAME') ?? null;
    const retry = new RetryHandler(jobConfig.retry ?? {});
    const checkpointStore = new CheckpointStore(jobConfig.checkpoint?.directory ?? CHECKPOINT_DIRECTORY);
    const logCtx = { job_id: jobConfig.id, partition: dataTable };

    // ═══════════════════════════════════════════════════════════
    // RESOLVE_START — 시작 RID 결정
    // ═══════════════════════════════════════════════════════════

    const { cp, exists: cpExists } = checkpointStore.load(jobConfig.id, dataTable);
    let startRid;

    if (cpExists && cp) {
      startRid = cp.lastSuccessRid + 1n;
      getLogger().info('worker', { ...logCtx, startRid: String(startRid), msg: 'resume from checkpoint' });
    } else {
      const startMode = jobConfig.startMode;
      if (startMode === 'now') {
        try {
          startRid = srcTable.getMaxRid() + 1n;
        } catch (err) {
          getLogger().error('worker', { ...logCtx, msg: `getMaxRid failed (startMode=now): ${err.message}` });
          return;
        }
      } else if (startMode === 'ridAfter') {
        startRid = BigInt(jobConfig.ridAfter);
      } else {
        startRid = 0n; // 'full'
      }
      getLogger().info('worker', { ...logCtx, startMode, startRid: String(startRid), msg: 'worker start' });
    }

    // TAG alias cache 로드
    if (tableType === 'TAG') {
      const loadErr = srcTable.cacheTagMetaAll();
      if (loadErr) {
        getLogger().warn('worker', { ...logCtx, msg: `loadTagMetaCache failed, falling back to per-row DB lookup: ${loadErr.message}` });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // STARTUP_INTEGRITY
    // ═══════════════════════════════════════════════════════════

    const doIntegrity = tableType === 'TAG'
      && cpExists
      && (jobConfig.integrity === undefined || jobConfig.integrity.enabled !== false);

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

    let stmtCount = 0;

    while (!shutdownFlag.value) {
      if (stmtCount >= STMT_REFRESH_THRESHOLD) {
        try {
          srcTable.close();
          srcTable.open();
          if (tableType === 'TAG') {
            srcTable.cacheTagMetaAll();
          }
          stmtCount = 0;
          getLogger().debug('worker', { ...logCtx, msg: 'sourceConn refreshed (statement ID threshold)' });
        } catch (refreshErr) {
          getLogger().error('worker', { ...logCtx, msg: `sourceConn refresh failed: ${refreshErr.message}` });
          return;
        }
      }

      let readResult;
      if (tableType === 'TAG') {
        readResult = srcTable.read(startRid, batchSize, ridRangeSize, nameRule, sourceColumns, filter);
      } else {
        readResult = srcTable.read(startRid, batchSize, ridRangeSize, filter);
      }
      const { rows, err: readErr } = readResult;
      if (readErr) {
        getLogger().error('worker', { ...logCtx, phase: 'STEADY', msg: `read failed: ${readErr.message}` });
        return;
      }

      stmtCount += 2;

      if (rows.length === 0) {
        const signal = await retry.sleepOrShutdown(pollIntervalMs, shutdownFlag);
        if (signal === 'shutdown') return;
        continue;
      }

      const maxRidInBatch = maxRid(rows);
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
      checkpointStore.save(jobConfig.id, dataTable, {
        lastSuccessRid: maxRidInBatch,
        sourceServer:   jobConfig.source.server,
        sourceTable:    jobConfig.source.table,
      }, batchStats, { onSaveFailure: jobConfig.onSaveFailure });

      startRid = maxRidInBatch + 1n;
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
    const { jobConfig, dataTable, dstConfig } = this;

    getLogger().info('worker', { ...logCtx, fromRid: String(startRid), msg: 'integrity check start' });
    let integrityRid = startRid;
    const integrityBatchSize = Math.min(batchSize, INTEGRITY_BATCH_LIMIT);

    while (!shutdownFlag.value) {
      const intConn = new MachbaseClient(dstConfig);
      let outcome = 'continue';

      try {
        intConn.connect();

        const { rows, err: readErr } = srcTable.read(integrityRid, integrityBatchSize, ridRangeSize, nameRule, sourceColumns, filter);
        if (readErr) {
          getLogger().error('worker', { ...logCtx, phase: 'STARTUP_INTEGRITY', msg: `read failed: ${readErr.message}` });
          outcome = 'return'; break;
        }

        if (rows.length === 0) {
          startRid = integrityRid;
          getLogger().debug('worker', { ...logCtx, toRid: String(integrityRid), msg: 'integrity check: all rows confirmed' });
          outcome = 'break'; break;
        }

        const maxRidInBatch = maxRid(rows);
        const resolved = rows.map(row => ({ rid: row.rid, canonical: row.data.NAME, time: row.data.TIME }));

        if (shutdownFlag.value) { outcome = 'return'; break; }

        const { firstMissIdx, err: batchErr } = resolved.length === 0
          ? { firstMissIdx: null, err: null }
          : dstTable.findFirstMissRow(resolved, intConn, dataTable);

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
          checkpointStore.save(jobConfig.id, dataTable, {
            lastSuccessRid: safeCpRid,
            sourceServer:   jobConfig.source.server,
            sourceTable:    jobConfig.source.table,
          }, batchStats, { onSaveFailure: jobConfig.onSaveFailure });
          startRid = firstMissRid;
          getLogger().info('worker', { ...logCtx, firstMissRid: String(firstMissRid), safeCpRid: String(safeCpRid), msg: 'integrity check: first missing row found' });
          outcome = 'break'; break;
        }

        checkpointStore.save(jobConfig.id, dataTable, {
          lastSuccessRid: maxRidInBatch,
          sourceServer:   jobConfig.source.server,
          sourceTable:    jobConfig.source.table,
        }, batchStats, { onSaveFailure: jobConfig.onSaveFailure });
        integrityRid = maxRidInBatch + 1n;
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
