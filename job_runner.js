'use strict';

const { MachbaseClient } = require('./machbase/machbase.js');
const CatalogClient = require('./machbase/catalog.js');
const TargetWriter = require('./machbase/target_writer.js');
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
  let sourceColumns;

  try {
    const result = await CatalogClient.getLogicalTableType(sourceConn, mapping.source.table);
    tableType = result.type;

    if (tableType === 'UNSUPPORTED') {
      console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `unsupported table type, skipping mapping` }));
      await sourceConn.close();
      return;
    }

    if (tableType === 'TAG') {
      const tables = await CatalogClient.listTagDataTables(sourceConn, mapping.source.table);
      if (tables.length === 0) {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `no data partitions found, skipping mapping` }));
        await sourceConn.close();
        return;
      }
      dataTables = tables.map(t => t.data_table);

      // TAG 컬럼 규칙 검증 (첫 번째 파티션 기준)
      const columns = await CatalogClient.getColumns(sourceConn, tables[0].table_id);
      if (!CatalogClient.validateTagColumns(columns)) {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `TAG column validation failed, skipping mapping` }));
        await sourceConn.close();
        return;
      }
      sourceColumns = columns;
    } else {
      // LOG: 논리 테이블을 data_table로 사용
      dataTables = [mapping.source.table];
      sourceColumns = [];
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
  // Worker(data_table)당 별도 sourceConn, targetConn, TargetWriter를 생성한다.

  const workerResources = []; // { srcConn, dstConn, writer }
  try {
    const workerPromises = dataTables.map(async dataTable => {
      const wSrcConn = new MachbaseClient(srcConfig);
      const wDstConn = new MachbaseClient(dstConfig);
      const wWriter = new TargetWriter();
      workerResources.push({ srcConn: wSrcConn, dstConn: wDstConn, writer: wWriter });

      try {
        await wSrcConn.connect();
        await wDstConn.connect();
        const openErr = await wWriter.open(wDstConn, mapping.target.table, sourceColumns);
        if (openErr) {
          console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, data_table: dataTable, msg: `worker TargetWriter.open failed: ${openErr.message}` }));
          return;
        }
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
        sourceConn: wSrcConn,
        targetConn: wDstConn,
        dstConfig,
        targetWriter: wWriter,
        shutdownFlag,
      }).catch(err => {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, data_table: dataTable, msg: `worker crashed: ${err.message}` }));
      });
    });

    await Promise.all(workerPromises);
    console.log(JSON.stringify({ level: 'info', stage: 'job_runner', ...logCtx, msg: 'all workers finished' }));
  } finally {
    // 정리: Worker 리소스 (stream → dstConn → srcConn) 순서
    await Promise.all(workerResources.map(async r => {
      await r.writer.close().catch(err =>
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `workerWriter.close failed: ${err.message}` }))
      );
      await r.dstConn.close().catch(err =>
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `workerDstConn.close failed: ${err.message}` }))
      );
      await r.srcConn.close().catch(err =>
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', ...logCtx, msg: `workerSrcConn.close failed: ${err.message}` }))
      );
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

  // shutdown_timeout_ms: 활성화된 첫 번째 job 기준, 없으면 기본값
  let shutdownTimeoutMs = 30000;
  for (const job of config.replication.jobs) {
    if (!job.enabled) continue;
    if (job.shutdown_timeout_ms) {
      shutdownTimeoutMs = job.shutdown_timeout_ms;
    }
    break;
  }

  // SIGTERM → shutdownFlag 설정
  process.once('SIGTERM', () => {
    console.log(JSON.stringify({ level: 'info', stage: 'job_runner', msg: 'SIGTERM received, graceful shutdown initiated' }));
    shutdownFlag.value = true;
  });
  // SIGINT도 처리 (Ctrl+C)
  process.once('SIGINT', () => {
    console.log(JSON.stringify({ level: 'info', stage: 'job_runner', msg: 'SIGINT received, graceful shutdown initiated' }));
    shutdownFlag.value = true;
  });

  const enabledJobs = config.replication.jobs.filter(j => j.enabled);
  console.log(JSON.stringify({ level: 'info', stage: 'job_runner', msg: `starting ${enabledJobs.length} job(s)` }));

  const allDone = Promise.all(
    config.replication.jobs.map(job =>
      _runJob(job, config.servers, shutdownFlag).catch(err => {
        console.error(JSON.stringify({ level: 'error', stage: 'job_runner', job_id: job.id, msg: `job crashed: ${err.message}` }));
      })
    )
  );

  // Graceful shutdown timeout
  let timeoutHandle;
  const timeoutPromise = new Promise(resolve => {
    timeoutHandle = setTimeout(() => {
      console.warn(JSON.stringify({
        level: 'warn', stage: 'job_runner',
        msg: `shutdown timeout (${shutdownTimeoutMs}ms) exceeded, forcing exit`,
      }));
      process.exit(1);
    }, shutdownTimeoutMs);
    // timeout은 shutdown 시에만 기다림 — 정상 종료 시에는 취소
    timeoutHandle.unref?.();
  });

  await allDone;
  clearTimeout(timeoutHandle);
  console.log(JSON.stringify({ level: 'info', stage: 'job_runner', msg: 'all jobs completed' }));
}

module.exports = { run };
