'use strict';

/**
 * @fileoverview Replicator — 소스→대상 데이터 복제 오케스트레이터
 */

const { MachbaseClient } = require('../db/client.js');
const { TagTable, LogTable } = require('../db/table.js');
const { Worker } = require('./worker.js');
const { getInstance: getLogger } = require('../lib/logger.js');

class AbortSignal {
  constructor() { this.aborted = false; }
}

class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort() { this.signal.aborted = true; }
}

class Replicator {
  constructor(config, shutdownFlag) {
    const sourceTable = typeof config.source?.table === 'string'
      ? config.source.table.toUpperCase()
      : config.source?.table;
    const targetTable = typeof config.target?.table === 'string'
      ? config.target.table.toUpperCase()
      : (config.target?.table || sourceTable);

    this.source = { ...config.source, table: sourceTable };
    this.target = { ...config.target, table: targetTable };
    this.id = config.id || `${sourceTable}_${targetTable}`;
    this.queryLimit = config.queryLimit ?? 5000;
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.startMode = config.startMode ?? 'full';
    this.ridAfter = config.ridAfter ?? null;
    this.onSaveFailure = config.onSaveFailure ?? 'continue';
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 30000;
    this.integrity = config.integrity ?? null;
    this.retry = config.retry ?? null;
    this.logging = config.logging ?? null;
    this.logCtx = {
      source: `${this.source.host}:${this.source.port}/${this.source.table}`,
      target: `${this.target.host}:${this.target.port}/${this.target.table}`,
    };
    this.shutdownFlag = shutdownFlag || { value: false };
  }

  discover() {
    const targetTable = this.target.table || this.source.table;
    let sourceClient = null;
    try {
      sourceClient = new MachbaseClient(this.source);
      sourceClient.connect();
      const { type: tableType } = sourceClient.selectTableType(this.source.table);
      if (tableType === 'UNSUPPORTED') {
        getLogger().error('replicator', { ...this.logCtx, msg: `source table '${this.source.table}' not found` });
        return null;
      }

      if (tableType === 'TAG') {
        const srcTable = new TagTable(this.source, this.source.table);
        const dstTable = new TagTable(this.target, targetTable);
        try {
          srcTable.open();
          dstTable.open();
          const dataTables = srcTable.getDataTables().map((item) => item.data_table);
          if (dataTables.length === 0) {
            getLogger().error('replicator', { ...this.logCtx, msg: 'no source data partitions found' });
            return null;
          }
          const dstParts = dstTable.getDataTables();
          if (dstParts.length === 0) {
            getLogger().error('replicator', { ...this.logCtx, msg: `target table '${targetTable}' not found or has no partitions` });
            return null;
          }
          return {
            tableType,
            dataTables,
            srcSchema: srcTable.getSchema(),
            dstSchema: dstTable.getSchema(),
          };
        } finally {
          try { srcTable.close(); } catch (_) {}
          try { dstTable.close(); } catch (_) {}
        }
      }

      if (tableType === 'LOG') {
        const srcTable = new LogTable(this.source.table, this.source);
        const dstTable = new LogTable(targetTable, this.target);
        try {
          srcTable.open();
          dstTable.open();
          const { type: dstType } = dstTable.client.selectTableType(targetTable);
          if (dstType !== 'LOG') {
            getLogger().error('replicator', { ...this.logCtx, msg: `target table '${targetTable}' not found` });
            return null;
          }
          return {
            tableType,
            dataTables: [this.source.table],
            srcSchema: srcTable.getSchema(),
            dstSchema: dstTable.getSchema(),
          };
        } finally {
          try { srcTable.close(); } catch (_) {}
          try { dstTable.close(); } catch (_) {}
        }
      }

      getLogger().error('replicator', { ...this.logCtx, msg: `unsupported table type '${tableType}'` });
      return null;
    } catch (err) {
      getLogger().error('replicator', { ...this.logCtx, msg: `discover failed: ${err.message}` });
      return null;
    } finally {
      try { sourceClient && sourceClient.close(); } catch (_) {}
    }
  }

  async runWorkers(discovered) {
    const { tableType, dataTables, srcSchema, dstSchema } = discovered;
    getLogger().info('replicator', {
      ...this.logCtx,
      table_type: tableType,
      partitions: dataTables.length,
      msg: `starting ${dataTables.length} worker(s)`,
    });

    const workerConfig = {
      id: this.id,
      source: this.source,
      target: this.target,
      queryLimit: this.queryLimit,
      pollIntervalMs: this.pollIntervalMs,
      startMode: this.startMode,
      ridAfter: this.ridAfter,
      onSaveFailure: this.onSaveFailure,
      integrity: this.integrity,
      retry: this.retry,
    };

    const workers = dataTables.map((dataTable) =>
      new Worker(workerConfig, dataTable, srcSchema, dstSchema, this.shutdownFlag)
    );

    const ac = new AbortController();
    const { signal } = ac;

    try {
      await Promise.all(workers.map((worker) =>
        worker.run(signal).then(() => {
          if (!this.shutdownFlag.value && !signal.aborted) {
            getLogger().warn('replicator', { ...this.logCtx, partition: worker.dataTable, msg: 'worker exited unexpectedly, aborting' });
            ac.abort();
          }
        }).catch((err) => {
          getLogger().error('replicator', { ...this.logCtx, partition: worker.dataTable, msg: `worker error: ${err.message}` });
          ac.abort();
          throw err;
        })
      ));
      getLogger().info('replicator', { ...this.logCtx, msg: 'all workers finished' });
      return true;
    } catch (_) {
      if (!this.shutdownFlag.value) {
        getLogger().info('replicator', { ...this.logCtx, msg: 'workers aborted, restarting' });
      }
      return false;
    }
  }

  shutdown() {
    this.shutdownFlag.value = true;
  }

  async start() {
    getLogger().info('replicator', { ...this.logCtx, stdout: true, msg: 'start' });

    while (!this.shutdownFlag.value) {
      const discovered = this.discover();
      if (!discovered) {
        if (this.shutdownFlag.value) break;
        getLogger().warn('replicator', { ...this.logCtx, msg: 'discover failed, retrying in 5s' });
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      await this.runWorkers(discovered);
      if (this.shutdownFlag.value) break;
    }

    getLogger().info('replicator', { ...this.logCtx, stdout: true, msg: 'stopped' });
  }
}

module.exports = { Replicator };
