'use strict';

const { MachbaseClient } = require('../db/client.js');
const { FLAG_METADATA } = require('../db/types.js');
const { TagMetaCache, TagTable, LogTable } = require('../db/table.js');
const { Worker } = require('./worker.js');
const { getInstance: getLogger } = require('../lib/logger.js');

// jsh에는 AbortController가 없으므로 직접 구현
class AbortSignal {
  constructor() { this.aborted = false; }
}
class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort() { this.signal.aborted = true; }
}

// ─── Replicator ───────────────────────────────────────────────────────────────

class Replicator {
  constructor(config, shutdownFlag) {
    const targetTable = config.target.table || config.source.table;
    this.id             = config.id || `${config.source.table}_${targetTable}`;
    this.source           = config.source;
    this.target           = config.target;
    this.queryLimit       = config.queryLimit       ?? 5000;
    this.ridRangeSize     = config.ridRangeSize     ?? 50000;
    this.pollIntervalMs   = config.pollIntervalMs   ?? 1000;
    this.startMode        = config.startMode        ?? 'full';
    this.ridAfter         = config.ridAfter         ?? null;
    this.onSaveFailure    = config.onSaveFailure    ?? 'continue';
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 30000;
    this.integrity        = config.integrity        ?? null;
    this.metaSync         = config.metaSync         ?? true;
    this.retry            = config.retry            ?? null;
    this.logCtx = {
      source: `${this.source.host}:${this.source.port}/${this.source.table}`,
      target: `${this.target.host}:${this.target.port}/${this.target.table || this.source.table}`,
    };
    this.shutdownFlag = shutdownFlag || { value: false };
  }

  // ── 2. discover ─────────────────────────────────────────────────────────────

  discover() {
    const targetTable = this.target.table || this.source.table;

    let tableType, dataTables, srcSchema, dstSchema;

    try {
      const client = new MachbaseClient(this.source);
      try {
        client.connect();
        tableType = client.selectTableType(this.source.table).type;
      } finally {
        try { client.close(); } catch (_) {}
      }

      switch (tableType) {
        case 'TAG': {
          const srcTable = new TagTable(this.source, this.source.table);
          try {
            srcTable.open();
            const parts = srcTable.getDataTables();
            if (parts.length === 0) {
              getLogger().error('replicator', { ...this.logCtx, msg: `no data partitions found, skipping` });
              return null;
            }
            dataTables = parts.map(t => t.data_table);
            srcSchema = srcTable.getSchema();
          } finally {
            try { srcTable.close(); } catch (_) {}
          }

          if (!this._validateSourceColumns(this.source, srcSchema)) return null;

          if (this.source.columns) {
            const missing = ['NAME', 'TIME'].filter(c => !this.source.columns.includes(c));
            if (missing.length > 0) {
              getLogger().error('replicator', { ...this.logCtx, msg: `source.columns missing required TAG columns: ${missing.join(', ')}, skipping` });
              return null;
            }
          }

          const dstTable = new TagTable(this.target, targetTable);
          try {
            dstTable.open();
            let dstParts = dstTable.getDataTables();
            if (dstParts.length === 0) {
              if (!this.target.autoCreate) {
                getLogger().error('replicator', { ...this.logCtx, msg: `no target data partitions found, skipping` });
                return null;
              }
              const createClient = new MachbaseClient(this.target);
              try {
                createClient.connect();
                createClient.createTagTable(targetTable, srcSchema);
                getLogger().info('replicator', { ...this.logCtx, msg: `target table '${targetTable}' created` });
              } finally {
                try { createClient.close(); } catch (_) {}
              }
              dstParts = dstTable.getDataTables();
              if (dstParts.length === 0) {
                getLogger().error('replicator', { ...this.logCtx, msg: `target table created but no data partitions found` });
                return null;
              }
            }
            dstSchema = dstTable.getSchema();
          } finally {
            try { dstTable.close(); } catch (_) {}
          }
          break;
        }
        case 'LOG': {
          dataTables = [this.source.table];

          const srcTable = new LogTable(this.source.table, this.source);
          try {
            srcTable.open();
            srcSchema = srcTable.getSchema();
          } finally {
            try { srcTable.close(); } catch (_) {}
          }

          if (!this._validateSourceColumns(this.source, srcSchema)) return null;

          const dstTable = new LogTable(targetTable, this.target);
          try {
            dstTable.open();
            const dstType = dstTable.client.selectTableType(targetTable);
            if (dstType.type === 'UNSUPPORTED') {
              if (!this.target.autoCreate) {
                getLogger().error('replicator', { ...this.logCtx, msg: `target table not found, skipping` });
                return null;
              }
              dstTable.client.createLogTable(targetTable, srcSchema);
              getLogger().info('replicator', { ...this.logCtx, msg: `target table '${targetTable}' created` });
            }
            dstSchema = dstTable.getSchema();
          } finally {
            try { dstTable.close(); } catch (_) {}
          }
          break;
        }
        default:
          getLogger().error('replicator', { ...this.logCtx, msg: `unsupported table type, skipping` });
          return null;
      }
    } catch (err) {
      getLogger().error('replicator', { ...this.logCtx, msg: `discover failed: ${err.message}` });
      return null;
    }

    const dstNames = new Set(dstSchema.columns.map(c => c.name));
    const srcOnlyCols = srcSchema.columns
      .filter(c => !(c.flag & FLAG_METADATA) && !dstNames.has(c.name))
      .map(c => c.name);
    if (srcOnlyCols.length > 0) {
      getLogger().error('replicator', { ...this.logCtx, msg: `source has columns not present in destination: ${srcOnlyCols.join(', ')}, skipping` });
      return null;
    }

    return { tableType, dataTables, srcSchema, dstSchema };
  }

  // ── 3. meta sync ────────────────────────────────────────────────────────────

  syncMeta(srcSchema) {
    const targetTable = this.target.table || this.source.table;
    const nameRule = (this.source.transform ?? []).find(t => t.column === 'NAME') ?? null;

    const metaColNames = srcSchema.columns
      .filter(c => c.flag & FLAG_METADATA)
      .map(c => c.name);

    let srcMeta, dstMeta;
    const srcClient = new MachbaseClient(this.source);
    const dstClient = new MachbaseClient(this.target);
    try {
      srcClient.connect();
      dstClient.connect();
      srcMeta = srcClient.selectTagMeta(this.source.table, metaColNames);
      dstMeta = dstClient.selectTagMeta(targetTable, metaColNames);
    } catch (err) {
      getLogger().error('replicator', { ...this.logCtx, msg: `tag meta sync fetch failed: ${err.message}` });
      return null;
    } finally {
      try { srcClient.close(); } catch (_) {}
      try { dstClient.close(); } catch (_) {}
    }

    const dstById = new Map(dstMeta.map(r => [BigInt(r._ID), r]));
    let nameUpdated = 0;
    let metaUpdated = 0;

    for (const srcRow of srcMeta) {
      const dstRow = dstById.get(BigInt(srcRow._ID));
      if (!dstRow) continue;

      const canonicalName = TagMetaCache._applyNameRule(srcRow.name, nameRule);
      const sets = [];
      const nameChanged = dstRow.name !== canonicalName;
      if (nameChanged) sets.push({ name: 'NAME', value: canonicalName });

      const colDiff = metaColNames.filter(col => srcRow[col] !== dstRow[col]);
      for (const col of colDiff) sets.push({ name: col, value: srcRow[col] });

      if (sets.length === 0) continue;

      if (nameChanged) nameUpdated++;
      if (colDiff.length > 0) metaUpdated++;

      getLogger().info('replicator', {
        ...this.logCtx,
        msg: `tag meta sync: tag='${dstRow.name}'${nameChanged ? ` -> '${canonicalName}'` : ''}, cols=[${colDiff.join(',')}]`,
      });

      const updateClient = new MachbaseClient(this.target);
      try {
        updateClient.connect();
        updateClient.updateTagMeta(targetTable, dstRow.name, sets);
      } catch (err) {
        getLogger().error('replicator', { ...this.logCtx, msg: `tag meta sync update failed: tag='${dstRow.name}', ${err.message}` });
        return null;
      } finally {
        try { updateClient.close(); } catch (_) {}
      }
    }

    if (nameUpdated > 0 || metaUpdated > 0) {
      getLogger().info('replicator', { ...this.logCtx, msg: `tag meta sync done: name_updated=${nameUpdated}, meta_updated=${metaUpdated}` });
    }
    return true;
  }

  // ── 4. workers 실행 ─────────────────────────────────────────────────────────

  async runWorkers(discovered) {
    const { tableType, dataTables, srcSchema, dstSchema } = discovered;

    getLogger().info('replicator', {
      ...this.logCtx,
      table_type: tableType,
      partitions: dataTables.length,
      msg: `starting ${dataTables.length} worker(s)`,
    });

    const workerConfig = {
      id:             this.id,
      source:         this.source,
      target:         this.target,
      queryLimit:     this.queryLimit,
      ridRangeSize:   this.ridRangeSize,
      pollIntervalMs: this.pollIntervalMs,
      startMode:      this.startMode,
      ridAfter:       this.ridAfter,
      onSaveFailure:  this.onSaveFailure,
      integrity:      this.integrity,
      retry:          this.retry,
    };
    const workers = dataTables.map(dataTable =>
      new Worker(workerConfig, dataTable, srcSchema, dstSchema, this.shutdownFlag)
    );

    const ac = new AbortController();
    const { signal } = ac;

    try {
      await Promise.all(workers.map(w =>
        w.run(signal).then(() => {
          if (!this.shutdownFlag.value && !signal.aborted) {
            getLogger().warn('replicator', { ...this.logCtx, partition: w.dataTable, msg: 'worker exited unexpectedly, aborting' });
            ac.abort();
          }
        }).catch(err => {
          getLogger().error('replicator', { ...this.logCtx, partition: w.dataTable, msg: `worker error: ${err.message}` });
          ac.abort();
          throw err;
        })
      ));
      getLogger().info('replicator', { ...this.logCtx, msg: 'all workers finished' });
      return true;
    } catch (_err) {
      if (!this.shutdownFlag.value) {
        getLogger().info('replicator', { ...this.logCtx, msg: 'workers aborted, restarting' });
      }
      return false;
    }
  }

  // ── 5. source 컬럼 유효성 검사 ──────────────────────────────────────────────

  _validateSourceColumns(source, schema) {
    if (!source.columns) return true;
    const actualCols = new Set(schema.columns.map(c => c.name));
    const unknownCols = source.columns.filter(c => !actualCols.has(c));
    if (unknownCols.length > 0) {
      getLogger().error('replicator', { ...this.logCtx, msg: `source.columns contains columns not found in source table: ${unknownCols.join(', ')}, skipping` });
      return false;
    }
    return true;
  }

  // ── 6. 메인 루프 ────────────────────────────────────────────────────────────

  shutdown() {
    this.shutdownFlag.value = true;
  }

  async start() {
    getLogger().info('replicator', { ...this.logCtx, msg: 'start' });

    while (!this.shutdownFlag.value) {
      const discovered = this.discover();
      if (!discovered) {
        if (this.shutdownFlag.value) break;
        getLogger().warn('replicator', { ...this.logCtx, msg: 'discover failed, retrying in 5s' });
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      const { tableType, srcSchema } = discovered;
      if (tableType === 'TAG' && this.metaSync !== false) {
        if (!this.syncMeta(srcSchema)) {
          if (this.shutdownFlag.value) break;
          getLogger().warn('replicator', { ...this.logCtx, msg: 'tag meta sync failed, retrying in 5s' });
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
      }

      await this.runWorkers(discovered);

      if (this.shutdownFlag.value) break;
    }

    getLogger().info('replicator', { ...this.logCtx, msg: 'stopped' });
  }
}

module.exports = { Replicator };
