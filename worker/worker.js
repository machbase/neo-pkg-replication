'use strict';

const CheckpointStore = require('../checkpoint/store.js');
const RetryHandler = require('../core/retry.js');
const { MachbaseClient } = require('../db/client.js');
const { TagDataTable, TagTable, LogTable } = require('../db/table.js');
const { getInstance: getLogger } = require('../logger/logger.js');

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
 * Writer.append 을 retry 포함하여 호출
 * @returns {boolean} true on success, false on exhausted/shutdown
 */
async function _appendRows(writer, outRows, retry, shutdownFlag, logCtx) {
  const result = await _withRetry({
    fn: async () => {
      const err = await writer.append(outRows);
      if (err) return { done: false, retryable: retry.shouldRetry(err), msg: `non-retryable append error: ${err.message}` };
      return { done: true, value: true };
    },
    retry,
    shutdownFlag,
    logCtx,
    exhaustedMsg: 'append retry exhausted, skipping mapping',
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
  constructor(jobId, jobCheckpoint, mapping, tableType, dataTable,
              srcSchema, dstSchema, srcConfig, dstConfig, shutdownFlag) {
    this.jobId = jobId;
    this.jobCheckpoint = jobCheckpoint;
    this.mapping = mapping;
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
    const { jobId, mapping, tableType, dataTable,
            srcSchema, dstSchema, srcConfig, dstConfig, shutdownFlag } = this;
    const logCtx = {
      job_id: jobId,
      mapping_id: mapping.mapping_id,
      data_table: dataTable,
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
      dstTable = new TagTable(mapping.target.table, dstConfig);
      dstTable.setSchema(dstSchema);
    } else {
      srcTable = new LogTable(dataTable, srcConfig);
      srcTable.setSchema(srcSchema);
      dstTable = new LogTable(mapping.target.table, dstConfig);
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
    const { jobId, mapping, tableType, dataTable } = this;
    const exec = mapping.execution;
    const batchSize = exec.query_limit || 5000;
    const ridRangeSize = exec.rid_range_size || 50000;
    const pollIntervalMs = exec.poll_interval_ms || 1000;
    const sourceColumns = mapping.source.columns || null;
    const tagIdentifier = mapping.source.tag_identifier || { mode: 'none', value: '' };
    const retry = new RetryHandler(exec.retry || {});
    const checkpointStore = new CheckpointStore(this.jobCheckpoint.directory);
    const logCtx = { job_id: jobId, data_table: dataTable };

    // ═══════════════════════════════════════════════════════════
    // RESOLVE_START — 시작 RID 결정
    // ═══════════════════════════════════════════════════════════

    const { cp, exists: cpExists } = await checkpointStore.load(jobId, dataTable);
    let startRid;

    if (cpExists && cp) {
      startRid = cp.last_success_rid + 1n;
      getLogger().info('worker', { ...logCtx, msg: `resume from checkpoint, start_rid=${startRid}` });
    } else {
      const startMode = exec.start_mode || 'full';
      if (startMode === 'now') {
        try {
          const maxRidVal = await srcTable.getMaxRid();
          startRid = maxRidVal + 1n;
        } catch (err) {
          getLogger().error('worker', { ...logCtx, msg: `getMaxRid failed (start_mode=now), skipping mapping: ${err.message}` });
          return;
        }
      } else if (startMode === 'rid_after') {
        startRid = BigInt(exec.rid_after || 0);
      } else {
        startRid = 0n; // 'full'
      }
      getLogger().info('worker', { ...logCtx, msg: `start_mode=${startMode}, start_rid=${startRid}` });
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
      && (exec.integrity?.enabled !== false);

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

    getLogger().info('worker', { ...logCtx, msg: `STEADY_REPLICATION start, start_rid=${startRid}` });

    let stmtCount = 0;

    while (!shutdownFlag.value) {
      // Statement ID 한도 체크
      if (stmtCount >= STMT_REFRESH_THRESHOLD) {
        try {
          await srcTable.close();
          await srcTable.open();
          stmtCount = 0;
          getLogger().info('worker', { ...logCtx, msg: 'sourceConn refreshed (statement ID threshold)' });
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
        rows_read: rows.length,
        rows_written: outRows.length,
        dropped_no_meta: droppedNoMeta,
        skipped_exists: 0,
      };
      await checkpointStore.save(jobId, dataTable, {
        last_success_rid: maxRidInBatch,
        source_server: mapping.source.server,
        source_table: mapping.source.table,
      }, batchStats, { on_save_failure: exec.on_save_failure });

      startRid = maxRidInBatch + 1n;
    }
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
    const { jobId, mapping, dataTable, dstConfig } = this;

    getLogger().info('worker', { ...logCtx, msg: `STARTUP_INTEGRITY start, from_rid=${startRid}` });
    let integrityRid = startRid;
    const integrityBatchSize = Math.min(batchSize, INTEGRITY_BATCH_LIMIT);

    while (!shutdownFlag.value) {
      // @machbase/ts-client는 쿼리마다 statement ID를 소비하고 서버는 1024개 한도를 가짐.
      // MachbaseFacadeConnection.end() 후 재연결 불가 — 배치마다 신규 접속을 생성한다.
      const intConn = new MachbaseClient(dstConfig);
      let shouldReturn = false;

      try {
        await intConn.connect();

        // 소스 배치 읽기 (drop_not_found 행은 srcTable.read()가 이미 제외)
        const { rows, err: readErr } = await srcTable.read(integrityRid, integrityBatchSize, ridRangeSize, tagIdentifier, sourceColumns);
        if (readErr) {
          getLogger().error('worker', { ...logCtx, phase: 'STARTUP_INTEGRITY', msg: `read failed: ${readErr.message}` });
          shouldReturn = true;
          break;
        }

        if (rows.length === 0) {
          // 소스의 모든 데이터가 대상에 존재함 → STEADY 진입
          startRid = integrityRid;
          getLogger().info('worker', { ...logCtx, msg: 'STARTUP_INTEGRITY: all rows confirmed, entering STEADY' });
          break;
        }

        const maxRidInBatch = maxRid(rows);

        // 1단계: 배치 내 모든 row의 resolved 목록 구성 (read()가 이미 drop 제외)
        const resolved = rows.map(row => ({ rid: row.rid, canonical: row.data.NAME, time: row.data.TIME }));

        if (shutdownFlag.value) { shouldReturn = true; break; }

        // 2단계: VOLATILE TABLE + JOIN으로 첫 번째 miss row 탐색
        const { firstMissIdx, err: batchErr } = resolved.length === 0
          ? { firstMissIdx: null, err: null }
          : await dstTable.findFirstMissRow(resolved, intConn);

        if (batchErr) {
          getLogger().error('worker', { ...logCtx, msg: `findFirstMissRow failed: ${batchErr.message}` });
          shouldReturn = true;
          break;
        }
        if (shutdownFlag.value) { shouldReturn = true; break; }

        let firstMissRid = null;
        let skippedExists = 0;
        if (firstMissIdx !== null) {
          firstMissRid = resolved[firstMissIdx].rid;
          skippedExists = firstMissIdx;
        } else {
          skippedExists = resolved.length;
        }
        if (shutdownFlag.value) { shouldReturn = true; break; }

        const batchStats = {
          rows_read: rows.length,
          rows_written: 0,
          dropped_no_meta: 0,
          skipped_exists: skippedExists,
        };

        if (firstMissRid !== null) {
          const safeCpRid = firstMissRid > 0n ? firstMissRid - 1n : 0n;
          await checkpointStore.save(jobId, dataTable, {
            last_success_rid: safeCpRid,
            source_server: mapping.source.server,
            source_table: mapping.source.table,
          }, batchStats, { on_save_failure: mapping.execution.on_save_failure });
          startRid = firstMissRid;
          getLogger().info('worker', {
            ...logCtx,
            msg: `STARTUP_INTEGRITY: first_miss_rid=${firstMissRid}, safe_cp_rid=${safeCpRid}, entering STEADY`
          });
          break;
        }

        // 배치 내 모든 row가 존재 → 다음 배치로 진행
        await checkpointStore.save(jobId, dataTable, {
          last_success_rid: maxRidInBatch,
          source_server: mapping.source.server,
          source_table: mapping.source.table,
        }, batchStats, { on_save_failure: mapping.execution.on_save_failure });
        integrityRid = maxRidInBatch + 1n;
        getLogger().info('worker', { ...logCtx, msg: `STARTUP_INTEGRITY: batch all confirmed, next_rid=${integrityRid}` });
      } finally {
        await intConn.close().catch(() => {});
      }

      if (shouldReturn) return null;
    }

    if (shutdownFlag.value) return null;
    return { startRid };
  }
}

module.exports = { Worker };
