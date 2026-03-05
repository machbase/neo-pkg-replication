'use strict';

const CheckpointStore = require('../file/checkpoint.js');
const IntegrityChecker = require('../machbase/integrity_checker.js');
const RetryHandler = require('./retry.js');
const { MachbaseClient } = require('../machbase/machbase.js');
const { Reader, TagAliasCache } = require('../machbase/reader.js');
const { Writer } = require('../machbase/writer.js');
const { getInstance: getLogger } = require('../logger/logger.js');

// ─── 상수 ────────────────────────────────────────────────────────────────────

// Statement ID 고갈 방지 임계값: ts-client는 쿼리마다 statement ID를 소비하고
// 서버 한도는 1024. readAfterRid는 배치당 2개 쿼리(MAX + SELECT)를 사용하므로
// 이 임계값에 도달하면 연결을 재생성한다.
const STMT_REFRESH_THRESHOLD = 900;

// STARTUP_INTEGRITY 배치 크기 상한: batchExists는 OR 절로 존재 확인하므로
// SQL 크기 제한을 위해 500으로 제한한다.
const INTEGRITY_BATCH_LIMIT = 500;

// ─── Row 처리 전략 클래스 ──────────────────────────────────────────────────────

/**
 * TAG 테이블용 row 처리기
 * tag_id → canonical 이름 변환 후 append 준비
 */
class TagRowProcessor {
  constructor(tagIdentifier) {
    this.tagIdentifier = tagIdentifier;
  }

  /**
   * @returns {{ action: 'append'|'drop'|'shutdown', outRow?: object }}
   */
  async process(row, aliasCache, client, retry, shutdownFlag, logCtx) {
    const canonical = await _resolveCanonical(aliasCache, client, row.tagId, this.tagIdentifier, retry, shutdownFlag, logCtx);
    if (canonical === undefined) return { action: 'shutdown' };
    if (canonical === null) return { action: 'drop' };

    // canonical name으로 NAME을 덮어씀 (tag_id → canonical 변환)
    return { action: 'append', outRow: { ...row.data, NAME: canonical } };
  }
}

/**
 * LOG 테이블용 row 처리기
 * tag_id 변환 없이 그대로 사용
 */
class LogRowProcessor {
  async process(row) {
    return { action: 'append', outRow: row.data };
  }
}

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

/**
 * reader.readAfterRid 를 retry 포함하여 호출
 * @returns {Array|null} rows on success, null on shutdown/exhausted (caller must return)
 */
async function _readBatch(reader, startRid, limit, rangeSize, retry, shutdownFlag, logCtx, phase) {
  let attempt = 0;
  while (true) {
    if (shutdownFlag.value) return null;
    if (attempt > 0) {
      if (retry.isExhausted(attempt)) {
        getLogger().error('worker', { ...logCtx, phase, msg: 'read retry exhausted, skipping mapping' });
        return null;
      }
      const delay = retry.nextDelay(attempt - 1);
      getLogger().warn('worker', { ...logCtx, phase, attempt, msg: `read retry, delay=${delay}ms` });
      const signal = await retry.sleepOrShutdown(delay, shutdownFlag);
      if (signal === 'shutdown') return null;
    }
    const { rows, err } = await reader.readAfterRid(startRid, limit, rangeSize);
    if (err) {
      if (!retry.shouldRetry(err)) {
        getLogger().error('worker', { ...logCtx, phase, msg: `non-retryable read error: ${err.message}` });
        return null;
      }
      attempt++;
      continue;
    }
    return rows;
  }
}

/**
 * aliasCache.resolve 를 retry 포함하여 호출 (retry scope B 지원)
 * @returns {string}    ok — canonical tag name
 * @returns {null}      drop_not_found — 이 row를 drop
 * @returns {undefined} shutdown 또는 retry exhausted — caller must return
 */
async function _resolveCanonical(aliasCache, client, tagId, tagIdentifier, retry, shutdownFlag, logCtx) {
  let attempt = 0;
  while (true) {
    if (shutdownFlag.value) return undefined;
    if (attempt > 0) {
      if (retry.isExhausted(attempt)) {
        getLogger().error('worker', { ...logCtx, msg: 'resolve canonical retry exhausted, skipping mapping' });
        return undefined;
      }
      const delay = retry.nextDelay(attempt - 1);
      const signal = await retry.sleepOrShutdown(delay, shutdownFlag);
      if (signal === 'shutdown') return undefined;
    }
    const { canonical, status } = await aliasCache.resolve(client, tagId, tagIdentifier);
    if (status === 'drop_not_found') return null;
    if (status === 'retry_error') { attempt++; continue; }
    return canonical; // 'ok'
  }
}

/**
 * Writer.append 을 retry 포함하여 호출
 * @returns {boolean} true on success, false on exhausted/shutdown
 */
async function _appendRows(writer, outRows, retry, shutdownFlag, logCtx) {
  let attempt = 0;
  while (true) {
    if (shutdownFlag.value) return false;
    if (attempt > 0) {
      if (retry.isExhausted(attempt)) {
        getLogger().error('worker', { ...logCtx, msg: 'append retry exhausted, skipping mapping' });
        return false;
      }
      const delay = retry.nextDelay(attempt - 1);
      getLogger().warn('worker', { ...logCtx, attempt, msg: `append retry, delay=${delay}ms` });
      const signal = await retry.sleepOrShutdown(delay, shutdownFlag);
      if (signal === 'shutdown') return false;
    }
    const err = await writer.append(outRows);
    if (err) {
      if (!retry.shouldRetry(err)) {
        getLogger().error('worker', { ...logCtx, msg: `non-retryable append error: ${err.message}` });
        return false;
      }
      attempt++;
      continue;
    }
    return true;
  }
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
    const { jobId, jobCheckpoint, mapping, tableType, dataTable,
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

    const tagIdentifier = mapping.source.tag_identifier || { mode: 'none', value: '' };
    const rowProcessor = tableType === 'TAG'
      ? new TagRowProcessor(tagIdentifier)
      : new LogRowProcessor();

    const aliasCache = tableType === 'TAG' ? new TagAliasCache(mapping.source.table) : null;

    const wSrcConn = new MachbaseClient(srcConfig);
    const wDstConn = new MachbaseClient(dstConfig);
    const reader = new Reader(srcSchema, wSrcConn, dataTable, mapping.source.columns);
    const writer = new Writer(dstSchema);

    try {
      await wSrcConn.connect();
      await wDstConn.connect();

      const openErr = await writer.open(wDstConn, mapping.target.table, srcSchema);
      if (openErr) {
        getLogger().error('worker', { ...logCtx, msg: `Writer.open failed: ${openErr.message}` });
        await wDstConn.close().catch(() => {});
        await wSrcConn.close().catch(() => {});
        return;
      }

      // open() 성공 시 dstConn 소유권은 Writer로 이전
      await this._runStateMachine({
        reader,
        aliasCache,
        writer,
        rowProcessor,
        shutdownFlag: effectiveShutdownFlag,
      });
    } finally {
      await writer.close().catch(err =>
        getLogger().error('worker', { ...logCtx, msg: `writer.close failed: ${err.message}` })
      );
      await reader.close().catch(err =>
        getLogger().error('worker', { ...logCtx, msg: `reader.close failed: ${err.message}` })
      );
    }
  }

  /**
   * 상태 머신: RESOLVE_START → [STARTUP_INTEGRITY] → STEADY_REPLICATION
   */
  async _runStateMachine({ reader, aliasCache, writer, rowProcessor, shutdownFlag }) {
    const { jobId, jobCheckpoint, mapping, tableType, dataTable, srcConfig, dstConfig } = this;
    const exec = mapping.execution;
    const batchSize = exec.query_limit || 5000;
    const ridRangeSize = exec.rid_range_size || 50000;
    const pollIntervalMs = exec.poll_interval_ms || 1000;
    const retry = new RetryHandler(exec.retry || {});
    const checkpointStore = new CheckpointStore(jobCheckpoint.directory);
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
        const { maxRid, err } = await reader.getMaxRid();
        if (err) {
          getLogger().error('worker', { ...logCtx, msg: `getMaxRid failed (start_mode=now), skipping mapping: ${err.message}` });
          return;
        }
        startRid = maxRid + 1n;
      } else if (startMode === 'rid_after') {
        startRid = BigInt(exec.rid_after || 0);
      } else {
        startRid = 0n; // 'full'
      }
      getLogger().info('worker', { ...logCtx, msg: `start_mode=${startMode}, start_rid=${startRid}` });
    }

    // TAG alias map 로드
    if (aliasCache && aliasCache.size === 0) {
      const loadErr = await aliasCache.load(reader.client);
      if (loadErr) {
        getLogger().warn('worker', { ...logCtx, msg: `aliasCache.load failed, falling back to per-row DB lookup: ${loadErr.message}` });
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
        reader,
        aliasCache,
        rowProcessor,
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
      // Statement ID 한도 체크 — srcConfig가 있을 때만 재생성 가능
      if (srcConfig && stmtCount >= STMT_REFRESH_THRESHOLD) {
        try {
          await reader.refreshConnection(srcConfig);
          stmtCount = 0;
          getLogger().info('worker', { ...logCtx, msg: 'sourceConn refreshed (statement ID threshold)' });
        } catch (refreshErr) {
          getLogger().error('worker', { ...logCtx, msg: `sourceConn refresh failed: ${refreshErr.message}` });
          return;
        }
      }

      // 소스 배치 읽기
      const rows = await _readBatch(reader, startRid, batchSize, ridRangeSize, retry, shutdownFlag, logCtx, 'STEADY');
      if (rows === null) return; // exhausted or shutdown

      // readAfterRid는 MAX(_RID) + SELECT = 2개 쿼리 소비
      stmtCount += 2;

      if (rows.length === 0) {
        // 새 데이터 없음 → poll 대기
        const signal = await retry.sleepOrShutdown(pollIntervalMs, shutdownFlag);
        if (signal === 'shutdown') return;
        continue;
      }

      const maxRidInBatch = rows.reduce((maxAcc, row) => row.rid > maxAcc ? row.rid : maxAcc, 0n);
      const outRows = [];
      const outRids = [];
      let droppedNoMeta = 0;

      // 각 row 처리
      for (const row of rows) {
        if (shutdownFlag.value) return;

        const result = await rowProcessor.process(row, aliasCache, reader.client, retry, shutdownFlag, logCtx);
        if (result.action === 'shutdown') return;
        if (result.action === 'drop') { droppedNoMeta++; continue; }
        outRows.push(result.outRow);
        outRids.push(row.rid);
      }

      if (shutdownFlag.value) return;

      let maxWrittenRid = 0n;

      if (outRows.length > 0) {
        const ok = await _appendRows(writer, outRows, retry, shutdownFlag, logCtx);
        if (!ok) return; // exhausted or shutdown
        maxWrittenRid = outRids.reduce((maxAcc, rid) => rid > maxAcc ? rid : maxAcc, 0n);
      }

      // checkpoint 갱신
      const effectiveMax = maxWrittenRid > 0n ? maxWrittenRid : maxRidInBatch;

      const batchStats = {
        rows_read: rows.length,
        rows_written: outRows.length,
        dropped_no_meta: droppedNoMeta,
        skipped_exists: 0,
      };
      await checkpointStore.save(jobId, dataTable, {
        last_success_rid: effectiveMax,
        source_server: mapping.source.server,
        source_table: mapping.source.table,
      }, batchStats, { on_save_failure: exec.on_save_failure });

      startRid = effectiveMax + 1n;
    }
  }

  /**
   * STARTUP_INTEGRITY 단계 실행
   *
   * @returns {{ startRid: BigInt }|null}  null = shutdown or error (caller must return)
   */
  async _runStartupIntegrity({
    startRid,
    reader,
    aliasCache,
    rowProcessor,
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

        // 소스 배치 읽기
        const rows = await _readBatch(reader, integrityRid, integrityBatchSize, ridRangeSize, retry, shutdownFlag, logCtx, 'STARTUP_INTEGRITY');
        if (rows === null) { shouldReturn = true; break; } // exhausted or shutdown

        if (rows.length === 0) {
          // 소스의 모든 데이터가 대상에 존재함 → STEADY 진입
          startRid = integrityRid;
          getLogger().info('worker', { ...logCtx, msg: 'STARTUP_INTEGRITY: all rows confirmed, entering STEADY' });
          break;
        }

        const maxRidInBatch = rows.reduce((maxAcc, row) => row.rid > maxAcc ? row.rid : maxAcc, 0n);
        let droppedNoMeta = 0;

        // 1단계: 배치 내 모든 row의 canonical 이름 해석
        const resolved = []; // { rid, canonical, time }
        for (const row of rows) {
          if (shutdownFlag.value) { shouldReturn = true; break; }
          const result = await rowProcessor.process(row, aliasCache, reader.client, retry, shutdownFlag, logCtx);
          if (result.action === 'shutdown') { shouldReturn = true; break; }
          if (result.action === 'drop') { droppedNoMeta++; continue; }
          resolved.push({ rid: row.rid, canonical: result.outRow.NAME, time: row.data.TIME });
        }
        if (shouldReturn) break;
        if (shutdownFlag.value) { shouldReturn = true; break; }

        // 2단계: 배치 일괄 EXISTS 확인 (statement 1회 소비)
        let existSet;
        if (resolved.length === 0) {
          existSet = new Set();
        } else {
          const { existSet: _existSet, err: batchErr } = await IntegrityChecker.batchExists(intConn, mapping.target.table, resolved);
          if (batchErr) {
            getLogger().error('worker', { ...logCtx, msg: `batchExists failed: ${batchErr.message}` });
            shouldReturn = true;
            break;
          }
          existSet = _existSet;
        }
        if (shutdownFlag.value) { shouldReturn = true; break; }

        // 3단계: 첫 번째 miss row 탐색 (rid 순서 유지)
        let firstMissRid = null;
        let skippedExists = 0;
        for (const row of resolved) {
          const key = IntegrityChecker.existKey(row.canonical, row.time);
          if (!existSet.has(key)) {
            firstMissRid = row.rid;
            break;
          }
          skippedExists++;
        }
        if (shutdownFlag.value) { shouldReturn = true; break; }

        const batchStats = {
          rows_read: rows.length,
          rows_written: 0,
          dropped_no_meta: droppedNoMeta,
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

        // 배치 내 모든 row가 존재하거나 drop → 다음 배치로 진행
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

module.exports = { Worker, TagRowProcessor, LogRowProcessor };
