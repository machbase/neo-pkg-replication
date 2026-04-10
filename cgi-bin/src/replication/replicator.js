'use strict';

/**
 * @fileoverview Replicator — 소스→대상 데이터 복제 오케스트레이터
 *
 * 메인 루프: discover() → syncMeta() [TAG 전용] → runWorkers()
 * 각 단계 실패 시 5초 후 재시도한다.
 */

const { MachbaseClient } = require('../db/client.js');
const { FLAG_METADATA, FLAG_PRIMARY, FLAG_BASETIME } = require('../db/types.js');
const { TagMetaCache, TagTable, LogTable } = require('../db/table.js');
const { Worker } = require('./worker.js');
const { getInstance: getLogger } = require('../lib/logger.js');

// jsh에는 AbortController가 없으므로 직접 구현

/**
 * config 값을 boolean으로 변환한다.
 * true, 1, "true", "1"이면 true를 반환한다.
 * @param {boolean|number|string} value
 * @returns {boolean}
 */
function isEnabledFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

/** jsh 미제공 AbortSignal 구현 */
class AbortSignal {
  constructor() { this.aborted = false; }
}

/** jsh 미제공 AbortController 구현 */
class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  /** 신호를 abort 상태로 전환한다. */
  abort() { this.signal.aborted = true; }
}

// ─── Replicator ───────────────────────────────────────────────────────────────

/**
 * 소스→대상 복제 오케스트레이터
 *
 * discover() → syncMeta() [TAG 전용] → runWorkers() 루프를 실행한다.
 * 각 단계 실패 시 5초 후 재시도한다.
 */
class Replicator {
  /**
   * @param {object} config - ReplicatorConfig
   * @param {{ value: boolean }} [shutdownFlag] - 외부에서 종료를 요청하는 플래그
   */
  constructor(config, shutdownFlag) {
    const sourceTable = typeof config.source?.table === 'string'
      ? config.source.table.toUpperCase()
      : config.source?.table;
    const targetTable = typeof config.target?.table === 'string'
      ? config.target.table.toUpperCase()
      : (config.target?.table || sourceTable);
    const sourceColumns = Array.isArray(config.source?.columns)
      ? config.source.columns.map((c) => typeof c === 'string' ? c.toUpperCase() : c)
      : config.source?.columns;

    this.source = { ...config.source, table: sourceTable, columns: sourceColumns };
    this.target = {
      ...config.target,
      table: targetTable,
      autoCreate: isEnabledFlag(config.target?.autoCreate),
    };
    this.id             = config.id || `${sourceTable}_${targetTable}`;
    this.queryLimit       = config.queryLimit       ?? 5000;
    this.ridRangeSize     = config.ridRangeSize     ?? 50000;
    this.pollIntervalMs   = config.pollIntervalMs   ?? 1000;
    this.startMode        = config.startMode        ?? 'full';
    this.ridAfter         = config.ridAfter         ?? null;
    this.onSaveFailure    = config.onSaveFailure    ?? 'continue';
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 30000;
    this.integrity        = config.integrity        ?? null;
    this.metaSync         = config.metaSync         ?? false;
    this.retry            = config.retry            ?? null;
    this.logCtx = {
      source: `${this.source.host}:${this.source.port}/${this.source.table}`,
      target: `${this.target.host}:${this.target.port}/${this.target.table || this.source.table}`,
    };
    this.shutdownFlag = shutdownFlag || { value: false };
  }

  // ── 2. discover ─────────────────────────────────────────────────────────────

  /**
   * 소스/대상 테이블 타입·스키마·파티션 목록을 조회한다.
   * autoCreate가 활성화된 경우 대상 테이블을 자동 생성한다.
   * @returns {{ tableType: string, dataTables: string[], srcSchema: object, dstSchema: object, columnOrder: object }|null}
   *   조회 실패 또는 설정 오류 시 null을 반환한다.
   */
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
            const requiredCols = srcSchema.columns
              .filter((c) => (c.flag & FLAG_METADATA) === 0 && ((c.flag & FLAG_PRIMARY) || (c.flag & FLAG_BASETIME)))
              .map((c) => c.name);
            const missing = requiredCols.filter(c => !this.source.columns.includes(c));
            if (missing.length > 0) {
              getLogger().error('replicator', { ...this.logCtx, msg: `source.columns missing required TAG key columns: ${missing.join(', ')}, skipping` });
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

    const columnOrder = this._validateColumnOrderCompatibility(srcSchema, dstSchema);
    if (!columnOrder) {
      return null;
    }

    return { tableType, dataTables, srcSchema, dstSchema, columnOrder };
  }

  // ── 3. meta sync ────────────────────────────────────────────────────────────

  /**
   * TAG META 테이블의 이름과 메타 컬럼을 대상과 동기화한다.
   * @param {import('../db/types.js').TableSchema} srcSchema
   * @returns {true|null} 성공 시 true, 실패 시 null
   */
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

  /**
   * 파티션별 Worker를 병렬로 실행한다.
   * 한 Worker가 실패하면 AbortController를 통해 나머지를 중단한다.
   * @param {{ tableType: string, dataTables: string[], srcSchema: object, dstSchema: object, columnOrder: object }} discovered
   * @returns {Promise<boolean>} 전체 완료 시 true, 중단 시 false
   */
  async runWorkers(discovered) {
    const { tableType, dataTables, srcSchema, dstSchema, columnOrder } = discovered;

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
      columnOrder,
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

  /**
   * source.columns에 존재하지 않는 컬럼이 포함되어 있는지 검사한다.
   * @param {object} source
   * @param {import('../db/types.js').TableSchema} schema
   * @returns {boolean}
   */
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

  /**
   * 스키마에서 메타데이터 컬럼을 제외한 데이터 컬럼만 반환한다.
   * @param {import('../db/types.js').TableSchema} schema
   * @returns {import('../db/types.js').Column[]}
   */
  _dataColumns(schema) {
    return schema.columns.filter(c => !(c.flag & FLAG_METADATA));
  }

  /**
   * 소스/대상 데이터 컬럼을 순서 기준으로 타입 호환성을 검증한다.
   * @param {import('../db/types.js').TableSchema} srcSchema
   * @param {import('../db/types.js').TableSchema} dstSchema
   * @returns {{ source: string[], target: string[] }|null} 호환 시 컬럼 순서 매핑, 불일치 시 null
   */
  _validateColumnOrderCompatibility(srcSchema, dstSchema) {
    const sourceDataCols = this._dataColumns(srcSchema);
    const targetDataCols = this._dataColumns(dstSchema);

    const sourceByName = {};
    for (const col of sourceDataCols) {
      sourceByName[col.name] = col;
    }

    const sourceOrder = Array.isArray(this.source.columns) && this.source.columns.length > 0
      ? this.source.columns
      : sourceDataCols.map((c) => c.name);
    const targetOrder = targetDataCols.map((c) => c.name);

    if (sourceOrder.length !== targetOrder.length) {
      getLogger().error('replicator', {
        ...this.logCtx,
        msg: `column count mismatch by order: source(${sourceOrder.length}) != target(${targetOrder.length}), skipping`,
      });
      return null;
    }

    for (let i = 0; i < targetDataCols.length; i++) {
      const sourceName = sourceOrder[i];
      const sourceCol = sourceByName[sourceName];
      const targetCol = targetDataCols[i];
      if (!sourceCol) {
        getLogger().error('replicator', {
          ...this.logCtx,
          msg: `source column not found for order check: ${sourceName}, skipping`,
        });
        return null;
      }
      if (sourceCol.columnType !== targetCol.columnType) {
        getLogger().error('replicator', {
          ...this.logCtx,
          msg: `column type mismatch at index ${i}: source.${sourceName}(${sourceCol.sqlType()}) != target.${targetCol.name}(${targetCol.sqlType()}), skipping`,
        });
        return null;
      }
    }

    return { source: sourceOrder, target: targetOrder };
  }

  // ── 6. 메인 루프 ────────────────────────────────────────────────────────────

  /**
   * shutdownFlag를 true로 설정하여 복제 루프 종료를 요청한다.
   */
  shutdown() {
    this.shutdownFlag.value = true;
  }

  /**
   * 복제 메인 루프를 시작한다. shutdown()이 호출될 때까지 반복한다.
   * @returns {Promise<void>}
   */
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
