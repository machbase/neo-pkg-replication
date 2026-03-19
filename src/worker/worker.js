'use strict';

const CheckpointStore = require('../db/checkpoint.js');
const RetryHandler = require('../lib/retry.js');
const { MachbaseClient } = require('../db/client.js');
const { TagDataTable, TagTable, LogTable } = require('../db/table.js');
const { getInstance: getLogger } = require('../lib/logger.js');
const { CHECKPOINT_DIRECTORY } = require('../config/config.js');

// ─── 상수 ────────────────────────────────────────────────────────────────────

// Statement ID 고갈 방지 임계값: ts-client는 쿼리마다 statement ID를 소비하고
// 서버 한도는 1024. read는 배치당 2개 쿼리(MAX + SELECT)를 사용하므로
// 이 임계값에 도달하면 연결을 재생성한다.
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
 * 공통 retry 루프: fn()을 retry 설정에 따라 반복 호출
 *
 * fn은 다음 중 하나를 반환해야 함:
 *   { done: true,  value }  → 성공, value를 반환
 *   { done: false, retryable: boolean, msg?: string } → 재시도 또는 즉시 중단
 *
 * @param {object} opts
 * @param {Function} opts.fn         - async 함수 () => { done, value, retryable, msg }
 * @param {RetryHandler} opts.retry
 * @param {{ value: boolean }} opts.shutdownFlag
 * @param {object} opts.logCtx
 * @param {string} opts.exhaustedMsg - 재시도 소진 시 에러 메시지
 * @param {string} [opts.retryMsg]   - 재시도 warn 메시지 프리픽스
 * @param {string} [opts.phase]      - logCtx 보완용 phase 필드
 * @returns {{ ok: true, value }|{ ok: false }}
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
    const result = await fn();
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
 * @returns {boolean} true on success, false on exhausted/shutdown
 */
async function _appendRows(dstTable, outRows, retry, shutdownFlag, logCtx) {
  const result = await _withRetry({
    fn: async () => {
      const err = await dstTable.append(outRows);
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
 *
 * STARTUP_INTEGRITY 진입 조건: TAG 테이블 + 체크포인트 존재 + integrity.enabled !== false
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

    // AbortSignal을 shutdownFlag처럼 동작하도록 proxy 생성
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
      await srcTable.open();

      const openErr = await dstTable.open(true);
      if (openErr) {
        getLogger().error('worker', { ...logCtx, msg: `dstTable.open failed: ${openErr.message}` });
        await srcTable.close();
        return;
      }

      await this._runStateMachine({
        srcTable,
        dstTable,
        shutdownFlag: effectiveShutdownFlag,
      });
    } finally {
      await dstTable.close().catch(err =>
        getLogger().error('worker', { ...logCtx, msg: `dstTable.close failed: ${err.message}` })
      );
      await srcTable.close().catch(err =>
        getLogger().error('worker', { ...logCtx, msg: `srcTable.close failed: ${err.message}` })
      );
    }
  }

  /**
   * 상태 머신: RESOLVE_START → [STARTUP_INTEGRITY] → STEADY_REPLICATION
   */
  async _runStateMachine({ srcTable, dstTable, shutdownFlag }) {
    const { jobConfig, tableType, dataTable } = this;
    const batchSize     = jobConfig.queryLimit;
    const ridRangeSize  = jobConfig.ridRangeSize;
    const pollIntervalMs = jobConfig.pollIntervalMs;
    const sourceColumns = jobConfig.source.columns;
    const tagIdentifier = jobConfig.source.tagIdentifier;
    const retry = new RetryHandler(jobConfig.retry ?? {});
    const checkpointStore = new CheckpointStore(CHECKPOINT_DIRECTORY);
    const logCtx = { job_id: jobConfig.id, partition: dataTable };

    // ═══════════════════════════════════════════════════════════
    // RESOLVE_START — 시작 RID 결정
    // ═══════════════════════════════════════════════════════════

    const { cp, exists: cpExists } = await checkpointStore.load(jobConfig.id, dataTable);
    let startRid;

    if (cpExists && cp) {
      startRid = cp.lastSuccessRid + 1n;
      getLogger().info('worker', { ...logCtx, startRid: String(startRid), msg: 'resume from checkpoint' });
    } else {
      const startMode = jobConfig.startMode;
      if (startMode === 'now') {
        try {
          const maxRidVal = await srcTable.getMaxRid();
          startRid = maxRidVal + 1n;
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
      const loadErr = await srcTable.loadTagAliasCache();
      if (loadErr) {
        getLogger().warn('worker', { ...logCtx, msg: `loadTagAliasCache failed, falling back to per-row DB lookup: ${loadErr.message}` });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // STARTUP_INTEGRITY — 재시작 직후 대상 DB 정합성 확인
    // 진입 조건: TAG 테이블 + 이전 체크포인트 존재 + integrity.enabled
    // ═══════════════════════════════════════════════════════════

    const doIntegrity = tableType === 'TAG'
      && cpExists
      && (jobConfig.integrity === undefined || jobConfig.integrity.enabled !== false);

    if (doIntegrity) {
      const result = await this._runStartupIntegrity({
        startRid,
        srcTable,
        dstTable,
        tagIdentifier,
        sourceColumns,
        batchSize,
        ridRangeSize,
        retry,
        shutdownFlag,
        logCtx,
        checkpointStore,
      });
      if (result === null) return; // shutdown or error
      startRid = result.startRid;
    }

    // ═══════════════════════════════════════════════════════════
    // STEADY_REPLICATION — 메인 복제 루프
    // ═══════════════════════════════════════════════════════════

    let stmtCount = 0;

    while (!shutdownFlag.value) {
      // Statement ID 한도 체크 — close() 후 open()으로 새 연결 생성
      if (stmtCount >= STMT_REFRESH_THRESHOLD) {
        try {
          await srcTable.close();
          await srcTable.open();
          if (tableType === 'TAG') {
            await srcTable.loadTagAliasCache();
          }
          stmtCount = 0;
          getLogger().debug('worker', { ...logCtx, msg: 'sourceConn refreshed (statement ID threshold)' });
        } catch (refreshErr) {
          getLogger().error('worker', { ...logCtx, msg: `sourceConn refresh failed: ${refreshErr.message}` });
          return;
        }
      }

      // 소스 배치 읽기
      const { rows, err: readErr } = await srcTable.read(startRid, batchSize, ridRangeSize, tagIdentifier, sourceColumns);
      if (readErr) {
        getLogger().error('worker', { ...logCtx, phase: 'STEADY', msg: `read failed: ${readErr.message}` });
        return;
      }

      // read는 MAX(_RID) + SELECT = 2개 쿼리 소비
      stmtCount += 2;

      if (rows.length === 0) {
        // 새 데이터 없음 → poll 대기
        const signal = await retry.sleepOrShutdown(pollIntervalMs, shutdownFlag);
        if (signal === 'shutdown') return;
        continue;
      }

      const maxRidInBatch = maxRid(rows);
      const outRows = rows.map(row => row.data);
      const droppedNoMeta = 0; // drop_not_found 행은 srcTable.read()가 이미 제외

      if (shutdownFlag.value) return;

      if (outRows.length > 0) {
        const ok = await _appendRows(dstTable, outRows, retry, shutdownFlag, logCtx);
        if (!ok) return; // exhausted or shutdown
      }

      const batchStats = {
        rowsRead:      rows.length,
        rowsWritten:   outRows.length,
        droppedNoMeta,
        skippedExists: 0,
      };
      await checkpointStore.save(jobConfig.id, dataTable, {
        lastSuccessRid: maxRidInBatch,
        sourceServer:   jobConfig.source.server,
        sourceTable:    jobConfig.source.table,
      }, batchStats, { onSaveFailure: jobConfig.onSaveFailure });

      startRid = maxRidInBatch + 1n;
    }
    return;
  }

  /**
   * STARTUP_INTEGRITY 단계 실행
   *
   * @returns {{ startRid: BigInt }|null}  null = shutdown or error (caller must return)
   */
  async _runStartupIntegrity({
    startRid,
    srcTable,
    dstTable,
    tagIdentifier,
    sourceColumns,
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
      // @machbase/ts-client는 쿼리마다 statement ID를 소비하고 서버는 1024개 한도를 가짐.
      // MachbaseFacadeConnection.end() 후 재연결 불가 — 배치마다 신규 접속을 생성한다.
      const intConn = new MachbaseClient(dstConfig);
      // 'continue' | 'break' | 'return'
      let outcome = 'continue';

      try {
        await intConn.connect();

        // 소스 배치 읽기 (drop_not_found 행은 srcTable.read()가 이미 제외)
        const { rows, err: readErr } = await srcTable.read(integrityRid, integrityBatchSize, ridRangeSize, tagIdentifier, sourceColumns);
        if (readErr) {
          getLogger().error('worker', { ...logCtx, phase: 'STARTUP_INTEGRITY', msg: `read failed: ${readErr.message}` });
          outcome = 'return'; break;
        }

        if (rows.length === 0) {
          // 소스의 모든 데이터가 대상에 존재함 → STEADY 진입
          startRid = integrityRid;
          getLogger().debug('worker', { ...logCtx, toRid: String(integrityRid), msg: 'integrity check: all rows confirmed' });
          outcome = 'break'; break;
        }

        const maxRidInBatch = maxRid(rows);

        // 1단계: 배치 내 모든 row의 resolved 목록 구성 (read()가 이미 drop 제외)
        const resolved = rows.map(row => ({ rid: row.rid, canonical: row.data.NAME, time: row.data.TIME }));

        if (shutdownFlag.value) { outcome = 'return'; break; }

        // 2단계: VOLATILE TABLE + JOIN으로 첫 번째 miss row 탐색
        const { firstMissIdx, err: batchErr } = resolved.length === 0
          ? { firstMissIdx: null, err: null }
          : await dstTable.findFirstMissRow(resolved, intConn, dataTable);

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
          await checkpointStore.save(jobConfig.id, dataTable, {
            lastSuccessRid: safeCpRid,
            sourceServer:   jobConfig.source.server,
            sourceTable:    jobConfig.source.table,
          }, batchStats, { onSaveFailure: jobConfig.onSaveFailure });
          startRid = firstMissRid;
          getLogger().info('worker', { ...logCtx, firstMissRid: String(firstMissRid), safeCpRid: String(safeCpRid), msg: 'integrity check: first missing row found' });
          outcome = 'break'; break;
        }

        // 배치 내 모든 row가 존재 → 다음 배치로 진행
        await checkpointStore.save(jobConfig.id, dataTable, {
          lastSuccessRid: maxRidInBatch,
          sourceServer:   jobConfig.source.server,
          sourceTable:    jobConfig.source.table,
        }, batchStats, { onSaveFailure: jobConfig.onSaveFailure });
        integrityRid = maxRidInBatch + 1n;
        getLogger().debug('worker', { ...logCtx, nextRid: String(integrityRid), msg: 'integrity check: batch confirmed' });
      } finally {
        await intConn.close().catch(() => {});
      }

      if (outcome === 'return') return null;
      if (outcome === 'break')  break;
      // outcome === 'continue' → 루프 계속
    }

    if (shutdownFlag.value) return null;
    return { startRid };
  }
}

module.exports = { Worker };
