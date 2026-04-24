'use strict';

/**
 * @fileoverview Replicator — 소스→대상 데이터 복제 오케스트레이터
 */

const fs = require('fs');
const path = require('path');
const process = require('process');
const { MachbaseClient } = require('../db/client.js');
const { createQueryClient } = require('../db/remote.js');
const { TagTable, LogTable } = require('../db/table.js');
const CheckpointStore = require('../db/checkpoint.js');
const { Worker, SOURCE_TABLE_RECREATED_CODE } = require('./worker.js');
const { TagMetaSyncManager } = require('./tag-meta-sync.js');
const { getInstance: getLogger } = require('../lib/logger.js');
const { ColumnType, Column, TableSchema, FLAG_METADATA } = require('../db/types.js');

const CHECKPOINT_BASE = path.resolve(path.dirname(process.argv[1]));
const CHECKPOINT_DIRECTORY = path.join(CHECKPOINT_BASE, 'data');

class AbortSignal {
  constructor() { this.aborted = false; }
}

class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort() { this.signal.aborted = true; }
}

function _normalizeSourceTableId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function _tableTypeFromSourceInfo(sourceInfo) {
  if (!sourceInfo || sourceInfo.type == null) return 'UNSUPPORTED';
  switch (sourceInfo.type) {
    case 6: return 'TAG';
    case 0: return 'LOG';
    default: return 'UNSUPPORTED';
  }
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
    this.retry = config.retry ?? null;
    this.logging = config.logging ?? null;
    this.runtimeHints = config._runtime || null;
    this.forceFreshStart = false;
    this.logCtx = {
      source: `${this.source.host}:${this.source.port}/${this.source.table}`,
      target: `${this.target.host}:${this.target.port}/${this.target.table}`,
    };
    this.shutdownFlag = shutdownFlag || { value: false };
  }

  async _openSourceClient() {
    const type = String(this.source?.type || 'native').toLowerCase();
    const client = type === 'native' ? new MachbaseClient(this.source) : createQueryClient(this.source);
    await client.connect();
    return client;
  }

  _buildSchemaFromRuntimeHints(logicalTable) {
    const hint = this.runtimeHints?.target || null;
    if (!hint || !Array.isArray(hint.dataColumns)) {
      throw new Error('target runtime hints are missing');
    }
    const serialized = hint && Array.isArray(hint.dataColumns)
      ? hint.dataColumns.concat(Array.isArray(hint.metaColumns) ? hint.metaColumns : [])
      : [];
    const columns = serialized.map((column) => new Column(
      column.name,
      ColumnType.fromCode(column.type),
      column.id,
      column.flag,
      column.length || 0
    ));
    return new TableSchema(hint?.tableType || 'LOG', logicalTable, columns);
  }

  _buildMqttPublishSchema(srcSchema, logicalTable) {
    const columns = [];
    let nextId = 0;
    const sourceByName = {};
    for (const column of srcSchema.columns) {
      sourceByName[column.name] = column;
    }

    for (const name of (this.target.columns || [])) {
      if (!name) continue;
      const sourceColumn = sourceByName[name];
      if (!sourceColumn) continue;
      columns.push(new Column(name, sourceColumn.columnType, nextId++, sourceColumn.flag & ~FLAG_METADATA, sourceColumn.length));
    }
    for (const name of (this.target.meta || [])) {
      if (!name) continue;
      const sourceColumn = sourceByName[name];
      if (!sourceColumn) continue;
      columns.push(new Column(name, sourceColumn.columnType, nextId++, sourceColumn.flag | FLAG_METADATA, sourceColumn.length));
    }
    return new TableSchema(srcSchema.tableType, logicalTable, columns);
  }

  async discover() {
    const targetTable = this.target.table || this.source.table;
    const targetType = String(this.target?.type || 'native').toLowerCase();
    const targetQueryable = targetType !== 'mqtt-api' && targetType !== 'mqtt-publish';
    let sourceClient = null;
    try {
      sourceClient = await this._openSourceClient();
      const rawSourceInfo = await sourceClient.selectTableInfoQualified(this.source.table);
      const sourceInfo = {
        owner: rawSourceInfo.owner,
        table: rawSourceInfo.table,
        id: _normalizeSourceTableId(rawSourceInfo.id),
        type: rawSourceInfo.type,
      };
      const tableType = _tableTypeFromSourceInfo(sourceInfo);
      if (tableType === 'UNSUPPORTED') {
        getLogger().error('replicator', { ...this.logCtx, msg: `source table '${this.source.table}' not found` });
        return null;
      }

      if (tableType === 'TAG') {
        const srcTable = new TagTable(this.source, this.source.table);
        try {
          await srcTable.open();
          const dataTables = (await srcTable.getDataTables()).map((item) => item.data_table);
          if (dataTables.length === 0) {
            getLogger().error('replicator', { ...this.logCtx, msg: 'no source data partitions found' });
            return null;
          }
          let dstSchema = null;
          if (targetQueryable) {
            const dstTable = new TagTable(this.target, targetTable);
            try {
              await dstTable.open();
              const dstParts = await dstTable.getDataTables();
              if (dstParts.length === 0) {
                getLogger().error('replicator', { ...this.logCtx, msg: `target table '${targetTable}' not found or has no partitions` });
                return null;
              }
              dstSchema = await dstTable.getSchema();
            } finally {
              try { await dstTable.close(); } catch (_) {}
            }
          } else if (targetType === 'mqtt-api') {
            dstSchema = this._buildSchemaFromRuntimeHints(targetTable);
          } else {
            dstSchema = this._buildMqttPublishSchema(await srcTable.getSchema(), targetTable);
          }
          return {
            tableType,
            dataTables,
            srcSchema: await srcTable.getSchema(),
            dstSchema,
            sourceInfo,
          };
        } finally {
          try { await srcTable.close(); } catch (_) {}
        }
      }

      if (tableType === 'LOG') {
        const srcTable = new LogTable(this.source.table, this.source);
        try {
          await srcTable.open();
          let dstSchema = null;
          if (targetQueryable) {
            const dstTable = new LogTable(targetTable, this.target);
            try {
              await dstTable.open();
              const { type: dstType } = await dstTable.client.selectTableTypeQualified(targetTable);
              if (dstType !== 'LOG') {
                getLogger().error('replicator', { ...this.logCtx, msg: `target table '${targetTable}' not found` });
                return null;
              }
              dstSchema = await dstTable.getSchema();
            } finally {
              try { await dstTable.close(); } catch (_) {}
            }
          } else if (targetType === 'mqtt-api') {
            dstSchema = this._buildSchemaFromRuntimeHints(targetTable);
          } else {
            dstSchema = this._buildMqttPublishSchema(await srcTable.getSchema(), targetTable);
          }
          return {
            tableType,
            dataTables: [this.source.table],
            srcSchema: await srcTable.getSchema(),
            dstSchema,
            sourceInfo,
          };
        } finally {
          try { await srcTable.close(); } catch (_) {}
        }
      }

      getLogger().error('replicator', { ...this.logCtx, msg: `unsupported table type '${tableType}'` });
      return null;
    } catch (err) {
      getLogger().error('replicator', { ...this.logCtx, msg: `discover failed: ${err.message}` });
      return null;
    } finally {
      try { sourceClient && await sourceClient.close(); } catch (_) {}
    }
  }

  _getCheckpointDirectory() {
    return path.join(CHECKPOINT_DIRECTORY, this.id);
  }

  _clearCheckpointDirectory(logFields) {
    const checkpointDir = this._getCheckpointDirectory();
    try {
      fs.rmSync(checkpointDir, { recursive: true, force: true });
      if (logFields) {
        getLogger().warn('replicator', { ...this.logCtx, ...logFields });
      }
      return true;
    } catch (err) {
      getLogger().error('replicator', {
        ...this.logCtx,
        checkpointDir,
        msg: `failed to clear checkpoint directory: ${err.message}`,
      });
      return false;
    }
  }

  _resetCheckpointDirectoryIfSourceTableChanged(sourceInfo) {
    const currentSourceTableId = _normalizeSourceTableId(sourceInfo && sourceInfo.id);
    if (!currentSourceTableId) return false;

    const checkpointDir = this._getCheckpointDirectory();
    let fileNames = null;
    try {
      fileNames = fs.readdirSync(checkpointDir)
        .filter((name) => name.endsWith('.json') && name !== 'meta-sync.json');
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      getLogger().error('replicator', {
        ...this.logCtx,
        checkpointDir,
        msg: `failed to inspect checkpoint directory: ${err.message}`,
      });
      return false;
    }

    let mismatch = null;
    for (const fileName of fileNames) {
      const dataTable = fileName.replace(/\.json$/, '');
      const loaded = new CheckpointStore(checkpointDir, dataTable).load();
      if (!loaded.exists || !loaded.cp || !loaded.cp.sourceTableId) {
        continue;
      }
      if (loaded.cp.sourceTableId !== currentSourceTableId) {
        mismatch = {
          checkpointFile: fileName,
          storedSourceTableId: loaded.cp.sourceTableId,
        };
        break;
      }
    }

    if (!mismatch) return false;

    return this._clearCheckpointDirectory({
      sourceTable: this.source.table,
      checkpointFile: mismatch.checkpointFile,
      storedSourceTableId: mismatch.storedSourceTableId,
      currentSourceTableId,
      msg: 'source table id changed since the saved checkpoint, cleared checkpoint and metadata sync state before restart from rid 0',
    });
  }

  async runWorkers(discovered) {
    const { tableType, dataTables, srcSchema, dstSchema, sourceInfo } = discovered;
    // source table recreation은 기존 job의 startMode(now/ridAfter)를 이어받지 않고 새 테이블 전체를 다시 읽어야 한다.
    const startupReset = this._resetCheckpointDirectoryIfSourceTableChanged(sourceInfo);
    const forceFreshStart = this.forceFreshStart || startupReset;
    this.forceFreshStart = false;
    getLogger().info('replicator', {
      ...this.logCtx,
      table_type: tableType,
      partitions: dataTables.length,
      forceFreshStart,
      msg: `starting ${dataTables.length} worker(s)`,
    });

    const workerConfig = {
      id: this.id,
      source: this.source,
      target: this.target,
      queryLimit: this.queryLimit,
      pollIntervalMs: this.pollIntervalMs,
      startMode: forceFreshStart ? 'full' : this.startMode,
      ridAfter: this.ridAfter,
      onSaveFailure: this.onSaveFailure,
      retry: this.retry,
      sourceTableId: _normalizeSourceTableId(sourceInfo && sourceInfo.id),
    };

    let metaSyncManager = null;
    if (TagMetaSyncManager.supports(workerConfig, srcSchema)) {
      metaSyncManager = new TagMetaSyncManager(
        workerConfig,
        srcSchema,
        dstSchema,
        path.join(CHECKPOINT_DIRECTORY, this.id),
        this.shutdownFlag
      );
      const bootOk = await metaSyncManager.bootstrap();
      if (!bootOk) {
        try { await metaSyncManager.close(); } catch (_) {}
        return false;
      }
    }

    const workers = dataTables.map((dataTable) =>
      new Worker(workerConfig, dataTable, srcSchema, dstSchema, this.shutdownFlag, metaSyncManager)
    );

    const ac = new AbortController();
    const { signal } = ac;
    let failure = null;

    try {
      await Promise.all(workers.map((worker) =>
        worker.run(signal).then(() => {
          if (!this.shutdownFlag.value && !signal.aborted && !failure) {
            failure = {
              err: new Error('worker exited unexpectedly'),
              partition: worker.dataTable,
            };
            getLogger().warn('replicator', { ...this.logCtx, partition: worker.dataTable, msg: 'worker exited unexpectedly, aborting' });
            ac.abort();
          }
        }).catch((err) => {
          if (!failure) {
            failure = { err, partition: worker.dataTable };
          }
          if (!(err && err.code === SOURCE_TABLE_RECREATED_CODE)) {
            getLogger().error('replicator', { ...this.logCtx, partition: worker.dataTable, msg: `worker error: ${err.message}` });
          }
          ac.abort();
        })
      ));
      if (failure) {
        if (failure.err && failure.err.code === SOURCE_TABLE_RECREATED_CODE) {
          const details = failure.err.details || {};
          this.forceFreshStart = true;
          this._clearCheckpointDirectory({
            sourceTable: this.source.table,
            partition: failure.partition,
            previousSourceTableId: details.previousSourceTableId || '',
            currentSourceTableId: details.currentSourceTableId || '',
            checkpointRid: details.checkpointRid || '',
            startRid: details.startRid || '',
            currentMaxRid: details.currentMaxRid || '',
            msg: 'source table recreation detected while replicating, cleared checkpoint and metadata sync state before restart from rid 0',
          });
        } else if (!this.shutdownFlag.value) {
          getLogger().info('replicator', { ...this.logCtx, msg: 'workers aborted, restarting' });
        }
        return false;
      }
      getLogger().debug('replicator', { ...this.logCtx, msg: 'all workers finished' });
      return true;
    } finally {
      try { metaSyncManager && await metaSyncManager.close(); } catch (_) {}
    }
  }

  shutdown() {
    this.shutdownFlag.value = true;
  }

  async start() {
    getLogger().stdout('info', 'replicator', { ...this.logCtx, msg: 'start' });
    getLogger().info('replicator', { ...this.logCtx, msg: 'start' });

    while (!this.shutdownFlag.value) {
      const discovered = await this.discover();
      if (!discovered) {
        if (this.shutdownFlag.value) break;
        getLogger().warn('replicator', { ...this.logCtx, msg: 'discover failed, retrying in 5s' });
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      await this.runWorkers(discovered);
      if (this.shutdownFlag.value) break;
    }

    getLogger().stdout('info', 'replicator', { ...this.logCtx, msg: 'stopped' });
    getLogger().info('replicator', { ...this.logCtx, msg: 'stopped' });
  }
}

module.exports = { Replicator };
