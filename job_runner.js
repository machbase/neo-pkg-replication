'use strict';

const { MachbaseClient } = require('./machbase/machbase.js');
const { buildTagSchema, buildLogSchema } = require('./machbase/schema_builder.js');
const { Reader, TagAliasCache } = require('./machbase/reader.js');
const { Writer } = require('./machbase/writer.js');
const { runDataTableWorker, TagRowProcessor, LogRowProcessor } = require('./worker/worker.js');

// ─── DISCOVER ─────────────────────────────────────────────────────────────────

/**
 * mapping의 소스/대상 스키마 수집 (단기 커넥션 사용 후 즉시 반납)
 *
 * @returns {{ tableType, dataTables, srcSchema, dstSchema }}|null  null = 실패
 */
async function _discoverMapping(mapping, servers, logCtx) {
  const srcConfig = servers[mapping.source.server];
  const dstConfig = servers[mapping.target.server];

  let sourceConn;
  try {
    sourceConn = new MachbaseClient(srcConfig);
    await sourceConn.connect();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `source connect failed: ${err.message}` }));
    return null;
  }

  let tableType;
  let dataTables;
  let srcSchema;
  let dstSchema;

  try {
    const result = await sourceConn.getTableType(mapping.source.table);
    tableType = result.type;

    if (tableType === 'UNSUPPORTED') {
      console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `unsupported table type, skipping mapping` }));
      return null;
    }

    if (tableType === 'TAG') {
      const tables = await sourceConn.listTagDataTables(mapping.source.table);
      if (tables.length === 0) {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `no data partitions found, skipping mapping` }));
        return null;
      }
      dataTables = tables.map(t => t.data_table);

      // 소스 TableSchema 생성 (첫 번째 파티션 기준)
      srcSchema = await buildTagSchema(sourceConn, mapping.source.table, tables[0].table_id);

      // source.columns 유효성 검증: columns(NAME+data+metadata) 기준
      if (mapping.source.columns) {
        const actualCols = new Set(srcSchema.columns.map(c => c.name));
        const unknownCols = mapping.source.columns.filter(c => !actualCols.has(c));
        if (unknownCols.length > 0) {
          console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `source.columns contains columns not found in source table: ${unknownCols.join(', ')}, skipping mapping` }));
          return null;
        }
      }

      // 대상 TableSchema 생성
      const tmpDstConn = new MachbaseClient(dstConfig);
      try {
        await tmpDstConn.connect();
        const dstTables = await tmpDstConn.listTagDataTables(mapping.target.table);
        if (dstTables.length === 0) {
          console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `no target data partitions found, skipping mapping` }));
          return null;
        }
        dstSchema = await buildTagSchema(tmpDstConn, mapping.target.table, dstTables[0].table_id);
      } finally {
        await tmpDstConn.close().catch(() => {});
      }
    } else {
      // LOG: 논리 테이블을 data_table로 사용
      dataTables = [mapping.source.table];

      srcSchema = await buildLogSchema(sourceConn, mapping.source.table);

      // source.columns 유효성 검증: columns(전체 컬럼) 기준
      if (mapping.source.columns) {
        const actualCols = new Set(srcSchema.columns.map(c => c.name));
        const unknownCols = mapping.source.columns.filter(c => !actualCols.has(c));
        if (unknownCols.length > 0) {
          console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `source.columns contains columns not found in source table: ${unknownCols.join(', ')}, skipping mapping` }));
          return null;
        }
      }

      // 대상 TableSchema 생성
      const tmpDstConn = new MachbaseClient(dstConfig);
      try {
        await tmpDstConn.connect();
        dstSchema = await buildLogSchema(tmpDstConn, mapping.target.table);
      } finally {
        await tmpDstConn.close().catch(() => {});
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `discover failed: ${err.message}` }));
    return null;
  } finally {
    // DISCOVER 완료 후 sourceConn 즉시 반납 (Worker는 각자 독립 연결을 사용)
    await sourceConn.close().catch(err =>
      console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `sourceConn.close after discover failed: ${err.message}` }))
    );
  }

  // src에만 있는 컬럼 검출 — dst에 없는 src 컬럼은 append할 수 없으므로 mapping 스킵
  const dstNames = new Set(dstSchema.columns.map(c => c.name));
  const srcOnlyCols = srcSchema.columns.map(c => c.name).filter(n => !dstNames.has(n));
  if (srcOnlyCols.length > 0) {
    console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `source has columns not present in destination: ${srcOnlyCols.join(', ')}, skipping mapping` }));
    return null;
  }

  return { tableType, dataTables, srcSchema, dstSchema };
}

// ─── _runMapping ──────────────────────────────────────────────────────────────

/**
 * 단일 mapping의 DISCOVER → 연결 생성 → Worker 실행 → 정리
 * @returns {Promise<void>}
 */
async function _runMapping(job, mapping, servers, shutdownFlag) {
  const srcConfig = servers[mapping.source.server];
  const dstConfig = servers[mapping.target.server];
  const logCtx = {
    job_id: job.id,
    mapping_id: mapping.mapping_id,
    source: `${mapping.source.server}/${mapping.source.table}`,
    target: `${mapping.target.server}/${mapping.target.table}`,
  };

  // ── DISCOVER ──────────────────────────────────────────────────

  const discovered = await _discoverMapping(mapping, servers, logCtx);
  if (!discovered) return;

  const { tableType, dataTables, srcSchema, dstSchema } = discovered;

  console.log(JSON.stringify({
    level: 'info', stage: 'job_runner', ...logCtx,
    table_type: tableType,
    data_tables: dataTables,
    msg: `discover ok, spawning ${dataTables.length} worker(s)`,
  }));

  // rowProcessor 생성 (TAG/LOG 전략 패턴)
  const tagIdentifier = mapping.source.tag_identifier || { mode: 'none', value: '' };
  const makeRowProcessor = () => tableType === 'TAG'
    ? new TagRowProcessor(tagIdentifier)
    : new LogRowProcessor();

  // ── Workers 병렬 실행 ─────────────────────────────────────────
  // @machbase/ts-client는 단일 connection/stream에서 동시 호출을 지원하지 않으므로
  // Worker(data_table)당 별도 sourceConn, targetConn, Writer를 생성한다.

  const workerResources = []; // { reader, writer }
  try {
    const workerPromises = dataTables.map(async dataTable => {
      const wSrcConn = new MachbaseClient(srcConfig);
      const wDstConn = new MachbaseClient(dstConfig);
      // Worker별 TagAliasCache 생성 (TAG 전용; LOG는 null)
      const wAliasCache = tableType === 'TAG' ? new TagAliasCache(mapping.source.table) : null;
      const wReader = new Reader(srcSchema, wSrcConn, dataTable, mapping.source.columns);
      const wWriter = new Writer(dstSchema);
      const wRowProcessor = makeRowProcessor();

      try {
        await wSrcConn.connect();
        await wDstConn.connect();
        const openErr = await wWriter.open(wDstConn, mapping.target.table, srcSchema);
        if (openErr) {
          console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, data_table: dataTable, msg: `worker Writer.open failed: ${openErr.message}` }));
          await wDstConn.close().catch(() => {});
          await wSrcConn.close().catch(() => {});
          return;
        }
        // 리소스 준비 완료 후 push — open() 실패 시 직접 close하므로 finally 중복 처리 없음.
        // open() 성공 시 dstConn 소유권은 Writer로 이전되므로 pendingDstConn은 null.
        workerResources.push({ reader: wReader, writer: wWriter });
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, data_table: dataTable, msg: `worker setup failed: ${err.message}` }));
        await wDstConn.close().catch(() => {});
        await wSrcConn.close().catch(() => {});
        return;
      }

      return runDataTableWorker({
        jobId: job.id,
        mapping,
        checkpoint: job.checkpoint,
        tableType,
        dataTable,
        srcConfig,
        dstConfig,
        reader: wReader,
        aliasCache: wAliasCache,
        writer: wWriter,
        rowProcessor: wRowProcessor,
        shutdownFlag,
      }).catch(err => {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, data_table: dataTable, msg: `worker crashed: ${err.message}` }));
      });
    });

    await Promise.all(workerPromises);
    console.log(JSON.stringify({ level: 'info', stage: 'job_runner', ...logCtx, msg: 'all workers finished' }));
  } finally {
    // 정리: writer.close() (stream + dstConn) → reader.close() (srcConn) 순서
    // setup 실패한 worker는 workerResources에 추가되지 않아 중복 close 없음.
    await Promise.all(workerResources.map(async res => {
      await res.writer.close().catch(err =>
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `workerWriter.close failed: ${err.message}` }))
      );
      await res.reader.close().catch(err =>
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `workerReader.close failed: ${err.message}` }))
      );
    }));
  }
}

// ─── _runJob / run ────────────────────────────────────────────────────────────

/**
 * 단일 job 실행 (모든 mapping 병렬)
 * @returns {Promise<void>}
 */
async function _runJob(job, servers, shutdownFlag) {
  if (!job.enabled) {
    console.log(JSON.stringify({ level: 'info', stage: 'job_runner', job_id: job.id, msg: 'job disabled, skipping' }));
    return;
  }

  console.log(JSON.stringify({ level: 'info', stage: 'job_runner', job_id: job.id, msg: `job start, mappings=${job.mappings.length}` }));

  // 각 mapping은 독립적으로 동작한다. 한 mapping의 예외가 다른 mapping을 중단시키지 않도록
  // .catch()로 감싸 의도적으로 오류를 로그만 남기고 계속 진행한다.
  const mappingPromises = job.mappings.map(mapping =>
    _runMapping(job, mapping, servers, shutdownFlag).catch(err => {
      console.error(JSON.stringify({ level: 'error', stage: 'job_runner', job_id: job.id, msg: `mapping crashed: ${err.message}` }));
    })
  );

  await Promise.all(mappingPromises);
  console.log(JSON.stringify({ level: 'info', stage: 'job_runner', job_id: job.id, msg: 'job finished' }));
}

/**
 * 전체 JobRunner 실행
 *
 * @param {object} config - ConfigLoader.load() 결과
 * @returns {Promise<void>}
 */
async function run(config) {
  const shutdownFlag = { value: false };

  // shutdown_timeout_ms: 활성화된 모든 job 중 최댓값 사용, 없으면 기본값
  let shutdownTimeoutMs = 30000;
  const enabledJobTimeouts = config.replication.jobs
    .filter(j => j.enabled)
    .map(j => j.shutdown_timeout_ms || 0);
  const maxTimeout = enabledJobTimeouts.length > 0 ? Math.max(...enabledJobTimeouts) : 0;
  if (maxTimeout > 0) shutdownTimeoutMs = maxTimeout;

  // shutdown timeout 타이머 — SIGTERM/SIGINT 수신 시점에 시작
  let timeoutHandle;
  function startShutdownTimer() {
    if (timeoutHandle) return; // 중복 실행 방지
    timeoutHandle = setTimeout(() => {
      console.warn(JSON.stringify({
        level: 'warn', stage: 'job_runner',
        msg: `shutdown timeout (${shutdownTimeoutMs}ms) exceeded, forcing exit`,
      }));
      process.exit(1);
    }, shutdownTimeoutMs);
  }

  // SIGTERM → shutdownFlag 설정 후 타이머 시작
  process.once('SIGTERM', () => {
    console.log(JSON.stringify({ level: 'info', stage: 'job_runner', msg: 'SIGTERM received, graceful shutdown initiated' }));
    shutdownFlag.value = true;
    startShutdownTimer();
  });
  // SIGINT도 처리 (Ctrl+C)
  process.once('SIGINT', () => {
    console.log(JSON.stringify({ level: 'info', stage: 'job_runner', msg: 'SIGINT received, graceful shutdown initiated' }));
    shutdownFlag.value = true;
    startShutdownTimer();
  });

  const enabledJobs = config.replication.jobs.filter(j => j.enabled);
  console.log(JSON.stringify({ level: 'info', stage: 'job_runner', msg: `starting ${enabledJobs.length} job(s)` }));

  const allDone = Promise.all(
    enabledJobs.map(job =>
      _runJob(job, config.servers, shutdownFlag).catch(err => {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', job_id: job.id, msg: `job crashed: ${err.message}` }));
      })
    )
  );

  await allDone;
  clearTimeout(timeoutHandle);
  console.log(JSON.stringify({ level: 'info', stage: 'job_runner', msg: 'all jobs completed' }));
}

module.exports = { run };
