'use strict';

const { MachbaseClient } = require('./db/client.js');
const { buildTagSchema, buildLogSchema } = require('./db/schema_builder.js');
const { Worker } = require('./worker/worker.js');
const { getInstance: getLogger } = require('./logger/logger.js');

// ─── Job ──────────────────────────────────────────────────────────────────────

class Job {
  constructor(jobConfig, servers, shutdownFlag) {
    this.jobConfig = jobConfig;
    this.servers = servers;
    this.shutdownFlag = shutdownFlag;
  }

  /**
   * mapping의 소스/대상 스키마 수집 (단기 커넥션 사용 후 즉시 반납)
   * @returns {{ tableType, dataTables, srcSchema, dstSchema }}|null  null = 실패
   */
  async _discoverMapping(mapping, logCtx) {
    const { servers } = this;
    const srcConfig = servers[mapping.source.server];
    const dstConfig = servers[mapping.target.server];

    let sourceConn;
    try {
      sourceConn = new MachbaseClient(srcConfig);
      await sourceConn.connect();
    } catch (err) {
      getLogger().error('job_runner', { ...logCtx, msg: `source connect failed: ${err.message}` });
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
        getLogger().error('job_runner', { ...logCtx, msg: `unsupported table type, skipping mapping` });
        return null;
      }

      if (tableType === 'TAG') {
        const tables = await sourceConn.listTagDataTables(mapping.source.table);
        if (tables.length === 0) {
          getLogger().error('job_runner', { ...logCtx, msg: `no data partitions found, skipping mapping` });
          return null;
        }
        dataTables = tables.map(t => t.data_table);

        // 소스 TableSchema 생성 (첫 번째 파티션 기준)
        srcSchema = await buildTagSchema(sourceConn, mapping.source.table, tables[0].table_id);

        // source.columns 유효성 검증
        if (mapping.source.columns) {
          const actualCols = new Set(srcSchema.columns.map(c => c.name));
          const unknownCols = mapping.source.columns.filter(c => !actualCols.has(c));
          if (unknownCols.length > 0) {
            getLogger().error('job_runner', { ...logCtx, msg: `source.columns contains columns not found in source table: ${unknownCols.join(', ')}, skipping mapping` });
            return null;
          }
        }

        // 대상 TableSchema 생성
        const tmpDstConn = new MachbaseClient(dstConfig);
        try {
          await tmpDstConn.connect();
          const dstTables = await tmpDstConn.listTagDataTables(mapping.target.table);
          if (dstTables.length === 0) {
            getLogger().error('job_runner', { ...logCtx, msg: `no target data partitions found, skipping mapping` });
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

        // source.columns 유효성 검증
        if (mapping.source.columns) {
          const actualCols = new Set(srcSchema.columns.map(c => c.name));
          const unknownCols = mapping.source.columns.filter(c => !actualCols.has(c));
          if (unknownCols.length > 0) {
            getLogger().error('job_runner', { ...logCtx, msg: `source.columns contains columns not found in source table: ${unknownCols.join(', ')}, skipping mapping` });
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
      getLogger().error('job_runner', { ...logCtx, msg: `discover failed: ${err.message}` });
      return null;
    } finally {
      // DISCOVER 완료 후 sourceConn 즉시 반납
      await sourceConn.close().catch(err =>
        getLogger().error('job_runner', { ...logCtx, msg: `sourceConn.close after discover failed: ${err.message}` })
      );
    }

    // src에만 있는 컬럼 검출 — metadata 카테고리는 제외 (Writer가 safeNull로 패딩)
    const dstNames = new Set(dstSchema.columns.map(c => c.name));
    const srcOnlyCols = srcSchema.columns
      .filter(c => c.category !== 'metadata' && !dstNames.has(c.name))
      .map(c => c.name);
    if (srcOnlyCols.length > 0) {
      getLogger().error('job_runner', { ...logCtx, msg: `source has columns not present in destination: ${srcOnlyCols.join(', ')}, skipping mapping` });
      return null;
    }

    return { tableType, dataTables, srcSchema, dstSchema };
  }

  /**
   * shutdown 전까지 반복 실행. 에러/종료 시 재시작.
   */
  async run() {
    const { jobConfig, servers, shutdownFlag } = this;
    const logCtx = { job_id: jobConfig.id };

    getLogger().info('job_runner', { ...logCtx, msg: `job start, mappings=${jobConfig.mappings.length}` });

    while (!shutdownFlag.value) {
      // ── DISCOVER 단계: mapping별 스키마 수집 ──
      const workers = [];

      for (const mapping of jobConfig.mappings) {
        const mappingCtx = {
          ...logCtx,
          mapping_id: mapping.mapping_id,
          source: `${mapping.source.server}/${mapping.source.table}`,
          target: `${mapping.target.server}/${mapping.target.table}`,
        };

        const discovered = await this._discoverMapping(mapping, mappingCtx);
        if (!discovered) {
          // discover 실패 → 이 mapping의 workers=[] (재시작 시 재시도)
          continue;
        }

        const { tableType, dataTables, srcSchema, dstSchema } = discovered;
        const srcConfig = servers[mapping.source.server];
        const dstConfig = servers[mapping.target.server];

        getLogger().info('job_runner', {
          ...mappingCtx,
          table_type: tableType,
          data_tables: dataTables.join(','),
          msg: `discover ok, spawning ${dataTables.length} worker(s)`,
        });

        for (const dataTable of dataTables) {
          workers.push(new Worker(
            jobConfig.id,
            jobConfig.checkpoint,
            mapping,
            tableType,
            dataTable,
            srcSchema,
            dstSchema,
            srcConfig,
            dstConfig,
            shutdownFlag,
          ));
        }
      }

      if (workers.length === 0) {
        if (shutdownFlag.value) break;
        // 모든 mapping discover 실패 → 잠시 대기 후 재시작
        getLogger().warn('job_runner', { ...logCtx, msg: 'no workers to run, retrying in 5s' });
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      // ── Workers 병렬 실행 (AbortController 패턴) ──
      const ac = new AbortController();
      const { signal } = ac;

      try {
        await Promise.all(workers.map(w =>
          w.run(signal).catch(err => {
            getLogger().error('job_runner', { ...logCtx, data_table: w.dataTable, msg: `worker error: ${err.message}` });
            ac.abort();
            throw err;
          })
        ));
        getLogger().info('job_runner', { ...logCtx, msg: 'all workers finished' });
      } catch (_err) {
        // 에러 로그는 위에서 처리됨. shutdown 중이 아니면 재시작.
        if (!shutdownFlag.value) {
          getLogger().info('job_runner', { ...logCtx, msg: 'workers aborted, restarting job' });
        }
      }

      // shutdown 요청 시 루프 탈출
      if (shutdownFlag.value) break;
    }

    getLogger().info('job_runner', { ...logCtx, msg: 'job stopped' });
  }
}

// ─── Replicator ───────────────────────────────────────────────────────────────

class Replicator {
  constructor(config) {
    this.config = config;
  }

  _startShutdownTimer(shutdownTimeoutMs) {
    const handle = setTimeout(() => {
      getLogger().warn('job_runner', { msg: `shutdown timeout (${shutdownTimeoutMs}ms) exceeded, forcing exit` });
      process.exit(1);
    }, shutdownTimeoutMs);
    // Node.js 프로세스 종료를 막지 않도록 unref
    if (handle.unref) handle.unref();
    return handle;
  }

  async run() {
    const { config } = this;
    const shutdownFlag = { value: false };

    // shutdown_timeout_ms: 활성화된 모든 job 중 최댓값 사용, 없으면 기본값
    let shutdownTimeoutMs = 30000;
    const enabledJobTimeouts = config.replication.jobs
      .filter(j => j.enabled)
      .map(j => j.shutdown_timeout_ms || 0);
    const maxTimeout = enabledJobTimeouts.length > 0 ? Math.max(...enabledJobTimeouts) : 0;
    if (maxTimeout > 0) shutdownTimeoutMs = maxTimeout;

    let timeoutHandle;
    const startShutdown = (signal) => {
      if (shutdownFlag.value) return;
      getLogger().info('job_runner', { msg: `${signal} received, graceful shutdown initiated` });
      shutdownFlag.value = true;
      timeoutHandle = this._startShutdownTimer(shutdownTimeoutMs);
    };

    process.once('SIGTERM', () => startShutdown('SIGTERM'));
    process.once('SIGINT', () => startShutdown('SIGINT'));

    const enabledJobs = config.replication.jobs.filter(j => j.enabled);
    getLogger().banner(`repli starting — ${enabledJobs.length} job(s)`);
    getLogger().info('job_runner', { msg: `starting ${enabledJobs.length} job(s)` });

    // 각 job을 독립적으로 실행 — 한 job의 실패가 다른 job을 중단시키지 않음
    await Promise.all(
      enabledJobs.map(jobConfig =>
        new Job(jobConfig, config.servers, shutdownFlag).run().catch(err => {
          getLogger().error('job_runner', { job_id: jobConfig.id, msg: `job crashed: ${err.message}` });
        })
      )
    );

    clearTimeout(timeoutHandle);
    getLogger().info('job_runner', { msg: 'all jobs completed' });
  }
}

module.exports = { Replicator, Job, Worker };
