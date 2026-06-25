'use strict';

/**
 * @fileoverview TAG metadata sync manager for native/http targets
 *
 * 의도:
 * - native/http target은 data append 전에 metadata를 먼저 맞춰 두는 정책을 유지한다.
 * - metadata sync 진행 위치는 data partition checkpoint와 분리해서 job 단위로 관리한다.
 * - 여러 worker가 동시에 돌아도 metadata insert는 한 곳에서 직렬화하여 gap/중복 처리를 일관되게 유지한다.
 */

const { MachbaseClient } = require('../db/client.js');
const { createQueryClient, parseEpochNsLike } = require('../db/remote.js');
const { ColumnType, FLAG_METADATA, FLAG_PRIMARY, FLAG_BASETIME } = require('../db/types.js');
const RetryHandler = require('../lib/retry.js');
const { getInstance: getLogger } = require('../lib/logger.js');
const { collectReferencedColumns, matchesCondition } = require('./rules.js');
const { MetaSyncStateStore } = require('./meta-sync-state.js');
const { MetaNameMapStore } = require('./meta-name-map.js');

const META_SYNC_PAGE_SIZE = 500;
const STATE_FLUSH_INTERVAL = 100;
const META_DELTA_SYNC_INTERVAL_MS = 5000;
const META_DELTA_PAGE_SIZE = 500;

function _uniqueNames(values) {
  const seen = {};
  const result = [];
  for (const value of (values || [])) {
    if (!value || seen[value]) continue;
    seen[value] = true;
    result.push(value);
  }
  return result;
}

function _cloneCondition(condition) {
  if (!condition || typeof condition !== 'object') return null;
  return {
    column: condition.column || null,
    op: condition.op || 'ALL',
    value: Array.isArray(condition.value) ? condition.value.slice() : [],
  };
}

function _cloneRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map((rule) => ({
    criteria: rule && rule.criteria
      ? {
          column: rule.criteria.column || null,
          op: rule.criteria.op || 'ALL',
          value: Array.isArray(rule.criteria.value) ? rule.criteria.value.slice() : [],
        }
      : { column: null, op: 'ALL', value: [] },
    expr: Array.isArray(rule?.expr) ? rule.expr.map((item) => ({ ...item })) : [],
  }));
}

function _stableJson(value) {
  return JSON.stringify(value == null ? null : value);
}

function _rowValue(row, lowerName, upperName) {
  if (!row) return null;
  if (row[lowerName] !== undefined && row[lowerName] !== null) return row[lowerName];
  return row[upperName];
}

function _rowColumnValue(row, columnName) {
  if (!row || !columnName) return null;
  if (row[columnName] !== undefined && row[columnName] !== null) return row[columnName];
  const upperName = String(columnName).toUpperCase();
  if (row[upperName] !== undefined && row[upperName] !== null) return row[upperName];
  const lowerName = String(columnName).toLowerCase();
  if (row[lowerName] !== undefined && row[lowerName] !== null) return row[lowerName];
  return null;
}

function _sameColumnName(left, right) {
  return String(left || '').toUpperCase() === String(right || '').toUpperCase();
}

function _hasMetaUpdateCheckpoint(state) {
  return state
    && state.lastMetaUpdateTime != null
    && String(state.lastMetaUpdateTime).trim() !== '';
}

function _normalizeMetaUpdateTime(value) {
  if (value == null) return '';
  const parsed = parseEpochNsLike(value);
  if (typeof parsed === 'bigint') return parsed.toString();
  const text = String(parsed).trim();
  if (/^\d+$/.test(text)) return text;
  return '';
}

function _compareMetaUpdateTime(left, right) {
  const leftText = _normalizeMetaUpdateTime(left);
  const rightText = _normalizeMetaUpdateTime(right);
  if (!leftText && !rightText) return 0;
  if (!leftText) return -1;
  if (!rightText) return 1;
  const leftValue = BigInt(leftText);
  const rightValue = BigInt(rightText);
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function _isJsonColumn(column) {
  return column && column.columnType === ColumnType.JSON;
}

function _normalizeMetaValue(value, targetColumn) {
  if (value == null) return value;
  if (!_isJsonColumn(targetColumn)) return value;
  if (typeof value === 'string') {
    JSON.parse(value);
    return value;
  }
  return JSON.stringify(value);
}

function _percent(lastMetaId, goalMetaId) {
  if (goalMetaId == null || goalMetaId < 0n) return 100;
  if (goalMetaId === 0n) return lastMetaId >= 0n ? 100 : 0;
  if (lastMetaId == null || lastMetaId < 0n) return 0;
  const current = lastMetaId > goalMetaId ? goalMetaId : lastMetaId;
  const scaled = Number((current * 100n) / goalMetaId);
  if (!Number.isFinite(scaled)) return 0;
  if (scaled < 0) return 0;
  if (scaled > 100) return 100;
  return scaled;
}

function _createQueryClientForRuntime(config) {
  const type = String(config?.type || 'native').toLowerCase();
  if (type === 'native') return new MachbaseClient(config);
  const client = createQueryClient(config);
  if (!client) {
    throw new Error(`query client not supported for type '${type}'`);
  }
  return client;
}

function _extractNameTransformRules(transform, primaryColumnName) {
  const result = [];
  for (const rule of (transform || [])) {
    const expr = (rule.expr || []).filter((item) =>
      item
      && item.column === primaryColumnName
      && (item.type === 'prefix' || item.type === 'suffix')
    );
    if (expr.length === 0) continue;
    result.push({
      criteria: rule.criteria
        ? {
            column: rule.criteria.column || null,
            op: rule.criteria.op || 'ALL',
            value: Array.isArray(rule.criteria.value) ? rule.criteria.value.slice() : [],
          }
        : { column: null, op: 'ALL', value: [] },
      expr: expr.map((item) => ({ column: item.column, type: item.type, value: item.value })),
    });
  }
  return result;
}

function _applyMetadataTransformRules(baseRow, transformRules) {
  const working = { ...baseRow };
  if (!Array.isArray(transformRules) || transformRules.length === 0) {
    return { row: working, dropped: false };
  }

  for (const rule of transformRules) {
    if (!matchesCondition(baseRow, rule.criteria)) continue;
    for (const expr of (rule.expr || [])) {
      const current = working[expr.column];
      if (expr.type === 'prefix') {
        if (current != null) working[expr.column] = String(expr.value || '') + String(current);
        continue;
      }
      if (expr.type === 'suffix') {
        if (current != null) working[expr.column] = String(current) + String(expr.value || '');
        continue;
      }
      if (expr.type === 'calc') {
        if (typeof current === 'number') {
          const bias = expr.bias || 0;
          const multiplier = expr.multiplier == null ? 1 : expr.multiplier;
          if (expr.calcOrder === 'mb') {
            working[expr.column] = current * multiplier + bias;
          } else {
            working[expr.column] = (current + bias) * multiplier;
          }
        }
        continue;
      }
      // metadata sync는 rep_target_cond 기준으로만 대상을 고른다.
      // filter transform은 data row drop 규칙이므로 metadata 등록 여부에는 적용하지 않는다.
      if (expr.type === 'filter') {
        continue;
      }
    }
  }

  return { row: working, dropped: false };
}

class PagedTagMetaCursor {
  constructor(manager, repTargetCond, metaColNames, afterId, goalMetaId, pageSize) {
    this.manager = manager;
    this.repTargetCond = repTargetCond;
    this.metaColNames = metaColNames;
    this.afterId = afterId == null ? -1n : afterId;
    this.goalMetaId = goalMetaId;
    this.pageSize = pageSize;
    this.buffer = [];
    this.index = 0;
  }

  async next() {
    while (this.index >= this.buffer.length) {
      this.buffer = await this.manager._selectSourceMetaRows(
        this.repTargetCond,
        this.afterId,
        this.goalMetaId,
        this.metaColNames,
        this.pageSize
      );
      this.index = 0;
      if (!this.buffer || this.buffer.length === 0) return null;
      this.afterId = BigInt(this.buffer[this.buffer.length - 1]._ID);
    }
    return this.buffer[this.index++];
  }
}

class TagMetaSyncManager {
  constructor(config, srcSchema, dstSchema, directory, shutdownFlag) {
    this.config = config;
    this.srcSchema = srcSchema;
    this.dstSchema = dstSchema;
    this.directory = directory;
    this.shutdownFlag = shutdownFlag || { value: false };
    this.retry = new RetryHandler(config.retry || {});
    this.store = new MetaSyncStateStore(directory);
    this.nameMapStore = new MetaNameMapStore(directory);
    this.queue = Promise.resolve();
    this.sourceClient = null;
    this.targetClient = null;
    this.state = null;
    this.nameMap = { previousMetaUpdateTime: '', lastMetaUpdateTime: '', names: {} };
    this.deltaSupported = false;
    this.deltaDisabledReason = '';
    this.nextMetaDeltaCheckAt = 0;
    this.appliedChanges = [];
    this.appliedSeq = 0;
    this.nonPrimaryConditionWarned = false;
    this.plan = this._buildPlan();
  }

  static supports(config, srcSchema) {
    const targetType = String(config?.target?.type || 'native').toLowerCase();
    return !!srcSchema
      && srcSchema.tableType === 'TAG'
      && (targetType === 'native' || targetType === 'http');
  }

  _buildPlan() {
    const sourceColumns = Array.isArray(this.config.source.columns) ? this.config.source.columns.slice() : [];
    const targetColumns = Array.isArray(this.config.target.columns) ? this.config.target.columns.slice() : [];
    const sourceMeta = Array.isArray(this.config.source.meta) ? this.config.source.meta.slice() : [];
    const targetMeta = Array.isArray(this.config.target.meta) ? this.config.target.meta.slice() : [];
    const transform = Array.isArray(this.config.source.transform) ? this.config.source.transform : [];
    const repTargetCond = this.config.source.rep_target_cond || null;
    const sourcePrimaryCol = this.srcSchema.columns.find((column) => column.flag & FLAG_PRIMARY) || null;
    const targetPrimaryCol = this.dstSchema.columns.find((column) => column.flag & FLAG_PRIMARY) || null;
    const targetDataCols = this.dstSchema.columns.filter((column) => !(column.flag & FLAG_METADATA)).map((column) => column.name);
    const targetMetaColumnsByName = {};
    for (const column of this.dstSchema.columns.filter((item) => item.flag & FLAG_METADATA)) {
      targetMetaColumnsByName[column.name] = column;
    }
    const sourceMetaSchemaNames = this.srcSchema.columns.filter((column) => column.flag & FLAG_METADATA).map((column) => column.name);
    const referencedColumns = collectReferencedColumns(repTargetCond, transform);
    const metaReadCols = _uniqueNames(
      sourceMeta
        .concat(referencedColumns.filter((name) => sourceMetaSchemaNames.indexOf(name) >= 0))
    );

    if (!sourcePrimaryCol || !targetPrimaryCol) {
      throw new Error('TAG primary key column not found');
    }
    if (!this.srcSchema.columns.find((column) => column.flag & FLAG_BASETIME)) {
      throw new Error('TAG source basetime column not found');
    }

    return {
      sourceColumns,
      targetColumns,
      sourceMeta,
      targetMeta,
      targetDataCols,
      transform,
      repTargetCond,
      sourcePrimaryColName: sourcePrimaryCol.name,
      targetPrimaryColName: targetPrimaryCol.name,
      metaReadCols,
      targetMetaColumnsByName,
      nameTransformRules: _extractNameTransformRules(transform, sourcePrimaryCol.name),
    };
  }

  async open() {
    if (!this.sourceClient) {
      this.sourceClient = _createQueryClientForRuntime(this.config.source);
      await this.sourceClient.connect();
    }
    if (!this.targetClient) {
      this.targetClient = _createQueryClientForRuntime(this.config.target);
      await this.targetClient.connect();
    }
  }

  async close() {
    try { this.sourceClient && await this.sourceClient.close(); } catch (_) {}
    try { this.targetClient && await this.targetClient.close(); } catch (_) {}
    this.sourceClient = null;
    this.targetClient = null;
  }

  async _detectMetaDeltaSupport() {
    try {
      await this._selectSourceMaxMetaUpdateTime();
      this.deltaSupported = true;
      this.deltaDisabledReason = '';
      return true;
    } catch (err) {
      this.deltaSupported = false;
      this.deltaDisabledReason = err.message;
      getLogger().warn('meta_sync', {
        job_id: this.config.id,
        phase: 'meta-delta-unsupported',
        msg: `_LAST_UPDATE_TIME metadata delta sync disabled: ${err.message}`,
      });
      return false;
    }
  }

  _warnIfNonPrimaryCondition(logCtx) {
    if (this.nonPrimaryConditionWarned) return;
    const condition = this.plan.repTargetCond;
    if (!condition || !condition.op || condition.op === 'ALL') return;
    const column = condition.column || this.plan.sourcePrimaryColName;
    if (!column || _sameColumnName(column, this.plan.sourcePrimaryColName)) return;
    this.nonPrimaryConditionWarned = true;
    getLogger().warn('meta_sync', {
      ...(logCtx || {}),
      job_id: this.config.id,
      phase: 'rep-target-condition',
      condition_column: column,
      primary_column: this.plan.sourcePrimaryColName,
      msg: 'TAG rep_target_cond.column is not the source primary key. The configured column will be used as-is; this is outside the supported UI policy and may fail at runtime.',
    });
  }

  _loadNameMapForExistingState(state) {
    if (!this.deltaSupported || !_hasMetaUpdateCheckpoint(state)) {
      this.nameMap = { previousMetaUpdateTime: '', lastMetaUpdateTime: '', names: {} };
      return true;
    }
    const loaded = this.nameMapStore.load();
    if (!loaded.exists || loaded.err || !loaded.map) {
      getLogger().error('meta_sync', {
        job_id: this.config.id,
        phase: 'meta-delta-map',
        msg: 'metadata delta checkpoint exists but meta-name-map.json is missing or invalid; stopping job to protect TAG identity',
      });
      return false;
    }
    this.nameMap = loaded.map;
    if (!this._validateNameMapCheckpoint(state, this.nameMap, {})) {
      return false;
    }
    return true;
  }

  _validateNameMapCheckpoint(state, nameMap, logCtx) {
    if (!this.deltaSupported || !_hasMetaUpdateCheckpoint(state)) return true;
    const stateTime = state.lastMetaUpdateTime || '';
    const mapTime = nameMap && nameMap.lastMetaUpdateTime ? nameMap.lastMetaUpdateTime : '';
    if (_compareMetaUpdateTime(mapTime, stateTime) >= 0) return true;

    getLogger().error('meta_sync', {
      ...(logCtx || {}),
      job_id: this.config.id,
      phase: 'meta-delta-map',
      state_last_meta_update_time: stateTime,
      map_last_meta_update_time: mapTime,
      msg: 'metadata delta checkpoint is ahead of meta-name-map.json. This can lose TAG rename tracking. Stop the job and align meta-sync.json state.lastMetaUpdateTime with meta-name-map.json map.lastMetaUpdateTime, preferably by lowering meta-sync.json to the map value or restoring both files from the same backup, then restart the job.',
    });
    return false;
  }

  async _beginFullSyncDeltaCheckpoint() {
    if (!this.deltaSupported) return '';
    const highWatermark = await this._selectSourceMaxMetaUpdateTime();
    this.nameMap = {
      previousMetaUpdateTime: '',
      lastMetaUpdateTime: '',
      names: {},
    };
    return highWatermark || '0';
  }

  _completeFullSyncDeltaCheckpoint(state, highWatermark) {
    if (!this.deltaSupported) return;
    const next = highWatermark || '0';
    this.nameMap.previousMetaUpdateTime = this.nameMap.lastMetaUpdateTime || '';
    this.nameMap.lastMetaUpdateTime = next;
    state.lastMetaUpdateTime = next;
  }

  async bootstrap() {
    return this._runExclusive(async () => {
      await this.open();
      this._warnIfNonPrimaryCondition();
      const loaded = this.store.load();
      this.state = loaded.exists ? loaded.state : null;
      await this._detectMetaDeltaSupport();
      if (!this._loadNameMapForExistingState(this.state)) return false;

      const currentCond = _cloneCondition(this.plan.repTargetCond);
      const currentNameRules = _cloneRules(this.plan.nameTransformRules);
      const currentCondSig = _stableJson(currentCond);
      const currentNameSig = _stableJson(currentNameRules);
      const savedCondSig = _stableJson(this.state?.repTargetCond);
      const savedPendingCondSig = _stableJson(this.state?.pendingRepTargetCond);
      const savedNameSig = _stableJson(this.state?.nameTransformRules);

      if (!this.state || (this.deltaSupported && !_hasMetaUpdateCheckpoint(this.state))) {
        const highWatermark = await this._beginFullSyncDeltaCheckpoint();
        const maxMetaId = await this._selectSourceMaxMetaId();
        this.state = this._createState({
          status: 'initial-sync',
          message: 'initial metadata sync in progress',
          lastMetaId: -1n,
          goalMetaId: maxMetaId,
          repTargetCond: currentCond,
          nameTransformRules: currentNameRules,
        });
        return this._syncForwardRange(this.state, currentCond, maxMetaId, 'initial-sync', 'initial metadata sync in progress', null, highWatermark);
      }

      if (savedNameSig !== currentNameSig) {
        const highWatermark = await this._beginFullSyncDeltaCheckpoint();
        const maxMetaId = await this._selectSourceMaxMetaId();
        getLogger().info('meta_sync', {
          job_id: this.config.id,
          msg: 'name transform changed, restarting metadata sync from the beginning',
        });
        this.state = this._createState({
          status: 'initial-sync',
          message: 'name transform changed, restarting metadata sync',
          lastMetaId: -1n,
          goalMetaId: maxMetaId,
          repTargetCond: currentCond,
          nameTransformRules: currentNameRules,
        });
        return this._syncForwardRange(this.state, currentCond, maxMetaId, 'initial-sync', 'name transform changed, restarting metadata sync', null, highWatermark);
      }

      if (this.state.status === 'condition-diff' && savedPendingCondSig === currentCondSig) {
        const maxMetaId = await this._selectSourceMaxMetaId();
        return this._runConditionDiff(this.state, this.state.repTargetCond, currentCond, maxMetaId);
      }

      if (savedCondSig !== currentCondSig) {
        const highWatermark = await this._beginFullSyncDeltaCheckpoint();
        const maxMetaId = await this._selectSourceMaxMetaId();
        this.state = this._createState({
          status: 'condition-diff',
          message: 'condition changed, comparing metadata candidates',
          lastMetaId: -1n,
          goalMetaId: maxMetaId,
          repTargetCond: this.state.repTargetCond,
          pendingRepTargetCond: currentCond,
          nameTransformRules: currentNameRules,
        });
        return this._runConditionDiff(this.state, this.state.repTargetCond, currentCond, maxMetaId, highWatermark);
      }

      if (this.state.status === 'initial-sync') {
        const maxMetaId = await this._selectSourceMaxMetaId();
        return this._syncForwardRange(this.state, currentCond, maxMetaId, this.state.status, this.state.message || 'metadata sync resuming');
      }

      // 재시작 시 ordinary bootstrap은 metadata-only tag까지 강제로 따라잡지 않는다.
      // 설정 변화가 없으면 저장된 lastMetaId를 그대로 유지하고 ready 상태로 복귀한다.
      // 이후 더 큰 tag id를 가진 data batch가 실제로 들어올 때만 ensureUpToTagId()가 다시 전진한다.
      this.state.status = 'ready';
      this.state.message = 'metadata sync ready';
      this.state.progress = 100;
      this.state.goalMetaId = this.state.lastMetaId;
      this.state.repTargetCond = currentCond;
      this.state.pendingRepTargetCond = null;
      this.state.nameTransformRules = currentNameRules;
      this._saveState(this.state);
      getLogger().info('meta_sync', {
        job_id: this.config.id,
        lastMetaId: this.state.lastMetaId >= 0n ? this.state.lastMetaId.toString() : '',
        msg: 'metadata bootstrap skipped on restart; runtime sync remains data-driven',
      });
      return true;
    });
  }

  async ensureUpToTagId(tagId, logCtx) {
    if (tagId == null) return true;
    const goalMetaId = BigInt(tagId);
    return this._runExclusive(async () => {
      await this.open();
      if (!this.state) {
        const loaded = this.store.load();
        this.state = loaded.exists ? loaded.state : this._createState({
          status: 'steady-sync',
          message: 'metadata sync state initialized',
          lastMetaId: -1n,
          goalMetaId,
          repTargetCond: _cloneCondition(this.plan.repTargetCond),
          nameTransformRules: _cloneRules(this.plan.nameTransformRules),
        });
      }
      if (goalMetaId <= this.state.lastMetaId) return true;
      this.state.status = 'steady-sync';
      // runtime metadata sync는 현재 batch가 실제로 참조한 tag id 범위까지만 전진한다.
      // data가 없는 meta-only tag는 다음에 해당 tag data가 들어올 때 함께 따라오게 둔다.
      this.state.message = 'metadata catch-up in progress';
      this.state.goalMetaId = goalMetaId;
      this.state.repTargetCond = _cloneCondition(this.plan.repTargetCond);
      this.state.pendingRepTargetCond = null;
      this.state.nameTransformRules = _cloneRules(this.plan.nameTransformRules);
      return this._syncForwardRange(this.state, this.plan.repTargetCond, goalMetaId, 'steady-sync', 'metadata catch-up in progress', logCtx);
    });
  }

  _runExclusive(fn) {
    const run = this.queue.then(() => fn());
    this.queue = run.catch(() => {});
    return run;
  }

  _createState(fields) {
    const now = new Date().toISOString();
    const state = {
      status: fields.status || 'ready',
      message: fields.message || '',
      progress: 0,
      lastMetaId: fields.lastMetaId == null ? -1n : BigInt(fields.lastMetaId),
      goalMetaId: fields.goalMetaId == null ? -1n : BigInt(fields.goalMetaId),
      repTargetCond: _cloneCondition(fields.repTargetCond),
      pendingRepTargetCond: _cloneCondition(fields.pendingRepTargetCond),
      nameTransformRules: _cloneRules(fields.nameTransformRules),
      lastMetaUpdateTime: fields.lastMetaUpdateTime == null ? '' : String(fields.lastMetaUpdateTime).trim(),
      startedAt: now,
      updatedAt: now,
    };
    state.progress = state.status === 'ready' ? 100 : _percent(state.lastMetaId, state.goalMetaId);
    this._saveState(state);
    return state;
  }

  _saveState(state) {
    state.updatedAt = new Date().toISOString();
    state.progress = state.status === 'ready' ? 100 : _percent(state.lastMetaId, state.goalMetaId);
    const err = this.store.save(state);
    if (err) throw err;
    this.state = state;
  }

  _saveNameMap() {
    const err = this.nameMapStore.save(this.nameMap);
    if (err) throw err;
  }

  _rememberSourceName(sourceId, sourceName) {
    if (!this.deltaSupported || sourceId == null || sourceName == null) return;
    this.nameMap.names[String(sourceId)] = String(sourceName);
  }

  _forgetSourceName(sourceId) {
    if (!this.deltaSupported || !this.nameMap || !this.nameMap.names || sourceId == null) return;
    delete this.nameMap.names[String(sourceId)];
  }

  _getRememberedSourceName(sourceId) {
    if (!this.nameMap || !this.nameMap.names || sourceId == null) return null;
    const value = this.nameMap.names[String(sourceId)];
    return value == null ? null : String(value);
  }

  _matchesCurrentReplicationCondition(metaRow, sourceName) {
    const condition = this.plan.repTargetCond;
    if (!condition || !condition.op || condition.op === 'ALL') return true;

    const column = condition.column || this.plan.sourcePrimaryColName;
    const row = {};
    row[this.plan.sourcePrimaryColName] = sourceName;
    row[String(this.plan.sourcePrimaryColName).toUpperCase()] = sourceName;
    row[String(this.plan.sourcePrimaryColName).toLowerCase()] = sourceName;
    for (const col of this.plan.metaReadCols) {
      row[col] = metaRow[col];
    }
    if (column && row[column] === undefined) {
      row[column] = _rowColumnValue(metaRow, column);
    }
    return matchesCondition(row, {
      column,
      op: condition.op,
      value: Array.isArray(condition.value) ? condition.value.slice() : [],
    });
  }

  async _selectSourceMaxMetaId() {
    const rows = await this.sourceClient.query(
      `SELECT MAX(_ID) as max_id FROM ${this.sourceClient.qualifiedTagMetaTable(this.config.source.table)}`
    );
    const raw = rows?.[0]?.max_id;
    return raw == null ? -1n : BigInt(raw);
  }

  async _selectSourceMaxMetaUpdateTime() {
    const rows = await this.sourceClient.query(
      `SELECT MAX(_LAST_UPDATE_TIME) as max_time FROM ${this.sourceClient.qualifiedTagMetaTable(this.config.source.table)}`
    );
    const raw = _rowValue(rows && rows[0], 'max_time', 'MAX_TIME');
    return _normalizeMetaUpdateTime(raw) || '0';
  }

  _buildMetaQuery(repTargetCond, afterId, goalMetaId, metaColNames, limit) {
    const extraCols = Array.isArray(metaColNames) && metaColNames.length > 0 ? ', ' + metaColNames.join(', ') : '';
    const primaryColumn = this.plan.sourcePrimaryColName;
    const conditionColumn = repTargetCond && repTargetCond.column ? repTargetCond.column : primaryColumn;
    const where = [];
    const params = [];

    if (repTargetCond && repTargetCond.op && repTargetCond.op !== 'ALL') {
      const values = Array.isArray(repTargetCond.value) ? repTargetCond.value : [];
      if (repTargetCond.op === 'IN') {
        where.push(`${conditionColumn} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values);
      } else if (repTargetCond.op === 'LIKE') {
        where.push(`${conditionColumn} LIKE ?`);
        params.push(values[0]);
      }
    }
    if (afterId != null && afterId >= 0n) {
      where.push(`_ID > ${afterId.toString()}`);
    }
    if (goalMetaId != null && goalMetaId >= 0n) {
      where.push(`_ID <= ${goalMetaId.toString()}`);
    }

    const sql = `SELECT _ID, ${primaryColumn}${extraCols} FROM ${this.sourceClient.qualifiedTagMetaTable(this.config.source.table)}`
      + (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '')
      + ` ORDER BY _ID LIMIT ${limit}`;
    return { sql, params };
  }

  async _selectSourceMetaRows(repTargetCond, afterId, goalMetaId, metaColNames, limit) {
    const query = this._buildMetaQuery(repTargetCond, afterId, goalMetaId, metaColNames, limit);
    const rows = await this.sourceClient.query(query.sql, query.params);
    return this._normalizeSourceMetaRows(rows);
  }

  _buildMetaDeltaQuery(_repTargetCond, afterUpdateTime, metaColNames, limit) {
    const extraCols = Array.isArray(metaColNames) && metaColNames.length > 0 ? ', ' + metaColNames.join(', ') : '';
    const primaryColumn = this.plan.sourcePrimaryColName;
    const where = [];
    const params = [];

    const last = _normalizeMetaUpdateTime(afterUpdateTime) || '0';
    where.push(`_LAST_UPDATE_TIME > ${last}`);

    const sql = `SELECT _ID, ${primaryColumn}${extraCols}, _LAST_UPDATE_TIME FROM ${this.sourceClient.qualifiedTagMetaTable(this.config.source.table)}`
      + ` WHERE ${where.join(' AND ')}`
      + ` ORDER BY _LAST_UPDATE_TIME ASC LIMIT ${limit}`;
    return { sql, params };
  }

  _normalizeSourceMetaRows(rows) {
    for (const row of (rows || [])) {
      if (row._ID == null && row._id != null) row._ID = row._id;
      const primaryValue = _rowColumnValue(row, this.plan.sourcePrimaryColName);
      if (primaryValue != null) row.NAME = primaryValue;
    }
    return rows || [];
  }

  async _selectSourceMetaDeltaRows(repTargetCond, afterUpdateTime, metaColNames, limit) {
    const query = this._buildMetaDeltaQuery(repTargetCond, afterUpdateTime, metaColNames, limit);
    const rows = await this.sourceClient.query(query.sql, query.params);
    this._normalizeSourceMetaRows(rows);
    for (const row of (rows || [])) {
      row._LAST_UPDATE_TIME = _normalizeMetaUpdateTime(
        _rowValue(row, '_last_update_time', '_LAST_UPDATE_TIME')
      );
    }
    return rows || [];
  }

  _buildTargetRow(sourceRow) {
    const out = {};
    for (const name of this.plan.targetDataCols) {
      out[name] = null;
    }
    for (let i = 0; i < this.plan.targetColumns.length; i++) {
      const targetName = this.plan.targetColumns[i];
      if (!targetName) continue;
      const sourceName = this.plan.sourceColumns[i];
      out[targetName] = sourceName ? sourceRow[sourceName] : null;
    }
    return out;
  }

  _buildTargetMetaValues(sourceRow) {
    const values = [];
    for (let i = 0; i < this.plan.targetMeta.length; i++) {
      const targetName = this.plan.targetMeta[i];
      if (!targetName) continue;
      const sourceName = this.plan.sourceMeta[i];
      const targetColumn = this.plan.targetMetaColumnsByName[targetName] || null;
      values.push(sourceName ? _normalizeMetaValue(sourceRow[sourceName], targetColumn) : null);
    }
    return values;
  }

  _buildTargetMetaSets(sourceRow) {
    const sets = [];
    for (let i = 0; i < this.plan.targetMeta.length; i++) {
      const targetName = this.plan.targetMeta[i];
      if (!targetName) continue;
      const sourceName = this.plan.sourceMeta[i];
      const targetColumn = this.plan.targetMetaColumnsByName[targetName] || null;
      sets.push({
        name: targetName,
        value: sourceName ? _normalizeMetaValue(sourceRow[sourceName], targetColumn) : null,
      });
    }
    return sets;
  }

  _buildMetadataRecordForSourceName(metaRow, sourceName) {
    const sourceRow = {};
    sourceRow[this.plan.sourcePrimaryColName] = sourceName;
    for (const col of this.plan.metaReadCols) {
      sourceRow[col] = metaRow[col];
    }
    const transformed = _applyMetadataTransformRules(sourceRow, this.plan.transform);
    const targetRow = this._buildTargetRow(transformed.row);
    const name = targetRow[this.plan.targetPrimaryColName];
    if (name == null) return null;
    return {
      sourceId: BigInt(metaRow._ID),
      sourceName,
      name,
      values: this._buildTargetMetaValues(transformed.row),
      sets: this._buildTargetMetaSets(transformed.row),
      sourceMeta: this._buildSourceMetaObject(metaRow),
      lastMetaUpdateTime: _normalizeMetaUpdateTime(metaRow._LAST_UPDATE_TIME),
    };
  }

  _buildSourceMetaObject(metaRow) {
    const meta = {};
    for (const col of this.plan.metaReadCols) {
      meta[col] = metaRow[col];
    }
    return meta;
  }

  _buildMetadataRecord(metaRow) {
    const sourceName = _rowColumnValue(metaRow, this.plan.sourcePrimaryColName)
      ?? metaRow.NAME
      ?? metaRow.name;
    return this._buildMetadataRecordForSourceName(metaRow, sourceName);
  }

  async _targetMetaExists(name) {
    const rows = await this.targetClient.query(
      `SELECT _ID, ${this.plan.targetPrimaryColName} FROM ${this.targetClient.qualifiedTagMetaTable(this.config.target.table)} WHERE ${this.plan.targetPrimaryColName} = ?`,
      [name]
    );
    return !!(rows && rows[0]);
  }

  async _targetMetaUpdate(oldName, sets) {
    if (!Array.isArray(sets) || sets.length === 0) return;
    await this.targetClient.updateTagMeta(this.config.target.table, oldName, sets, this.plan.targetPrimaryColName);
  }

  async _applyMetadataUpdateRecord(oldRecord, newRecord, logCtx, phase) {
    const oldName = oldRecord ? oldRecord.name : null;
    const newName = newRecord.name;
    const rename = oldName != null && oldName !== newName;
    const sets = newRecord.sets.slice();
    if (rename) {
      sets.unshift({ name: this.plan.targetPrimaryColName, value: newName });
    }

    if (rename && await this._targetMetaExists(newName)) {
      getLogger().warn('meta_sync', {
        ...logCtx,
        phase,
        source_id: newRecord.sourceId.toString(),
        old_target_name: oldName || '',
        new_target_name: newName,
        msg: 'target metadata new name already exists; using new name and leaving old target metadata unchanged',
      });
      await this._targetMetaUpdate(newName, newRecord.sets);
      return { applied: true, usedName: newName, renamed: true, alreadyNew: true };
    }

    if (oldName && await this._targetMetaExists(oldName)) {
      await this._targetMetaUpdate(oldName, sets);
      return { applied: true, usedName: oldName, renamed: rename, alreadyNew: false };
    }

    if (await this._targetMetaExists(newName)) {
      getLogger().warn('meta_sync', {
        ...logCtx,
        phase,
        source_id: newRecord.sourceId.toString(),
        old_target_name: oldName || '',
        new_target_name: newName,
        msg: 'target metadata old name not found but new name already exists; keeping new name',
      });
      await this._targetMetaUpdate(newName, newRecord.sets);
      return { applied: true, usedName: newName, renamed: rename, alreadyNew: true };
    }

    await this.targetClient.insertTagMeta(this.config.target.table, [newName].concat(newRecord.values));
    getLogger().warn('meta_sync', {
      ...logCtx,
      phase,
      source_id: newRecord.sourceId.toString(),
      old_target_name: oldName || '',
      new_target_name: newName,
      msg: 'target metadata was missing; inserted metadata row during delta sync',
    });
    return { applied: true, usedName: newName, renamed: rename, inserted: true };
  }

  async _insertMetadataRecord(record, logCtx, phase) {
    let attempt = 0;
    while (true) {
      if (this.shutdownFlag.value) return false;
      if (attempt > 0) {
        if (this.retry.isExhausted(attempt)) {
          getLogger().error('meta_sync', {
            ...logCtx,
            phase,
            tag_name: record.name,
            msg: 'metadata insert retry exhausted',
          });
          return false;
        }
        const delay = this.retry.nextDelay(attempt - 1);
        getLogger().warn('meta_sync', {
          ...logCtx,
          phase,
          tag_name: record.name,
          attempt,
          msg: `metadata insert retry, delay=${delay}ms`,
        });
        const signal = await this.retry.sleepOrShutdown(delay, this.shutdownFlag);
        if (signal === 'shutdown') return false;
      }

      try {
        await this.targetClient.insertTagMeta(this.config.target.table, [record.name].concat(record.values));
        return true;
      } catch (err) {
        try {
          if (await this._targetMetaExists(record.name)) {
            getLogger().warn('meta_sync', {
              ...logCtx,
              phase,
              tag_name: record.name,
              source_id: record.sourceId.toString(),
              msg: `metadata already exists in target, keeping existing row: ${err.message}`,
            });
            return true;
          }
        } catch (existsErr) {
          if (!this.retry.shouldRetry(err) && !this.retry.shouldRetry(existsErr)) {
            getLogger().error('meta_sync', {
              ...logCtx,
              phase,
              tag_name: record.name,
              msg: `metadata insert failed and existence check failed: ${err.message} / ${existsErr.message}`,
            });
            return false;
          }
        }

        if (!this.retry.shouldRetry(err)) {
          getLogger().error('meta_sync', {
            ...logCtx,
            phase,
            tag_name: record.name,
            msg: `metadata insert failed: ${err.message}`,
          });
          return false;
        }
        attempt++;
      }
    }
  }

  async _updateMetadataRecordWithRetry(oldRecord, newRecord, logCtx, phase) {
    let attempt = 0;
    const maxAttempts = this.retry.maxAttempts == null ? 1 : this.retry.maxAttempts;
    while (true) {
      if (this.shutdownFlag.value) return false;
      if (attempt > 0) {
        if (attempt >= maxAttempts) {
          getLogger().error('meta_sync', {
            ...logCtx,
            phase,
            source_id: newRecord.sourceId.toString(),
            old_source_name: oldRecord ? oldRecord.sourceName : '',
            new_source_name: newRecord.sourceName,
            old_target_name: oldRecord ? oldRecord.name : '',
            new_target_name: newRecord.name,
            last_meta_update_time: newRecord.lastMetaUpdateTime || '',
            msg: 'metadata update retry exhausted',
          });
          return false;
        }
        const delay = this.retry.nextDelay(attempt - 1);
        getLogger().warn('meta_sync', {
          ...logCtx,
          phase,
          source_id: newRecord.sourceId.toString(),
          old_source_name: oldRecord ? oldRecord.sourceName : '',
          new_source_name: newRecord.sourceName,
          old_target_name: oldRecord ? oldRecord.name : '',
          new_target_name: newRecord.name,
          attempt,
          msg: `metadata update retry, delay=${delay}ms`,
        });
        const signal = await this.retry.sleepOrShutdown(delay, this.shutdownFlag);
        if (signal === 'shutdown') return false;
      }

      try {
        await this._applyMetadataUpdateRecord(oldRecord, newRecord, logCtx, phase);
        return true;
      } catch (err) {
        if (!this.retry.shouldRetry(err)) {
          getLogger().error('meta_sync', {
            ...logCtx,
            phase,
            source_id: newRecord.sourceId.toString(),
            old_source_name: oldRecord ? oldRecord.sourceName : '',
            new_source_name: newRecord.sourceName,
            old_target_name: oldRecord ? oldRecord.name : '',
            new_target_name: newRecord.name,
            last_meta_update_time: newRecord.lastMetaUpdateTime || '',
            msg: `metadata update failed: ${err.message}`,
          });
          return false;
        }
        attempt++;
      }
    }
  }

  _recordAppliedChange(record) {
    this.appliedSeq += 1;
    this.appliedChanges.push({
      seq: this.appliedSeq,
      sourceId: record.sourceId.toString(),
      sourceName: record.sourceName,
      meta: record.sourceMeta || {},
    });
  }

  applyTagMetaUpdatesSince(srcTable, lastSeq) {
    if (!srcTable || typeof srcTable.applyTagMetaUpdates !== 'function') {
      return lastSeq || this.appliedSeq;
    }
    const since = Number(lastSeq || 0);
    const changes = this.appliedChanges.filter((item) => item.seq > since);
    if (changes.length > 0) {
      srcTable.applyTagMetaUpdates(changes);
    }
    return this.appliedSeq;
  }

  async runMetaDeltaSyncIfDue(logCtx = null) {
    if (!this.deltaSupported) return true;
    const now = Date.now();
    if (this.nextMetaDeltaCheckAt > 0 && now < this.nextMetaDeltaCheckAt) {
      return true;
    }
    this.nextMetaDeltaCheckAt = now + META_DELTA_SYNC_INTERVAL_MS;
    return this._runExclusive(async () => {
      try {
        await this.open();
        if (!this.state) {
          const loaded = this.store.load();
          this.state = loaded.exists ? loaded.state : null;
        }
        if (!this.state || !_hasMetaUpdateCheckpoint(this.state)) return true;
        const loaded = this.nameMapStore.load();
        if (!loaded.exists || loaded.err || !loaded.map) {
          getLogger().error('meta_sync', {
            ...(logCtx || {}),
            job_id: this.config.id,
            phase: 'meta-delta-map',
            msg: 'metadata delta checkpoint exists but meta-name-map.json is missing or invalid; stopping job to protect TAG identity',
          });
          return false;
        }
        this.nameMap = loaded.map;
        if (!this._validateNameMapCheckpoint(this.state, this.nameMap, logCtx || {})) {
          return false;
        }
        const result = await this._syncMetaDeltaPage(logCtx || {});
        if (result && result.fullPage) {
          this.nextMetaDeltaCheckAt = 0;
        }
        return true;
      } catch (err) {
        getLogger().error('meta_sync', {
          ...(logCtx || {}),
          job_id: this.config.id,
          phase: 'meta-delta',
          msg: `metadata delta sync failed: ${err.message}`,
        });
        return false;
      }
    });
  }

  async _syncMetaDeltaPage(logCtx) {
    const ctx = {
      job_id: this.config.id,
      target: `${this.config.target.host}:${this.config.target.port}/${this.config.target.table}`,
      ...(logCtx || {}),
    };
    const lastCheckpoint = this.state.lastMetaUpdateTime || '0';
    const rows = await this._selectSourceMetaDeltaRows(
      this.plan.repTargetCond,
      lastCheckpoint,
      this.plan.metaReadCols,
      META_DELTA_PAGE_SIZE
    );
    if (!rows || rows.length === 0) {
      return { ok: true, fullPage: false };
    }

    let applied = 0;
    let skipped = 0;
    let removed = 0;
    let lastProcessedTime = '';
    for (const row of rows) {
      if (this.shutdownFlag.value) return { ok: false, fullPage: false };

      let newRecord;
      let oldRecord = null;
      let shouldKeepInMap = false;
      let shouldRemoveFromMap = false;
      try {
        const sourceId = BigInt(row._ID);
        const sourceName = _rowColumnValue(row, this.plan.sourcePrimaryColName)
          ?? row.NAME
          ?? row.name;
        const rememberedName = this._getRememberedSourceName(sourceId);
        const knownById = rememberedName != null;
        const matchesNow = this._matchesCurrentReplicationCondition(row, sourceName);
        shouldKeepInMap = matchesNow;
        shouldRemoveFromMap = knownById && !matchesNow;
        if (!knownById && !matchesNow) {
          lastProcessedTime = _normalizeMetaUpdateTime(row._LAST_UPDATE_TIME);
          skipped++;
          continue;
        }

        newRecord = this._buildMetadataRecord(row);
        if (!newRecord) {
          lastProcessedTime = _normalizeMetaUpdateTime(row._LAST_UPDATE_TIME);
          continue;
        }
        if (knownById) {
          oldRecord = this._buildMetadataRecordForSourceName(row, rememberedName);
        }
      } catch (err) {
        getLogger().error('meta_sync', {
          ...ctx,
          phase: 'meta-delta-build',
          source_id: row && row._ID != null ? String(row._ID) : '',
          last_meta_update_time: _normalizeMetaUpdateTime(row && row._LAST_UPDATE_TIME),
          msg: `metadata delta row build failed: ${err.message}`,
        });
        break;
      }

      const ok = await this._updateMetadataRecordWithRetry(oldRecord, newRecord, ctx, 'meta-delta-update');
      if (!ok) break;

      if (shouldKeepInMap) {
        this._rememberSourceName(newRecord.sourceId, newRecord.sourceName);
      } else if (shouldRemoveFromMap) {
        this._forgetSourceName(newRecord.sourceId);
        removed++;
      }
      this._recordAppliedChange(newRecord);
      lastProcessedTime = newRecord.lastMetaUpdateTime || _normalizeMetaUpdateTime(row._LAST_UPDATE_TIME);
      applied++;
    }

    if (lastProcessedTime) {
      this.nameMap.previousMetaUpdateTime = this.nameMap.lastMetaUpdateTime || '';
      this.nameMap.lastMetaUpdateTime = lastProcessedTime;
      this.state.lastMetaUpdateTime = lastProcessedTime;
      this._saveNameMap();
      this._saveState(this.state);
    }

    if (applied > 0 || skipped > 0) {
      getLogger().info('meta_sync', {
        ...ctx,
        phase: 'meta-delta-update',
        applied,
        skipped,
        removed,
        lastMetaUpdateTime: this.state.lastMetaUpdateTime || '',
        msg: 'metadata delta sync processed',
      });
    }
    return { ok: true, fullPage: rows.length >= META_DELTA_PAGE_SIZE };
  }

  async _syncForwardRange(state, repTargetCond, goalMetaId, status, message, logCtx = null, deltaHighWatermark = '') {
    const ctx = {
      job_id: this.config.id,
      target: `${this.config.target.host}:${this.config.target.port}/${this.config.target.table}`,
      ...(logCtx || {}),
    };

    state.status = status;
    state.message = message;
    state.goalMetaId = goalMetaId;
    state.repTargetCond = _cloneCondition(repTargetCond);
    state.pendingRepTargetCond = null;
    state.nameTransformRules = _cloneRules(this.plan.nameTransformRules);
    this._saveState(state);

    if (goalMetaId < 0n || goalMetaId <= state.lastMetaId) {
      if (goalMetaId > state.lastMetaId) {
        state.lastMetaId = goalMetaId;
      }
      state.status = 'ready';
      state.message = 'metadata sync ready';
      this._completeFullSyncDeltaCheckpoint(state, deltaHighWatermark);
      if (this.deltaSupported) {
        this._saveNameMap();
      }
      this._saveState(state);
      return true;
    }

    let cursorId = state.lastMetaId;
    let inserted = 0;
    while (!this.shutdownFlag.value) {
      const rows = await this._selectSourceMetaRows(
        repTargetCond,
        cursorId,
        goalMetaId,
        this.plan.metaReadCols,
        META_SYNC_PAGE_SIZE
      );
      if (!rows || rows.length === 0) {
        state.lastMetaId = goalMetaId;
        state.status = 'ready';
        state.message = 'metadata sync ready';
        this._completeFullSyncDeltaCheckpoint(state, deltaHighWatermark);
        if (this.deltaSupported) {
          this._saveNameMap();
        }
        this._saveState(state);
        getLogger().info('meta_sync', {
          ...ctx,
          phase: status,
          goalMetaId: goalMetaId.toString(),
          inserted,
          msg: 'metadata range sync completed',
        });
        return true;
      }

      for (const row of rows) {
        if (this.shutdownFlag.value) return false;
        const record = this._buildMetadataRecord(row);
        if (record && !(await this._insertMetadataRecord(record, ctx, status))) {
          return false;
        }
        if (record) {
          this._rememberSourceName(record.sourceId, record.sourceName);
          inserted++;
        }
        cursorId = BigInt(row._ID);
        state.lastMetaId = cursorId;
      }
      if (this.deltaSupported) {
        this._saveNameMap();
      }
      this._saveState(state);
    }

    return false;
  }

  async _runConditionDiff(state, baseCond, currentCond, goalMetaId, deltaHighWatermark = '') {
    const ctx = {
      job_id: this.config.id,
      target: `${this.config.target.host}:${this.config.target.port}/${this.config.target.table}`,
    };

    state.status = 'condition-diff';
    state.message = 'condition changed, comparing metadata candidates';
    state.goalMetaId = goalMetaId;
    state.pendingRepTargetCond = _cloneCondition(currentCond);
    state.nameTransformRules = _cloneRules(this.plan.nameTransformRules);
    this._saveState(state);

    if (goalMetaId < 0n) {
      state.lastMetaId = goalMetaId;
      state.repTargetCond = _cloneCondition(currentCond);
      state.pendingRepTargetCond = null;
      state.status = 'ready';
      state.message = 'metadata sync ready';
      this._completeFullSyncDeltaCheckpoint(state, deltaHighWatermark);
      if (this.deltaSupported) {
        this._saveNameMap();
      }
      this._saveState(state);
      return true;
    }

    const oldCursor = new PagedTagMetaCursor(this, baseCond, [], state.lastMetaId, goalMetaId, META_SYNC_PAGE_SIZE);
    const newCursor = new PagedTagMetaCursor(this, currentCond, this.plan.metaReadCols, state.lastMetaId, goalMetaId, META_SYNC_PAGE_SIZE);

    let oldRow = await oldCursor.next();
    let newRow = await newCursor.next();
    let inserted = 0;
    let dirty = 0;

    while (newRow && !this.shutdownFlag.value) {
      const newId = BigInt(newRow._ID);
      while (oldRow && BigInt(oldRow._ID) < newId) {
        state.lastMetaId = BigInt(oldRow._ID);
        oldRow = await oldCursor.next();
      }

      if (!oldRow || BigInt(oldRow._ID) > newId) {
        const record = this._buildMetadataRecord(newRow);
        if (record && !(await this._insertMetadataRecord(record, ctx, 'condition-diff'))) {
          return false;
        }
        if (record) {
          this._rememberSourceName(record.sourceId, record.sourceName);
          inserted++;
        }
      } else {
        const record = this._buildMetadataRecord(newRow);
        if (record) {
          this._rememberSourceName(record.sourceId, record.sourceName);
        }
        oldRow = await oldCursor.next();
      }

      state.lastMetaId = newId;
      dirty++;
      if (dirty >= STATE_FLUSH_INTERVAL) {
        this._saveState(state);
        dirty = 0;
      }
      newRow = await newCursor.next();
    }

    if (this.shutdownFlag.value) return false;

    state.lastMetaId = goalMetaId;
    state.repTargetCond = _cloneCondition(currentCond);
    state.pendingRepTargetCond = null;
    state.status = 'ready';
    state.message = 'metadata sync ready';
    this._completeFullSyncDeltaCheckpoint(state, deltaHighWatermark);
    if (this.deltaSupported) {
      this._saveNameMap();
    }
    this._saveState(state);

    getLogger().info('meta_sync', {
      ...ctx,
      goalMetaId: goalMetaId.toString(),
      inserted,
      msg: 'metadata condition diff completed',
    });
    return true;
  }
}

module.exports = { TagMetaSyncManager };
