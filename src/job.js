'use strict';

const { MachbaseClient } = require('./db/client.js');
const { FLAG_METADATA } = require('./db/types.js');
const { TagMetaCache, TagTable, LogTable } = require('./db/table.js');
const { Worker } = require('./worker/worker.js');
const { getInstance: getLogger } = require('./lib/logger.js');

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

/**
 * source.columns 에 소스 스키마에 존재하지 않는 컬럼명이 포함되어 있으면
 * 에러 로그를 남기고 false를 반환한다. 검증 통과 시 true.
 *
 * @param {SourceConfig} source
 * @param {TableSchema} schema
 * @param {object} logCtx
 * @returns {boolean} true = valid, false = invalid (caller는 return null)
 */
function _validateSourceColumns(source, schema, logCtx) {
  if (!source.columns) return true;
  const actualCols = new Set(schema.columns.map(c => c.name));
  const unknownCols = source.columns.filter(c => !actualCols.has(c));
  if (unknownCols.length > 0) {
    getLogger().error('job', { ...logCtx, msg: `source.columns contains columns not found in source table: ${unknownCols.join(', ')}, skipping job` });
    return false;
  }
  return true;
}

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
    const targetTable = target.table || source.table;

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
            await table.open();
            const src = await table.getDataTables();
            if (src.length === 0) {
              getLogger().error('job', { ...logCtx, msg: `no data partitions found, skipping job` });
              return null;
            }
            dataTables = src.map(t => t.data_table);
            srcSchema = await table.getSchema();
          } finally {
            await table.close().catch(() => {});
          }

          if (!_validateSourceColumns(source, srcSchema, logCtx)) return null;

          if (source.columns) {
            const missing = ['NAME', 'TIME'].filter(c => !source.columns.includes(c));
            if (missing.length > 0) {
              getLogger().error('job', { ...logCtx, msg: `source.columns missing required TAG columns: ${missing.join(', ')}, skipping job` });
              return null;
            }
          }

          const dst = new TagTable(dstConfig, targetTable);
          try {
            await dst.open();
            let dstTables = await dst.getDataTables();
            if (dstTables.length === 0) {
              if (!this.jobConfig.target.autoCreate) {
                getLogger().error('job', { ...logCtx, msg: `no target data partitions found, skipping job` });
                return null;
              }
              const createClient = new MachbaseClient(dstConfig);
              try {
                await createClient.connect();
                await createClient.createTagTable(targetTable, srcSchema);
                getLogger().info('job', { ...logCtx, msg: `target table '${targetTable}' created` });
              } finally {
                await createClient.close().catch(() => {});
              }
              dstTables = await dst.getDataTables();
              if (dstTables.length === 0) {
                getLogger().error('job', { ...logCtx, msg: `target table created but no data partitions found` });
                return null;
              }
            }
            dstSchema = await dst.getSchema();
          } finally {
            await dst.close().catch(() => {});
          }
          break;
        }
        case 'LOG': {
          dataTables = [source.table];

          const src = new LogTable(source.table, srcConfig);
          try {
            await src.open();
            srcSchema = await src.getSchema();
          } finally {
            await src.close().catch(() => {});
          }

          if (!_validateSourceColumns(source, srcSchema, logCtx)) return null;

          const dst = new LogTable(targetTable, dstConfig);
          try {
            await dst.open();
            const dstType = await dst.client.selectTableType(targetTable);
            if (dstType.type === 'UNSUPPORTED') {
              if (!this.jobConfig.target.autoCreate) {
                getLogger().error('job', { ...logCtx, msg: `target table not found, skipping job` });
                return null;
              }
              await dst.client.createLogTable(targetTable, srcSchema);
              getLogger().info('job', { ...logCtx, msg: `target table '${targetTable}' created` });
            }
            dstSchema = await dst.getSchema();
          } finally {
            await dst.close().catch(() => {});
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
      .filter(c => !(c.flag & FLAG_METADATA) && !dstNames.has(c.name))
      .map(c => c.name);
    if (srcOnlyCols.length > 0) {
      getLogger().error('job', { ...logCtx, msg: `source has columns not present in destination: ${srcOnlyCols.join(', ')}, skipping job` });
      return null;
    }

    return { tableType, dataTables, srcSchema, dstSchema };
  }

  /**
   * src/dst TAG META 동기화 (name 변경 + metadata column value 변경)
   * workers 시작 전 1회 실행.
   * @param {string} targetTable - dst 논리 테이블명
   * @param {import('./db/types').TableSchema} srcSchema
   * @param {object} logCtx
   * @returns {Promise<true|null>} 성공 시 true, 실패 시 null
   */
  async _syncTagMeta(targetTable, srcSchema, logCtx) {
    const { source, target } = this.jobConfig;
    const srcConfig = this.servers.find(s => s.name === source.server);
    const dstConfig = this.servers.find(s => s.name === target.server);
    const tagIdentifier = source.tagIdentifier;

    const metaColNames = srcSchema.columns
      .filter(c => c.flag & FLAG_METADATA)
      .map(c => c.name);

    let srcMeta, dstMeta;
    const srcClient = new MachbaseClient(srcConfig);
    const dstClient = new MachbaseClient(dstConfig);
    try {
      await srcClient.connect();
      await dstClient.connect();
      srcMeta = await srcClient.selectTagMeta(source.table, metaColNames);
      dstMeta = await dstClient.selectTagMeta(targetTable, metaColNames);
    } catch (err) {
      getLogger().error('job', { ...logCtx, msg: `tag meta sync fetch failed: ${err.message}` });
      return null;
    } finally {
      await srcClient.close().catch(() => {});
      await dstClient.close().catch(() => {});
    }

    // dst: _ID → row 맵 (tagId 기준 매칭)
    const dstById = new Map(dstMeta.map(r => [BigInt(r._ID), r]));

    let nameUpdated = 0;
    let metaUpdated = 0;

    for (const srcRow of srcMeta) {
      const dstRow = dstById.get(BigInt(srcRow._ID));
      if (!dstRow) continue; // 신규 태그 — append 시 dst DB 자동 생성

      const canonicalName = TagMetaCache._applyIdentifier(srcRow.name, tagIdentifier);
      const sets = [];
      const nameChanged = dstRow.name !== canonicalName;
      if (nameChanged) sets.push({ name: 'NAME', value: canonicalName });

      const colDiff = metaColNames.filter(col => srcRow[col] !== dstRow[col]);
      for (const col of colDiff) sets.push({ name: col, value: srcRow[col] });

      if (sets.length === 0) continue;

      if (nameChanged) nameUpdated++;
      if (colDiff.length > 0) metaUpdated++;

      getLogger().info('job', {
        ...logCtx,
        msg: `tag meta sync: tag='${dstRow.name}'${nameChanged ? ` → '${canonicalName}'` : ''}, cols=[${colDiff.join(',')}]`,
      });

      const updateClient = new MachbaseClient(dstConfig);
      try {
        await updateClient.connect();
        await updateClient.updateTagMeta(targetTable, dstRow.name, sets);
      } catch (err) {
        getLogger().error('job', { ...logCtx, msg: `tag meta sync update failed: tag='${dstRow.name}', ${err.message}` });
        return null;
      } finally {
        await updateClient.close().catch(() => {});
      }
    }

    if (nameUpdated > 0 || metaUpdated > 0) {
      getLogger().info('job', { ...logCtx, msg: `tag meta sync done: name_updated=${nameUpdated}, meta_updated=${metaUpdated}` });
    }
    return true;
  }

  /**
   * shutdown 전까지 반복 실행. 에러/종료 시 재시작.
   */
  async run() {
    const { shutdownFlag } = this;
    const { id, source, target } = this.jobConfig;
    const logCtx = { job_id: id };

    const jobCtx = {
      ...logCtx,
      source: `${source.server}/${source.table}`,
      target: `${target.server}/${target.table || source.table}`,
    };
    getLogger().info('job', { ...jobCtx, msg: 'job start' });

    while (!shutdownFlag.value) {
      const discovered = await this._discoverMapping(jobCtx);
      if (!discovered) {
        if (shutdownFlag.value) break;
        getLogger().warn('job', { ...jobCtx, msg: 'discover failed, retrying in 5s' });
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      const { tableType, dataTables, srcSchema, dstSchema } = discovered;
      const srcConfig = this.servers.find(s => s.name === source.server);
      const dstConfig = this.servers.find(s => s.name === target.server);

      // ── TAG 테이블인 경우 meta sync ──
      if (tableType === 'TAG' && this.jobConfig.metaSync !== false) {
        const targetTable = target.table || source.table;
        const synced = await this._syncTagMeta(targetTable, srcSchema, jobCtx);
        if (!synced) {
          if (shutdownFlag.value) break;
          getLogger().warn('job', { ...jobCtx, msg: 'tag meta sync failed, retrying in 5s' });
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
      }

      getLogger().info('job', {
        ...jobCtx,
        table_type: tableType,
        partitions: dataTables.length,
        msg: `starting ${dataTables.length} worker(s)`,
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
          w.run(signal).then(() => {
            // shutdown/abort 없이 worker가 종료된 경우 → 비정상 종료로 간주, abort
            if (!shutdownFlag.value && !signal.aborted) {
              getLogger().warn('job', { ...jobCtx, partition: w.dataTable, msg: 'worker exited unexpectedly, aborting job' });
              ac.abort();
            }
          }).catch(err => {
            getLogger().error('job', { ...jobCtx, partition: w.dataTable, msg: `worker error: ${err.message}` });
            ac.abort();
            throw err;
          })
        ));
        getLogger().info('job', { ...jobCtx, msg: 'all workers finished' });
      } catch (_err) {
        // 에러 로그는 위에서 처리됨. shutdown 중이 아니면 재시작.
        if (!shutdownFlag.value) {
          getLogger().info('job', { ...jobCtx, msg: 'workers aborted, restarting job' });
        }
      }

      // shutdown 요청 시 루프 탈출
      if (shutdownFlag.value) break;
    }

    getLogger().info('job', { ...jobCtx, msg: 'job stopped' });
  }
}

module.exports = { JobScheduler, Job, Worker };
