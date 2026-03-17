'use strict';

const { MachbaseClient } = require('./db/client.js');
const { TagTable, LogTable } = require('./db/table.js');
const { Worker } = require('./worker/worker.js');
const { getInstance: getLogger } = require('./lib/logger.js');

// ─── JobScheduler ─────────────────────────────────────────────────────────────

class JobScheduler {
  constructor(servers) {
    this.servers = servers;
    // id → { jobConfig, shutdownFlag, promise, status: 'running'|'stopped' }
    this.registry = new Map();
  }

  register(jobConfig) {
    this.registry.set(jobConfig.id, { jobConfig, shutdownFlag: { value: false }, promise: null, status: 'stopped' });
  }

  unregister(id) {
    const entry = this.registry.get(id);
    if (!entry || entry.status === 'running') return;
    this.registry.delete(id);
  }

  update(jobConfig) {
    const entry = this.registry.get(jobConfig.id);
    if (!entry || entry.status === 'running') return;
    entry.jobConfig = jobConfig;
  }

  start(id) {
    const entry = this.registry.get(id);
    if (!entry || entry.status === 'running') return;
    const shutdownFlag = { value: false };
    entry.shutdownFlag = shutdownFlag;
    entry.status = 'running';
    entry.promise = new Job(entry.jobConfig, this.servers, shutdownFlag)
      .run()
      .catch(err => getLogger().error('job', { job_id: id, msg: `job error: ${err.message}` }))
      .finally(() => { entry.status = 'stopped'; });
  }

  async stop(id) {
    const entry = this.registry.get(id);
    if (!entry || entry.status !== 'running') return;
    entry.shutdownFlag.value = true;
    await entry.promise;
  }

  getEntry(id) {
    return this.registry.get(id);
  }

  listEntries() {
    return Array.from(this.registry.values());
  }

  async stopAll() {
    const running = Array.from(this.registry.values()).filter(e => e.status === 'running');
    for (const entry of running) {
      entry.shutdownFlag.value = true;
    }
    await Promise.all(running.map(e => e.promise));
  }
}

// ─── Job ──────────────────────────────────────────────────────────────────────

class Job {
  constructor(jobConfig, servers, shutdownFlag) {
    this.jobConfig = jobConfig;
    this.servers = servers;
    this.shutdownFlag = shutdownFlag;
  }

  /**
   * 소스/대상 스키마 수집 (단기 커넥션 사용 후 즉시 반납)
   * @returns {{ tableType, dataTables, srcSchema, dstSchema }}|null  null = 실패
   */
  async _discoverMapping(logCtx) {
    const { source, target } = this.jobConfig;
    const srcConfig = this.servers.find(s => s.name === source.server);
    const dstConfig = this.servers.find(s => s.name === target.server);

    let tableType;
    let dataTables;
    let srcSchema;
    let dstSchema;

    try {
      // 테이블 타입 조회 (단기 커넥션)
      const client = new MachbaseClient(srcConfig);
      try {
        await client.connect();
        const result = await client.selectTableType(source.table);
        tableType = result.type;
      } finally {
        await client.close().catch(() => {});
      }

      switch (tableType) {
        case 'TAG': {
          const table = new TagTable(srcConfig, source.table);
          try {
            await table.client.connect();
            const src = await table.getDataTables();
            if (src.length === 0) {
              getLogger().error('job', { ...logCtx, msg: `no data partitions found, skipping job` });
              return null;
            }
            dataTables = src.map(t => t.data_table);
            srcSchema = await table.getSchema();
          } finally {
            await table.client.close().catch(() => {});
          }

          if (source.columns) {
            const actualCols = new Set(srcSchema.columns.map(c => c.name));
            const unknownCols = source.columns.filter(c => !actualCols.has(c));
            if (unknownCols.length > 0) {
              getLogger().error('job', { ...logCtx, msg: `source.columns contains columns not found in source table: ${unknownCols.join(', ')}, skipping job` });
              return null;
            }
          }

          const dst = new TagTable(dstConfig, target.table);
          try {
            await dst.client.connect();
            const dstTables = await dst.getDataTables();
            if (dstTables.length === 0) {
              getLogger().error('job', { ...logCtx, msg: `no target data partitions found, skipping job` });
              return null;
            }
            dstSchema = await dst.getSchema();
          } finally {
            await dst.client.close().catch(() => {});
          }
          break;
        }
        case 'LOG': {
          dataTables = [source.table];

          const src = new LogTable(source.table, srcConfig);
          try {
            await src.client.connect();
            srcSchema = await src.getSchema();
          } finally {
            await src.client.close().catch(() => {});
          }

          if (source.columns) {
            const actualCols = new Set(srcSchema.columns.map(c => c.name));
            const unknownCols = source.columns.filter(c => !actualCols.has(c));
            if (unknownCols.length > 0) {
              getLogger().error('job', { ...logCtx, msg: `source.columns contains columns not found in source table: ${unknownCols.join(', ')}, skipping job` });
              return null;
            }
          }

          const dst = new LogTable(target.table, dstConfig);
          try {
            await dst.client.connect();
            dstSchema = await dst.getSchema();
          } finally {
            await dst.client.close().catch(() => {});
          }
          break;
        }
        default:
          getLogger().error('job', { ...logCtx, msg: `unsupported table type, skipping job` });
          return null;
      }
    } catch (err) {
      getLogger().error('job', { ...logCtx, msg: `discover failed: ${err.message}` });
      return null;
    }

    // src에만 있는 컬럼 검출 — metadata 카테고리는 제외 (safeNull로 패딩)
    const dstNames = new Set(dstSchema.columns.map(c => c.name));
    const srcOnlyCols = srcSchema.columns
      .filter(c => c.category !== 'metadata' && !dstNames.has(c.name))
      .map(c => c.name);
    if (srcOnlyCols.length > 0) {
      getLogger().error('job', { ...logCtx, msg: `source has columns not present in destination: ${srcOnlyCols.join(', ')}, skipping job` });
      return null;
    }

    return { tableType, dataTables, srcSchema, dstSchema };
  }

  /**
   * shutdown 전까지 반복 실행. 에러/종료 시 재시작.
   */
  async run() {
    const { shutdownFlag } = this;
    const { id, source, target } = this.jobConfig;
    const logCtx = { job_id: id };

    getLogger().info('job', { ...logCtx, msg: 'job start' });

    while (!shutdownFlag.value) {
      const jobCtx = {
        ...logCtx,
        source: `${source.server}/${source.table}`,
        target: `${target.server}/${target.table}`,
      };

      const discovered = await this._discoverMapping(jobCtx);
      if (!discovered) {
        if (shutdownFlag.value) break;
        getLogger().warn('job', { ...logCtx, msg: 'discover failed, retrying in 5s' });
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      const { tableType, dataTables, srcSchema, dstSchema } = discovered;
      const srcConfig = this.servers.find(s => s.name === source.server);
      const dstConfig = this.servers.find(s => s.name === target.server);

      getLogger().info('job', {
        ...jobCtx,
        table_type: tableType,
        data_tables: dataTables.join(','),
        msg: `discover ok, spawning ${dataTables.length} worker(s)`,
      });

      const workers = dataTables.map(dataTable =>
        new Worker(
          this.jobConfig,
          tableType,
          dataTable,
          srcSchema,
          dstSchema,
          srcConfig,
          dstConfig,
          shutdownFlag,
        )
      );

      // ── Workers 병렬 실행 (AbortController 패턴) ──
      const ac = new AbortController();
      const { signal } = ac;

      try {
        await Promise.all(workers.map(w =>
          w.run(signal).catch(err => {
            getLogger().error('job', { ...logCtx, data_table: w.dataTable, msg: `worker error: ${err.message}` });
            ac.abort();
            throw err;
          })
        ));
        getLogger().info('job', { ...logCtx, msg: 'all workers finished' });
      } catch (_err) {
        // 에러 로그는 위에서 처리됨. shutdown 중이 아니면 재시작.
        if (!shutdownFlag.value) {
          getLogger().info('job', { ...logCtx, msg: 'workers aborted, restarting job' });
        }
      }

      // shutdown 요청 시 루프 탈출
      if (shutdownFlag.value) break;
    }

    getLogger().info('job', { ...logCtx, msg: 'job stopped' });
  }
}

module.exports = { JobScheduler, Job, Worker };
