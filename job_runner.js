'use strict';

const { MachbaseClient } = require('./machbase/machbase.js');
const TableInfo = require('./machbase/table_info.js');
const Reader = require('./machbase/reader.js');
const Writer = require('./machbase/writer.js');
const { runDataTableWorker } = require('./worker/worker.js');

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

  let sourceConn;
  try {
    sourceConn = new MachbaseClient(srcConfig);
    await sourceConn.connect();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `source connect failed: ${err.message}` }));
    return;
  }

  let tableType;
  let dataTables;
  let srcTableInfo;
  let dstTableInfo;

  try {
    const result = await sourceConn.getTableType(mapping.source.table);
    tableType = result.type;

    if (tableType === 'UNSUPPORTED') {
      console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `unsupported table type, skipping mapping` }));
      await sourceConn.close().catch(() => {});
      return;
    }

    if (tableType === 'TAG') {
      const tables = await sourceConn.listTagDataTables(mapping.source.table);
      if (tables.length === 0) {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `no data partitions found, skipping mapping` }));
        await sourceConn.close().catch(() => {});
        return;
      }
      dataTables = tables.map(t => t.data_table);

      // 소스 TableInfo 생성 (첫 번째 파티션 기준)
      srcTableInfo = await TableInfo.buildTag(sourceConn, mapping.source.table, tables[0].table_id);

      // 대상 TableInfo 생성
      const tmpDstConn = new MachbaseClient(dstConfig);
      try {
        await tmpDstConn.connect();
        const dstTables = await tmpDstConn.listTagDataTables(mapping.target.table);
        if (dstTables.length === 0) {
          console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `no target data partitions found, skipping mapping` }));
          await sourceConn.close().catch(() => {});
          return;
        }
        dstTableInfo = await TableInfo.buildTag(tmpDstConn, mapping.target.table, dstTables[0].table_id);
      } finally {
        await tmpDstConn.close().catch(() => {});
      }
    } else {
      // LOG: 논리 테이블을 data_table로 사용
      dataTables = [mapping.source.table];

      srcTableInfo = await TableInfo.buildLog(sourceConn, mapping.source.table);

      // 대상 TableInfo 생성
      const tmpDstConn = new MachbaseClient(dstConfig);
      try {
        await tmpDstConn.connect();
        dstTableInfo = await TableInfo.buildLog(tmpDstConn, mapping.target.table);
      } finally {
        await tmpDstConn.close().catch(() => {});
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `discover failed: ${err.message}` }));
    await sourceConn.close().catch(() => {});
    return;
  }

  console.log(JSON.stringify({
    level: 'info', stage: 'job_runner', ...logCtx,
    table_type: tableType,
    data_tables: dataTables,
    msg: `discover ok, spawning ${dataTables.length} worker(s)`,
  }));

  // ── Workers 병렬 실행 ─────────────────────────────────────────
  // @machbase/ts-client는 단일 connection/stream에서 동시 호출을 지원하지 않으므로
  // Worker(data_table)당 별도 sourceConn, targetConn, Writer를 생성한다.

  const workerResources = []; // { reader, writer, pendingDstConn }
  try {
    const workerPromises = dataTables.map(async dataTable => {
      const wSrcConn = new MachbaseClient(srcConfig);
      const wDstConn = new MachbaseClient(dstConfig);
      const wReader = new Reader(srcTableInfo, wSrcConn, dataTable);
      const wWriter = new Writer(dstTableInfo);
      const res = { reader: wReader, writer: wWriter, pendingDstConn: wDstConn };
      workerResources.push(res);

      try {
        await wSrcConn.connect();
        await wDstConn.connect();
        const openErr = await wWriter.open(wDstConn, mapping.target.table, srcTableInfo);
        if (openErr) {
          console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, data_table: dataTable, msg: `worker Writer.open failed: ${openErr.message}` }));
          return;
        }
        res.pendingDstConn = null; // 소유권 Writer로 이전 완료
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, data_table: dataTable, msg: `worker setup failed: ${err.message}` }));
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
        writer: wWriter,
        shutdownFlag,
      }).catch(err => {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, data_table: dataTable, msg: `worker crashed: ${err.message}` }));
      });
    });

    await Promise.all(workerPromises);
    console.log(JSON.stringify({ level: 'info', stage: 'job_runner', ...logCtx, msg: 'all workers finished' }));
  } finally {
    // 정리: writer.close() (stream + dstConn) → reader.close() (srcConn) 순서
    await Promise.all(workerResources.map(async res => {
      await res.writer.close().catch(err =>
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `workerWriter.close failed: ${err.message}` }))
      );
      await res.reader.close().catch(err =>
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `workerReader.close failed: ${err.message}` }))
      );
      // open() 실패 시 dstConn 소유권이 Writer로 이전되지 않았으므로 직접 close
      if (res.pendingDstConn) {
        await res.pendingDstConn.close().catch(err =>
          console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `pendingDstConn.close failed: ${err.message}` }))
        );
      }
    }));
    await sourceConn.close().catch(err =>
      console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `sourceConn.close failed: ${err.message}` }))
    );
  }
}

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
