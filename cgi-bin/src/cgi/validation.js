'use strict';

const { MachbaseClient, ColumnType } = require('../db/client.js');
const { createQueryClient } = require('../db/remote.js');
const { FLAG_METADATA, FLAG_PRIMARY, FLAG_BASETIME, FLAG_SUMMARIZED } = require('../db/types.js');
const {
  isObject,
  normalizeColumnName,
  normalizeReplicatorConfigForSave,
  normalizeServerProfileForSave,
  resolveReplicatorRuntimeConfig,
} = require('./config.js');

const NUMERIC_TYPES = new Set([
  ColumnType.SHORT, ColumnType.USHORT,
  ColumnType.INTEGER, ColumnType.UINTEGER,
  ColumnType.LONG, ColumnType.ULONG,
  ColumnType.FLOAT, ColumnType.DOUBLE,
]);

const VALID_START_MODES = { full: true, now: true, ridAfter: true };
const VALID_LOG_LEVELS = { trace: true, debug: true, info: true, warn: true, error: true };

const STRING_LIKE_TYPES = new Set([
  ColumnType.VARCHAR,
  ColumnType.TEXT,
  ColumnType.CLOB,
]);

function _isNumericType(code) {
  return NUMERIC_TYPES.has(ColumnType.fromCode(code));
}

function _isStringLikeType(code) {
  return STRING_LIKE_TYPES.has(ColumnType.fromCode(code));
}

function _isVarcharType(code) {
  return ColumnType.fromCode(code) === ColumnType.VARCHAR;
}

function _normalizeMappingArray(value, defaultValue) {
  if (!Array.isArray(value)) return defaultValue.slice();
  return value.map((item) => normalizeColumnName(item));
}

function _parseSafeInteger(value, label, options = {}) {
  const { min = null, allowNull = false } = options;
  if (value == null || value === '') {
    if (allowNull) return null;
    throw new Error(`${label} is required`);
  }
  const num = Number(value);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`${label} must be an integer`);
  }
  if (min !== null && num < min) {
    throw new Error(`${label} must be >= ${min}`);
  }
  return num;
}

/**
 * 파일에 저장되는 runtime 옵션의 형식과 상호 제약을 먼저 정리한다.
 *
 * 의도:
 * - DB 연결 전 단계에서 시작 모드와 재시도/로그 설정의 명백한 오류를 제거한다.
 * - 내부 기본값과 persisted user 값의 경계를 여기서 고정해 downstream 로직을 단순화한다.
 */
function _validateRuntimeOptions(storedConfig) {
  const startMode = storedConfig.startMode == null || storedConfig.startMode === ''
    ? 'full'
    : String(storedConfig.startMode).trim();
  if (!VALID_START_MODES[startMode]) {
    throw new Error(`startMode '${storedConfig.startMode}' is not supported`);
  }
  if (storedConfig.startMode != null && storedConfig.startMode !== '') {
    storedConfig.startMode = startMode;
  }

  if (startMode === 'ridAfter') {
    if (storedConfig.ridAfter == null || storedConfig.ridAfter === '') {
      throw new Error('ridAfter is required when startMode is ridAfter');
    }
    let ridAfter;
    try {
      ridAfter = BigInt(storedConfig.ridAfter);
    } catch (_) {
      throw new Error('ridAfter must be an integer');
    }
    if (ridAfter < 0n) {
      throw new Error('ridAfter must be >= 0');
    }
  }

  if (storedConfig.queryLimit !== undefined) {
    storedConfig.queryLimit = _parseSafeInteger(storedConfig.queryLimit, 'queryLimit', { min: 1 });
  }
  if (storedConfig.pollIntervalMs !== undefined) {
    storedConfig.pollIntervalMs = _parseSafeInteger(storedConfig.pollIntervalMs, 'pollIntervalMs', { min: 0 });
  }
  if (storedConfig.shutdownTimeoutMs !== undefined) {
    storedConfig.shutdownTimeoutMs = _parseSafeInteger(storedConfig.shutdownTimeoutMs, 'shutdownTimeoutMs', { min: 1 });
  }

  if (storedConfig.retry !== undefined && storedConfig.retry !== null) {
    if (!isObject(storedConfig.retry)) {
      throw new Error('retry must be an object');
    }
    const retry = { ...storedConfig.retry };
    if (retry.maxAttempts !== undefined) {
      retry.maxAttempts = _parseSafeInteger(retry.maxAttempts, 'retry.maxAttempts', { min: 0, allowNull: true });
    }
    if (retry.baseDelayMs !== undefined) {
      retry.baseDelayMs = _parseSafeInteger(retry.baseDelayMs, 'retry.baseDelayMs', { min: 0 });
    }
    if (retry.maxDelayMs !== undefined) {
      retry.maxDelayMs = _parseSafeInteger(retry.maxDelayMs, 'retry.maxDelayMs', { min: 0 });
    }
    const effectiveBaseDelay = retry.baseDelayMs !== undefined ? retry.baseDelayMs : 1000;
    const effectiveMaxDelay = retry.maxDelayMs !== undefined ? retry.maxDelayMs : 60000;
    if (effectiveMaxDelay < effectiveBaseDelay) {
      throw new Error('retry.maxDelayMs must be >= retry.baseDelayMs');
    }
    storedConfig.retry = retry;
  }

  if (storedConfig.logging !== undefined && storedConfig.logging !== null) {
    if (!isObject(storedConfig.logging)) {
      throw new Error('logging must be an object');
    }
    const logging = { ...storedConfig.logging };
    if (!VALID_LOG_LEVELS[logging.level]) {
      throw new Error(`logging.level '${logging.level}' is not supported`);
    }
    logging.maxFiles = _parseSafeInteger(logging.maxFiles, 'logging.maxFiles', { min: 1 });
    storedConfig.logging = logging;
  }
}

/**
 * source/target schema 조회에 필요한 query-capable client만 연다.
 *
 * 의도:
 * - validation/discover 단계에서는 실제 query가 가능한 transport만 허용한다.
 * - mqtt-api/mqtt-publish는 현재 source로 사용할 수 없는 정책이므로 초기에 차단한다.
 *
 * 주의:
 * - 새 transport를 추가할 때는 "query는 되지만 source는 금지"인지 여부를 여기서 함께 결정해야 한다.
 */
async function _openQueryClient(endpoint, side) {
  const type = String(endpoint?.type || 'native').toLowerCase();
  if (type === 'mqtt-api' && side === 'source') {
    throw new Error(`${side}.type 'mqtt-api' is not supported`);
  }
  if (type === 'mqtt-publish' && side === 'source') {
    throw new Error(`${side}.type 'mqtt-publish' is not supported`);
  }
  const client = type === 'native' ? new MachbaseClient(endpoint) : createQueryClient(endpoint);
  if (!client) {
    throw new Error(`${side}.type '${type}' does not support query operations`);
  }
  await client.connect();
  return client;
}

function _serializeColumns(columns) {
  return (columns || []).map((column) => ({
    name: column.NAME,
    type: column.TYPE,
    id: column.ID,
    length: column.LENGTH,
    flag: column.FLAG,
  }));
}

/**
 * query가 불가능한 target을 위해 source mapping 기준의 가상 target schema를 만든다.
 *
 * 의도:
 * - mqtt-publish처럼 target에서 실제 스키마를 조회할 수 없는 경우에도
 *   validation/runtime이 공통 schema 객체를 사용할 수 있게 한다.
 * - 이 스키마는 "target 실제 컬럼 introspection"이 아니라 "보내게 될 payload 모양"을 나타낸다.
 */
function _buildDerivedTargetInfo(storedConfig, runtimeConfig, sourceInfo) {
  const sourceColumns = _normalizeMappingArray(storedConfig.source.columns, sourceInfo.dataColumns.map((column) => column.NAME));
  const targetColumns = _normalizeMappingArray(storedConfig.target.columns, sourceColumns.slice());
  const sourceMeta = _normalizeMappingArray(storedConfig.source.meta, sourceInfo.metaColumns.map((column) => column.NAME));
  const targetMeta = _normalizeMappingArray(storedConfig.target.meta, sourceMeta.slice());

  const dataColumns = [];
  const metaColumns = [];
  const dataByName = {};
  const metaByName = {};
  let dataId = 0;
  let metaId = 1000;
  let primaryColumn = null;
  let baseTimeColumn = null;

  for (let i = 0; i < targetColumns.length; i++) {
    const targetName = targetColumns[i];
    if (!targetName) continue;
    const sourceName = sourceColumns[i];
    if (!sourceName) continue;
    const sourceColumn = sourceInfo.dataByName[sourceName];
    if (!sourceColumn) continue;
    const column = {
      NAME: targetName,
      TYPE: sourceColumn.TYPE,
      ID: dataId++,
      LENGTH: sourceColumn.LENGTH,
      FLAG: 0,
    };
    if (sourceInfo.primaryColumn && sourceName === sourceInfo.primaryColumn.NAME) {
      column.FLAG |= FLAG_PRIMARY;
      primaryColumn = column;
    }
    if (sourceInfo.baseTimeColumn && sourceName === sourceInfo.baseTimeColumn.NAME) {
      column.FLAG |= FLAG_BASETIME;
      baseTimeColumn = column;
    }
    dataColumns.push(column);
    dataByName[column.NAME] = column;
  }

  for (let i = 0; i < targetMeta.length; i++) {
    const targetName = targetMeta[i];
    if (!targetName) continue;
    const sourceName = sourceMeta[i];
    if (!sourceName) continue;
    const sourceColumn = sourceInfo.metaByName[sourceName];
    if (!sourceColumn) continue;
    const column = {
      NAME: targetName,
      TYPE: sourceColumn.TYPE,
      ID: metaId++,
      LENGTH: sourceColumn.LENGTH,
      FLAG: FLAG_METADATA,
    };
    metaColumns.push(column);
    metaByName[column.NAME] = column;
  }

  return {
    table: runtimeConfig.target.table,
    logicalTable: runtimeConfig.target.table,
    tableType: sourceInfo.tableType,
    rows: dataColumns.concat(metaColumns),
    dataColumns,
    metaColumns,
    dataByName,
    metaByName,
    primaryColumn,
    baseTimeColumn,
  };
}

async function _describeTable(client, tableName) {
  const normalizedTable = normalizeColumnName(tableName);
  const qualified = client.splitQualifiedTableName(normalizedTable);
  const { type: tableType } = await client.selectTableTypeQualified(normalizedTable);
  if (tableType === 'UNSUPPORTED') {
    throw new Error(`table '${normalizedTable}' not found`);
  }

  const rows = (await client.selectColumnsByQualifiedTableName(normalizedTable))
    .filter((column) => !column.NAME.startsWith('_'));
  const dataColumns = rows.filter((column) => (column.FLAG & FLAG_METADATA) === 0);
  const metaColumns = rows.filter((column) => (column.FLAG & FLAG_METADATA) !== 0);
  const dataByName = {};
  const metaByName = {};
  for (const column of dataColumns) dataByName[column.NAME] = column;
  for (const column of metaColumns) metaByName[column.NAME] = column;

  return {
    table: qualified.owner ? `${qualified.owner}.${qualified.table}` : qualified.table,
    logicalTable: qualified.table,
    tableType,
    rows,
    dataColumns,
    metaColumns,
    dataByName,
    metaByName,
    primaryColumn: dataColumns.find((column) => (column.FLAG & FLAG_PRIMARY) !== 0) || null,
    baseTimeColumn: dataColumns.find((column) => (column.FLAG & FLAG_BASETIME) !== 0) || null,
  };
}

function _validateServerProfile(profile, options = {}) {
  const requireName = options.requireName !== false;
  const normalized = normalizeServerProfileForSave(profile);
  if (requireName && !normalized.name) throw new Error('server.name is required');
  if (!normalized.host) throw new Error('server.host is required');
  if (!normalized.port) throw new Error('server.port is required');
  if (!normalized.type) normalized.type = 'native';
  if (normalized.type === 'native') {
    if (!normalized.user) throw new Error('server.user is required');
    return normalized;
  }
  if (normalized.type === 'http') {
    if (!normalized.protocol) normalized.protocol = 'http';
    return normalized;
  }
  if (normalized.type === 'mqtt-api' || normalized.type === 'mqtt-publish') {
    if (normalized.qos != null) {
      const qos = Number(normalized.qos);
      if (!Number.isFinite(qos) || qos < 0 || qos > 2) {
        throw new Error('server.qos must be 0, 1 or 2');
      }
      normalized.qos = qos;
    }
    return normalized;
  }
  if (normalized.type) {
    throw new Error(`server.type '${normalized.type}' is not supported`);
  }
  return normalized;
}

function _resolveTagAlias(sourceInfo, column) {
  if (sourceInfo.tableType !== 'TAG') return column;
  if (column === 'NAME' && sourceInfo.primaryColumn) return sourceInfo.primaryColumn.NAME;
  if (column === 'TIME' && sourceInfo.baseTimeColumn) return sourceInfo.baseTimeColumn.NAME;
  return column;
}

function _validateTargetOrder(mapping, actualColumns, label) {
  let seenNull = false;
  for (const name of mapping) {
    if (!name) {
      seenNull = true;
      continue;
    }
    if (seenNull) {
      throw new Error(`${label} allows only trailing null padding`);
    }
  }

  if (!Array.isArray(actualColumns) || actualColumns.length === 0) {
    return;
  }

  const actualNames = actualColumns.map((column) => column.NAME);
  const presentNames = mapping.filter((name) => !!name);
  if (presentNames.length !== actualNames.length) {
    throw new Error(`${label} non-null count must match actual target columns`);
  }
  for (let i = 0; i < actualNames.length; i++) {
    if (presentNames[i] !== actualNames[i]) {
      throw new Error(`${label} must follow actual target column order`);
    }
  }
}

function _validateSourceNames(mapping, byName, label) {
  for (let i = 0; i < mapping.length; i++) {
    const name = mapping[i];
    if (!name) continue;
    if (!byName[name]) {
      throw new Error(`${label}[${i}] '${name}' not found`);
    }
  }
}

function _areTypeCompatible(sourceColumn, targetColumn) {
  if (!sourceColumn || !targetColumn) return false;
  if (_isNumericType(sourceColumn.TYPE) && _isNumericType(targetColumn.TYPE)) {
    return true;
  }
  return sourceColumn.TYPE === targetColumn.TYPE;
}

function _validateMappedTypes(sourceMapping, targetMapping, sourceByName, targetByName, label, options = {}) {
  if (sourceMapping.length !== targetMapping.length) {
    throw new Error(`${label} length mismatch`);
  }

  for (let i = 0; i < targetMapping.length; i++) {
    const sourceName = sourceMapping[i];
    const targetName = targetMapping[i];
    if (!targetName) continue;

    const targetColumn = targetByName[targetName];
    if (!targetColumn) {
      throw new Error(`${label}[${i}] target column '${targetName}' not found`);
    }
    if (!sourceName) {
      if ((targetColumn.FLAG & FLAG_SUMMARIZED) !== 0) {
        throw new Error(`${label}[${i}] target summarized column '${targetName}' does not allow null mapping`);
      }
      if (options.requireKeyColumns && ((targetColumn.FLAG & FLAG_PRIMARY) || (targetColumn.FLAG & FLAG_BASETIME))) {
        throw new Error(`${label}[${i}] requires source mapping for target key column '${targetName}'`);
      }
      continue;
    }

    const sourceColumn = sourceByName[sourceName];
    if (!sourceColumn) {
      throw new Error(`${label}[${i}] source column '${sourceName}' not found`);
    }
    if (!_areTypeCompatible(sourceColumn, targetColumn)) {
      throw new Error(
        `${label}[${i}] type mismatch: source.${sourceName}(TYPE=${sourceColumn.TYPE}) != target.${targetName}(TYPE=${targetColumn.TYPE})`
      );
    }
  }
}

function _validateTagPrimaryMapping(sourceInfo, targetInfo, sourceMapping, targetMapping) {
  if (sourceInfo.tableType !== 'TAG') return;
  const sourcePrimaryName = sourceInfo.primaryColumn ? sourceInfo.primaryColumn.NAME : null;
  const targetPrimaryName = targetInfo.primaryColumn ? targetInfo.primaryColumn.NAME : null;
  if (!sourcePrimaryName || !targetPrimaryName) return;

  const targetPrimaryIndex = targetMapping.findIndex((name) => name === targetPrimaryName);
  if (targetPrimaryIndex < 0) {
    throw new Error(`target.columns must include TAG PRIMARY KEY column '${targetPrimaryName}'`);
  }
  if (sourceMapping[targetPrimaryIndex] !== sourcePrimaryName) {
    throw new Error(`target PRIMARY KEY column '${targetPrimaryName}' must map from source PRIMARY KEY column '${sourcePrimaryName}'`);
  }
}

function _validateCondition(condition, sourceInfo, label) {
  if (!condition) return null;

  const op = String(condition.op || '').toUpperCase();
  if (op !== 'ALL' && op !== 'IN' && op !== 'LIKE') {
    throw new Error(`${label}.op '${condition.op}' is not supported`);
  }

  const value = Array.isArray(condition.value) ? condition.value : [];
  if (op === 'ALL') {
    return { column: condition.column || null, op: 'ALL', value: [] };
  }

  const column = _resolveTagAlias(sourceInfo, normalizeColumnName(condition.column));
  if (!column) {
    throw new Error(`${label}.column is required`);
  }

  const columnInfo = sourceInfo.dataByName[column];
  if (!columnInfo) {
    throw new Error(`${label}.column '${column}' not found`);
  }
  if (sourceInfo.tableType === 'TAG') {
    const primaryName = sourceInfo.primaryColumn ? sourceInfo.primaryColumn.NAME : null;
    if (!primaryName || primaryName !== column) {
      throw new Error(`${label}.column must be the TAG PRIMARY KEY column '${primaryName}'`);
    }
  }
  if (!_isStringLikeType(columnInfo.TYPE)) {
    throw new Error(`${label}.column '${column}' must be a string-like column for ${op}`);
  }
  if (op === 'IN' && value.length === 0) {
    throw new Error(`${label}.value is required for IN`);
  }
  if (op === 'LIKE' && value.length === 0) {
    throw new Error(`${label}.value[0] is required for LIKE`);
  }

  return { column, op, value: value.slice() };
}

function _validateTransformRules(transform, sourceInfo) {
  if (transform == null) return null;
  if (!Array.isArray(transform)) throw new Error('source.transform must be an array');

  const normalized = [];
  for (let i = 0; i < transform.length; i++) {
    const rule = transform[i];
    if (!isObject(rule)) {
      throw new Error(`source.transform[${i}] must be an object`);
    }
    const criteria = _validateCondition(rule.criteria || { op: 'ALL', value: [] }, sourceInfo, `source.transform[${i}].criteria`);
    const expr = Array.isArray(rule.expr) ? rule.expr : [];
    if (expr.length === 0) {
      throw new Error(`source.transform[${i}].expr must not be empty`);
    }

    const normalizedExpr = [];
    for (let j = 0; j < expr.length; j++) {
      const item = expr[j];
      if (!isObject(item)) {
        throw new Error(`source.transform[${i}].expr[${j}] must be an object`);
      }
      const column = _resolveTagAlias(sourceInfo, normalizeColumnName(item.column));
      if (!column) {
        throw new Error(`source.transform[${i}].expr[${j}].column is required`);
      }
      const columnInfo = sourceInfo.dataByName[column];
      if (!columnInfo) {
        throw new Error(`source.transform[${i}].expr[${j}].column '${column}' not found`);
      }
      const type = String(item.type || '').toLowerCase();
      if (type !== 'prefix' && type !== 'suffix' && type !== 'calc' && type !== 'filter') {
        throw new Error(`source.transform[${i}].expr[${j}].type '${item.type}' is not supported`);
      }

      if (type === 'prefix' || type === 'suffix') {
        if (!_isStringLikeType(columnInfo.TYPE)) {
          throw new Error(`source.transform[${i}].expr[${j}] prefix/suffix requires a string-like column`);
        }
        normalizedExpr.push({ column, type, value: item.value == null ? '' : String(item.value) });
        continue;
      }

      if (!_isNumericType(columnInfo.TYPE)) {
        throw new Error(`source.transform[${i}].expr[${j}] ${type} requires a numeric column`);
      }
      if (type === 'calc') {
        const bias = item.bias !== undefined ? Number(item.bias) : 0;
        const multiplier = item.multiplier !== undefined ? Number(item.multiplier) : 1;
        const calcOrder = item.calcOrder == null || item.calcOrder === ''
          ? 'bm'
          : String(item.calcOrder).trim().toLowerCase();
        if (!Number.isFinite(bias) || !Number.isFinite(multiplier)) {
          throw new Error(`source.transform[${i}].expr[${j}] calc requires numeric bias/multiplier`);
        }
        if (calcOrder !== 'bm' && calcOrder !== 'mb') {
          throw new Error(`source.transform[${i}].expr[${j}] calcOrder must be 'bm' or 'mb'`);
        }
        normalizedExpr.push({ column, type, bias, multiplier, calcOrder });
        continue;
      }

      const hasMin = item.min !== undefined && item.min !== null && item.min !== '';
      const hasMax = item.max !== undefined && item.max !== null && item.max !== '';
      if (!hasMin && !hasMax) {
        throw new Error(`source.transform[${i}].expr[${j}] filter requires min or max`);
      }
      const normalizedItem = { column, type };
      if (hasMin) normalizedItem.min = Number(item.min);
      if (hasMax) normalizedItem.max = Number(item.max);
      if ((hasMin && !Number.isFinite(normalizedItem.min)) || (hasMax && !Number.isFinite(normalizedItem.max))) {
        throw new Error(`source.transform[${i}].expr[${j}] filter min/max must be numeric`);
      }
      if (hasMin && hasMax && normalizedItem.min > normalizedItem.max) {
        throw new Error(`source.transform[${i}].expr[${j}] filter min must be <= max`);
      }
      normalizedExpr.push(normalizedItem);
    }

    normalized.push({ criteria, expr: normalizedExpr });
  }

  return normalized.length > 0 ? normalized : null;
}

function _collectStringGrowthByColumn(transform) {
  const growthByColumn = {};
  for (const rule of (transform || [])) {
    for (const item of (rule.expr || [])) {
      if (item.type !== 'prefix' && item.type !== 'suffix') continue;
      const len = String(item.value || '').length;
      if (!len) continue;
      growthByColumn[item.column] = (growthByColumn[item.column] || 0) + len;
    }
  }
  return growthByColumn;
}

function _collectVarcharOverflowNames(sourceMapping, targetMapping, sourceByName, targetByName, stringGrowthByColumn) {
  const seen = {};
  const result = [];
  for (let i = 0; i < targetMapping.length; i++) {
    const sourceName = sourceMapping[i];
    const targetName = targetMapping[i];
    if (!sourceName || !targetName) continue;
    const sourceColumn = sourceByName[sourceName];
    const targetColumn = targetByName[targetName];
    if (!sourceColumn || !targetColumn) continue;
    if (!_isVarcharType(sourceColumn.TYPE) || !_isVarcharType(targetColumn.TYPE)) continue;

    const sourceLength = Number(sourceColumn.LENGTH);
    const targetLength = Number(targetColumn.LENGTH);
    if (!Number.isFinite(sourceLength) || !Number.isFinite(targetLength) || sourceLength <= 0 || targetLength <= 0) continue;

    const extraLength = stringGrowthByColumn && stringGrowthByColumn[sourceName]
      ? stringGrowthByColumn[sourceName]
      : 0;
    if ((sourceLength + extraLength) > targetLength && !seen[targetName]) {
      seen[targetName] = true;
      result.push(targetName);
    }
  }
  return result;
}

async function prepareReplicatorConfig(config, readServerProfile) {
  const storedConfig = normalizeReplicatorConfigForSave(config);
  _validateRuntimeOptions(storedConfig);
  const runtimeConfig = resolveReplicatorRuntimeConfig(storedConfig, readServerProfile);
  const warnings = [];

  if (!runtimeConfig.source || !runtimeConfig.target) {
    throw new Error('source/target config is required');
  }
  if (!runtimeConfig.source.table) {
    throw new Error('source.table is required');
  }
  if (!runtimeConfig.target.table) {
    runtimeConfig.target.table = runtimeConfig.source.table;
    storedConfig.target.table = runtimeConfig.target.table;
  }

  const sourceType = String(runtimeConfig.source.type || 'native').toLowerCase();
  const targetType = String(runtimeConfig.target.type || 'native').toLowerCase();
  if (sourceType === 'mqtt-api' || sourceType === 'mqtt-publish') {
    throw new Error(`source.type '${sourceType}' is not supported`);
  }

  let sourceClient = null;
  let targetClient = null;
  try {
    sourceClient = await _openQueryClient(runtimeConfig.source, 'source');
    const targetNeedsQuery = targetType !== 'mqtt-publish';
    if (targetNeedsQuery) {
      targetClient = await _openQueryClient(runtimeConfig.target, 'target');
    }

    const sourceInfo = await _describeTable(sourceClient, runtimeConfig.source.table);
    const targetInfo = targetClient
      ? await _describeTable(targetClient, runtimeConfig.target.table)
      : _buildDerivedTargetInfo(storedConfig, runtimeConfig, sourceInfo);
    if (targetClient && sourceInfo.tableType !== targetInfo.tableType) {
      throw new Error(`source/target table type mismatch: ${sourceInfo.tableType} != ${targetInfo.tableType}`);
    }

    const sourceColumns = _normalizeMappingArray(storedConfig.source.columns, sourceInfo.dataColumns.map((column) => column.NAME));
    const targetColumns = _normalizeMappingArray(
      storedConfig.target.columns,
      targetType === 'mqtt-publish'
        ? sourceColumns.slice()
        : targetInfo.dataColumns.map((column) => column.NAME)
    );
    const sourceMeta = _normalizeMappingArray(storedConfig.source.meta, sourceInfo.metaColumns.map((column) => column.NAME));
    const targetMeta = _normalizeMappingArray(
      storedConfig.target.meta,
      targetType === 'mqtt-publish'
        ? sourceMeta.slice()
        : targetInfo.metaColumns.map((column) => column.NAME)
    );

    if (sourceColumns.length !== targetColumns.length) {
      throw new Error(`source.columns/target.columns length mismatch: ${sourceColumns.length} != ${targetColumns.length}`);
    }
    if (sourceMeta.length !== targetMeta.length) {
      throw new Error(`source.meta/target.meta length mismatch: ${sourceMeta.length} != ${targetMeta.length}`);
    }

    _validateTargetOrder(targetColumns, targetType === 'mqtt-publish' ? [] : targetInfo.dataColumns, 'target.columns');
    _validateTargetOrder(targetMeta, targetType === 'mqtt-publish' ? [] : targetInfo.metaColumns, 'target.meta');
    _validateSourceNames(sourceColumns, sourceInfo.dataByName, 'source.columns');
    _validateSourceNames(sourceMeta, sourceInfo.metaByName, 'source.meta');
    if (targetType !== 'mqtt-publish') {
      _validateMappedTypes(sourceColumns, targetColumns, sourceInfo.dataByName, targetInfo.dataByName, 'columns', { requireKeyColumns: true });
      _validateMappedTypes(sourceMeta, targetMeta, sourceInfo.metaByName, targetInfo.metaByName, 'meta');
    }

    const repTargetCond = _validateCondition(storedConfig.source.rep_target_cond, sourceInfo, 'source.rep_target_cond');
    const transform = _validateTransformRules(storedConfig.source.transform, sourceInfo);
    if (targetType !== 'mqtt-publish') {
      _validateTagPrimaryMapping(sourceInfo, targetInfo, sourceColumns, targetColumns);
    }

    const stringGrowthByColumn = _collectStringGrowthByColumn(transform);
    if (targetType !== 'mqtt-publish') {
      const dataOverflowNames = _collectVarcharOverflowNames(
        sourceColumns,
        targetColumns,
        sourceInfo.dataByName,
        targetInfo.dataByName,
        stringGrowthByColumn
      );
      if (dataOverflowNames.length > 0) {
        warnings.push(`VARCHAR length may overflow in target.columns: ${dataOverflowNames.join(', ')}`);
      }
      const metaOverflowNames = _collectVarcharOverflowNames(
        sourceMeta,
        targetMeta,
        sourceInfo.metaByName,
        targetInfo.metaByName,
        null
      );
      if (metaOverflowNames.length > 0) {
        warnings.push(`VARCHAR length may overflow in target.meta: ${metaOverflowNames.join(', ')}`);
      }
    }

    storedConfig.source.columns = sourceColumns;
    storedConfig.target.columns = targetColumns;
    storedConfig.source.meta = sourceMeta;
    storedConfig.target.meta = targetMeta;
    storedConfig.source.rep_target_cond = repTargetCond;
    storedConfig.source.transform = transform;

    runtimeConfig.source.columns = sourceColumns.slice();
    runtimeConfig.source.meta = sourceMeta.slice();
    if (targetType === 'mqtt-publish') {
      runtimeConfig.target.columns = targetColumns.map((targetName, index) => {
        if (!targetName) return null;
        return sourceColumns[index] || null;
      });
      runtimeConfig.target.meta = targetMeta.map((targetName, index) => {
        if (!targetName) return null;
        return sourceMeta[index] || null;
      });
    } else {
      runtimeConfig.target.columns = targetColumns.slice();
      runtimeConfig.target.meta = targetMeta.slice();
    }
    runtimeConfig.source.rep_target_cond = repTargetCond ? { ...repTargetCond, value: repTargetCond.value.slice() } : null;
    runtimeConfig.source.transform = transform
      ? transform.map((rule) => ({
          criteria: { ...rule.criteria, value: rule.criteria.value.slice() },
          expr: rule.expr.map((item) => ({ ...item })),
        }))
      : null;

    const runtimeHints = {
      source: {
        tableType: sourceInfo.tableType,
        logicalTable: sourceInfo.logicalTable,
      },
      target: {
        tableType: targetInfo.tableType,
        logicalTable: targetInfo.logicalTable,
        dataColumns: _serializeColumns(targetInfo.dataColumns),
        metaColumns: _serializeColumns(targetInfo.metaColumns),
      },
    };
    runtimeConfig._runtime = runtimeHints;

    return {
      storedConfig,
      runtimeConfig,
      sourceInfo,
      targetInfo,
      warnings,
    };
  } finally {
    try { sourceClient && await sourceClient.close(); } catch (_) {}
    try { targetClient && await targetClient.close(); } catch (_) {}
  }
}

module.exports = {
  prepareReplicatorConfig,
  validateServerProfile: _validateServerProfile,
};
