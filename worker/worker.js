'use strict';

const CheckpointStore = require('../file/checkpoint.js');
const SourceReader = require('../machbase/source_reader.js');
const TagMetaProvider = require('../machbase/tag_meta_provider.js');
const IntegrityChecker = require('../machbase/integrity_checker.js');
const RetryHandler = require('./retry.js');
const { MachbaseClient } = require('../machbase/machbase.js');

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

/**
 * SourceReader.readAfterRid 를 retry 포함하여 호출
 * @returns {Array|null} rows on success, null on shutdown/exhausted (caller must return)
 */
async function _readBatch(conn, dataTable, startRid, limit, retry, shutdownFlag, logCtx, phase) {
  let attempt = 0;
  while (true) {
    if (shutdownFlag.value) return null;
    if (attempt > 0) {
      if (retry.isExhausted(attempt)) {
        console.error(JSON.stringify({ level: 'error', stage: 'worker', ...logCtx, phase, msg: 'read retry exhausted, skipping mapping' }));
        return null;
      }
      const delay = retry.nextDelay(attempt - 1);
      console.warn(JSON.stringify({ level: 'warn', stage: 'worker', ...logCtx, phase, attempt, msg: `read retry, delay=${delay}ms` }));
      const signal = await retry.sleepOrShutdown(delay, shutdownFlag);
      if (signal === 'shutdown') return null;
    }
    const { rows, err } = await SourceReader.readAfterRid(conn, dataTable, startRid, limit);
    if (err) {
      if (!retry.shouldRetry(err)) {
        console.error(JSON.stringify({ level: 'error', stage: 'worker', ...logCtx, phase, msg: `non-retryable read error: ${err.message}` }));
        return null;
      }
      attempt++;
      continue;
    }
    return rows;
  }
}

/**
 * TagMetaProvider.resolveTagCanonical 을 retry 포함하여 호출 (retry scope B 지원)
 * @returns {string}    ok — canonical tag name
 * @returns {null}      drop_not_found — 이 row를 drop
 * @returns {undefined} shutdown 또는 retry exhausted — caller must return
 */
async function _resolveCanonical(tagMeta, conn, tagId, tagIdentifier, retry, shutdownFlag, logCtx) {
  let attempt = 0;
  while (true) {
    if (shutdownFlag.value) return undefined;
    if (attempt > 0) {
      if (retry.isExhausted(attempt)) {
        console.error(JSON.stringify({ level: 'error', stage: 'worker', ...logCtx, msg: 'resolve canonical retry exhausted, skipping mapping' }));
        return undefined;
      }
      const delay = retry.nextDelay(attempt - 1);
      const signal = await retry.sleepOrShutdown(delay, shutdownFlag);
      if (signal === 'shutdown') return undefined;
    }
    const { canonical, status } = await tagMeta.resolveTagCanonical(conn, tagId, tagIdentifier);
    if (status === 'drop_not_found') return null;
    if (status === 'retry_error') { attempt++; continue; }
    return canonical; // 'ok'
  }
}

/**
 * IntegrityChecker.existsByTagAndTime 을 retry 포함하여 호출
 * @returns {boolean}   true/false on success
 * @returns {undefined} shutdown 또는 retry exhausted — caller must return
 */
async function _checkExists(conn, table, canonical, timeNs, retry, shutdownFlag, logCtx) {
  let attempt = 0;
  while (true) {
    if (shutdownFlag.value) return undefined;
    if (attempt > 0) {
      if (retry.isExhausted(attempt)) {
        console.error(JSON.stringify({ level: 'error', stage: 'worker', ...logCtx, msg: 'integrity check retry exhausted, skipping mapping' }));
        return undefined;
      }
      const delay = retry.nextDelay(attempt - 1);
      const signal = await retry.sleepOrShutdown(delay, shutdownFlag);
      if (signal === 'shutdown') return undefined;
    }
    const { exists, err } = await IntegrityChecker.existsByTagAndTime(conn, table, canonical, timeNs);
    if (err) {
      if (!retry.shouldRetry(err)) {
        console.error(JSON.stringify({ level: 'error', stage: 'worker', ...logCtx, msg: `integrity check non-retryable: ${err.message}` }));
        return undefined;
      }
      attempt++;
      continue;
    }
    return exists;
  }
}

/**
 * TargetWriter.append 을 retry 포함하여 호출
 * @returns {boolean} true on success, false on exhausted/shutdown
 */
async function _appendRows(targetWriter, outRows, retry, shutdownFlag, logCtx) {
  let attempt = 0;
  while (true) {
    if (shutdownFlag.value) return false;
    if (attempt > 0) {
      if (retry.isExhausted(attempt)) {
        console.error(JSON.stringify({ level: 'error', stage: 'worker', ...logCtx, msg: 'append retry exhausted, skipping mapping' }));
        return false;
      }
      const delay = retry.nextDelay(attempt - 1);
      console.warn(JSON.stringify({ level: 'warn', stage: 'worker', ...logCtx, attempt, msg: `append retry, delay=${delay}ms` }));
      const signal = await retry.sleepOrShutdown(delay, shutdownFlag);
      if (signal === 'shutdown') return false;
    }
    const err = await targetWriter.append(outRows);
    if (err) {
      if (!retry.shouldRetry(err)) {
        console.error(JSON.stringify({ level: 'error', stage: 'worker', ...logCtx, msg: `non-retryable append error: ${err.message}` }));
        return false;
      }
      attempt++;
      continue;
    }
    return true;
  }
}

// ─── 메인 Worker 함수 ─────────────────────────────────────────────────────────

/**
 * data_table 단위 복제 Worker — 상태 머신
 *
 * 상태 전이:
 *   RESOLVE_START → [STARTUP_INTEGRITY] → STEADY_REPLICATION
 *
 * STARTUP_INTEGRITY 진입 조건: TAG 테이블 + 체크포인트 존재 + integrity.enabled !== false
 *
 * @param {object}   params
 * @param {string}   params.jobId          - 잡 식별자
 * @param {object}   params.mapping        - 처리된 매핑 설정 (source, target, execution)
 * @param {object}   params.checkpoint     - { directory } 체크포인트 디렉토리
 * @param {string}   params.tableType      - 'TAG' | 'LOG'
 * @param {string}   params.dataTable      - '_TAG_DATA_0' 등 파티션 테이블명
 * @param {object}   params.sourceConn     - MachbaseClient (소스 DB)
 * @param {object}   params.targetConn     - MachbaseClient (대상 DB — STARTUP_INTEGRITY 전용)
 * @param {object}   params.targetWriter   - TargetWriter (mapping 레벨 공유 stream)
 * @param {{ value: boolean }} params.shutdownFlag
 */
async function runDataTableWorker({
  jobId,
  mapping,
  checkpoint,
  tableType,
  dataTable,
  sourceConn,
  targetConn,
  dstConfig,
  targetWriter,
  shutdownFlag,
}) {
  const exec = mapping.execution;
  const batchSize = exec.batch_size_records || 5000;
  const pollIntervalMs = exec.poll_interval_ms || 1000;
  const tagIdentifier = mapping.source.tag_identifier || { mode: 'none', value: '' };
  const retry = new RetryHandler(exec.retry || {});
  const checkpointStore = new CheckpointStore(checkpoint.directory);
  const logCtx = { job_id: jobId, data_table: dataTable };

  // ═══════════════════════════════════════════════════════════
  // RESOLVE_START — 시작 RID 결정
  // ═══════════════════════════════════════════════════════════

  const { cp, exists: cpExists } = await checkpointStore.load(jobId, dataTable);
  let startRid;

  if (cpExists && cp) {
    // 체크포인트 존재 → start_mode 무시, 체크포인트 기준으로 재개
    startRid = cp.last_success_rid;
    console.log(JSON.stringify({ level: 'info', stage: 'worker', ...logCtx, msg: `resume from checkpoint, start_rid=${startRid}` }));
  } else {
    const startMode = exec.start_mode || 'full';
    if (startMode === 'now') {
      const { maxRid, err } = await SourceReader.getMaxRid(sourceConn, dataTable);
      if (err) {
        console.error(JSON.stringify({ level: 'error', stage: 'worker', ...logCtx, msg: `getMaxRid failed (start_mode=now), skipping mapping: ${err.message}` }));
        return;
      }
      startRid = maxRid;
    } else if (startMode === 'rid_after') {
      startRid = BigInt(exec.rid_after || 0);
    } else {
      startRid = 0n; // 'full'
    }
    console.log(JSON.stringify({ level: 'info', stage: 'worker', ...logCtx, msg: `start_mode=${startMode}, start_rid=${startRid}` }));
  }

  // TAG 메타 전체 로드 (Worker 시작 시 1회 — Read-through cache 기반)
  let tagMeta = null;
  if (tableType === 'TAG') {
    tagMeta = new TagMetaProvider();
    await tagMeta.loadAll(sourceConn, mapping.source.table);
  }

  // ═══════════════════════════════════════════════════════════
  // STARTUP_INTEGRITY — 재시작 직후 대상 DB 정합성 확인
  // 진입 조건: TAG 테이블 + 이전 체크포인트 존재 + integrity.enabled
  // ═══════════════════════════════════════════════════════════

  const doIntegrity = tableType === 'TAG'
    && cpExists
    && (exec.integrity?.enabled !== false);

  if (doIntegrity) {
    console.log(JSON.stringify({ level: 'info', stage: 'worker', ...logCtx, msg: `STARTUP_INTEGRITY start, from_rid=${startRid}` }));
    let integrityRid = startRid;
    // INTEGRITY 배치: batchExists는 단일 쿼리이므로 OR 절 크기를 500으로 제한
    const integrityBatchSize = Math.min(batchSize, 500);

    while (!shutdownFlag.value) {
      // @machbase/ts-client는 쿼리마다 statement ID를 소비하고 서버는 1024개 한도를 가짐.
      // MachbaseFacadeConnection.end() 후 재연결 불가 — 배치마다 신규 접속을 생성한다.
      const intConn = new MachbaseClient(dstConfig);
      await intConn.connect();

      // 소스 배치 읽기
      const rows = await _readBatch(sourceConn, dataTable, integrityRid, integrityBatchSize, retry, shutdownFlag, logCtx, 'STARTUP_INTEGRITY');
      if (rows === null) { await intConn.close().catch(() => {}); return; } // exhausted or shutdown

      if (rows.length === 0) {
        // 소스의 모든 데이터가 대상에 존재함 → STEADY 진입
        startRid = integrityRid;
        await intConn.close().catch(() => {});
        console.log(JSON.stringify({ level: 'info', stage: 'worker', ...logCtx, msg: 'STARTUP_INTEGRITY: all rows confirmed, entering STEADY' }));
        break;
      }

      const maxRidInBatch = rows.reduce((m, r) => r.rid > m ? r.rid : m, 0n);
      let droppedNoMeta = 0;

      // 1단계: 배치 내 모든 row의 canonical 이름 해석
      const resolved = []; // { rid, canonical, time }
      for (const row of rows) {
        if (shutdownFlag.value) { await intConn.close().catch(() => {}); return; }
        const canonical = await _resolveCanonical(tagMeta, sourceConn, row.tagId, tagIdentifier, retry, shutdownFlag, logCtx);
        if (canonical === undefined) { await intConn.close().catch(() => {}); return; }
        if (canonical === null) { droppedNoMeta++; continue; }
        resolved.push({ rid: row.rid, canonical, time: row.time });
      }
      if (shutdownFlag.value) { await intConn.close().catch(() => {}); return; }

      // 2단계: 배치 일괄 EXISTS 확인 (statement 1회 소비)
      const { existSet, err: batchErr } = await IntegrityChecker.batchExists(intConn, mapping.target.table, resolved);
      await intConn.close().catch(() => {});
      if (batchErr) {
        console.error(JSON.stringify({ level: 'error', stage: 'worker', ...logCtx, msg: `batchExists failed: ${batchErr.message}` }));
        return;
      }
      if (shutdownFlag.value) return;

      // 3단계: 첫 번째 miss row 탐색 (rid 순서 유지)
      let firstMissRid = null;
      let skippedExists = 0;
      for (const r of resolved) {
        const key = IntegrityChecker.existKey(r.canonical, r.time);
        if (!existSet.has(key)) {
          firstMissRid = r.rid;
          break;
        }
        skippedExists++;
      }
      if (shutdownFlag.value) return;

      const batchStats = {
        rows_read: rows.length,
        rows_written: 0,
        dropped_no_meta: droppedNoMeta,
        skipped_exists: skippedExists,
      };

      if (firstMissRid !== null) {
        // 최초 miss row 발견 → safe checkpoint 저장 후 STEADY 진입
        const safeCpRid = firstMissRid - 1n;
        await checkpointStore.save(jobId, dataTable, {
          last_success_rid: safeCpRid,
          source_server: mapping.source.server,
          source_table: mapping.source.table,
        }, batchStats);
        startRid = firstMissRid; // STEADY는 첫 번째 miss row부터 복제
        console.log(JSON.stringify({
          level: 'info', stage: 'worker', ...logCtx,
          msg: `STARTUP_INTEGRITY: first_miss_rid=${firstMissRid}, safe_cp_rid=${safeCpRid}, entering STEADY`,
        }));
        break;
      }

      // 배치 내 모든 row가 존재하거나 drop → 다음 배치로 진행
      await checkpointStore.save(jobId, dataTable, {
        last_success_rid: maxRidInBatch + 1n,
        source_server: mapping.source.server,
        source_table: mapping.source.table,
      }, batchStats);
      integrityRid = maxRidInBatch + 1n;
      console.log(JSON.stringify({ level: 'info', stage: 'worker', ...logCtx, msg: `STARTUP_INTEGRITY: batch all confirmed, next_rid=${integrityRid}` }));
    }

    if (shutdownFlag.value) return;
  }

  // ═══════════════════════════════════════════════════════════
  // STEADY_REPLICATION — 메인 복제 루프
  // ═══════════════════════════════════════════════════════════

  console.log(JSON.stringify({ level: 'info', stage: 'worker', ...logCtx, msg: `STEADY_REPLICATION start, start_rid=${startRid}` }));

  while (!shutdownFlag.value) {
    // 소스 배치 읽기
    const rows = await _readBatch(sourceConn, dataTable, startRid, batchSize, retry, shutdownFlag, logCtx, 'STEADY');
    if (rows === null) return; // exhausted or shutdown

    if (rows.length === 0) {
      // 새 데이터 없음 → poll 대기
      const signal = await retry.sleepOrShutdown(pollIntervalMs, shutdownFlag);
      if (signal === 'shutdown') return;
      continue;
    }

    const maxRidInBatch = rows.reduce((m, r) => r.rid > m ? r.rid : m, 0n);
    const outRows = [];
    const outRids = [];
    let droppedNoMeta = 0;

    // 각 row 처리 (retry scope B: 실패한 row부터 retry, 이전 row는 skip)
    for (const row of rows) {
      if (shutdownFlag.value) return;

      if (tableType === 'TAG') {
        // tag_id → canonical 이름 변환
        const canonical = await _resolveCanonical(tagMeta, sourceConn, row.tagId, tagIdentifier, retry, shutdownFlag, logCtx);
        if (canonical === undefined) return; // shutdown or exhausted
        if (canonical === null) { droppedNoMeta++; continue; } // drop_not_found

        outRows.push({ NAME: canonical, TIME: row.time, VALUE: row.value });
      } else {
        // LOG: tag_id 변환 없이 그대로
        outRows.push({ NAME: row.tagId, TIME: row.time, VALUE: row.value });
      }
      outRids.push(row.rid);
    }

    if (shutdownFlag.value) return;

    let maxWrittenRid = 0n;

    if (outRows.length > 0) {
      const ok = await _appendRows(targetWriter, outRows, retry, shutdownFlag, logCtx);
      if (!ok) return; // exhausted or shutdown
      maxWrittenRid = outRids.reduce((m, r) => r > m ? r : m, 0n);
    }

    // checkpoint 갱신
    // effective_max: 실제로 쓴 row가 있으면 그 최대 rid, 없으면 배치 최대 rid
    const effectiveMax = maxWrittenRid > 0n ? maxWrittenRid : maxRidInBatch;
    const nextRid = effectiveMax + 1n;

    const batchStats = {
      rows_read: rows.length,
      rows_written: outRows.length,
      dropped_no_meta: droppedNoMeta,
      skipped_exists: 0,
    };
    await checkpointStore.save(jobId, dataTable, {
      last_success_rid: nextRid,
      source_server: mapping.source.server,
      source_table: mapping.source.table,
    }, batchStats);

    startRid = nextRid;
  }
}

module.exports = { runDataTableWorker };
