'use strict';

const { MachbaseClient, ColumnType } = require('../db/client.js');
const { FLAG_METADATA, FLAG_PRIMARY, FLAG_BASETIME } = require('../db/types.js');
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

function _normalizeMappingArray(value, defaultValue) {
  if (!Array.isArray(value)) return defaultValue.slice();
  return value.map((item) => normalizeColumnName(item));
}

function _describeTable(client, tableName) {
  const normalizedTable = normalizeColumnName(tableName);
  const { type: tableType } = client.selectTableType(normalizedTable);
  if (tableType === 'UNSUPPORTED') {
    throw new Error(`table '${normalizedTable}' not found`);
  }

  const rows = client.selectColumnsByTableName(normalizedTable)
    .filter((column) => !column.NAME.startsWith('_'));
  const dataColumns = rows.filter((column) => (column.FLAG & FLAG_METADATA) === 0);
  const metaColumns = rows.filter((column) => (column.FLAG & FLAG_METADATA) !== 0);
  const dataByName = {};
  const metaByName = {};
  for (const column of dataColumns) dataByName[column.NAME] = column;
  for (const column of metaColumns) metaByName[column.NAME] = column;

  return {
    table: normalizedTable,
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

function _validateServerProfile(profile) {
  const normalized = normalizeServerProfileForSave(profile);
  if (!normalized.name) throw new Error('server.name is required');
  if (!normalized.host) throw new Error('server.host is required');
  if (!normalized.port) throw new Error('server.port is required');
  if (!normalized.user) throw new Error('server.user is required');
  if (!normalized.type) normalized.type = 'native';
  if (normalized.type !== 'native') {
    throw new Error(`server.type '${normalized.type}' is not supported`);
  }
  return normalized;
}

function _validateTargetOrder(mapping, actualColumns, label) {
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

  const column = normalizeColumnName(condition.column);
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
      const column = normalizeColumnName(item.column);
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
        if (!Number.isFinite(bias) || !Number.isFinite(multiplier)) {
          throw new Error(`source.transform[${i}].expr[${j}] calc requires numeric bias/multiplier`);
        }
        normalizedExpr.push({ column, type, bias, multiplier });
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
      normalizedExpr.push(normalizedItem);
    }

    normalized.push({ criteria, expr: normalizedExpr });
  }

  return normalized.length > 0 ? normalized : null;
}

function prepareReplicatorConfig(config, readServerProfile) {
  const storedConfig = normalizeReplicatorConfigForSave(config);
  const runtimeConfig = resolveReplicatorRuntimeConfig(storedConfig, readServerProfile);

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

  let sourceClient = null;
  let targetClient = null;
  try {
    sourceClient = new MachbaseClient(runtimeConfig.source);
    targetClient = new MachbaseClient(runtimeConfig.target);
    sourceClient.connect();
    targetClient.connect();

    const sourceInfo = _describeTable(sourceClient, runtimeConfig.source.table);
    const targetInfo = _describeTable(targetClient, runtimeConfig.target.table);
    if (sourceInfo.tableType !== targetInfo.tableType) {
      throw new Error(`source/target table type mismatch: ${sourceInfo.tableType} != ${targetInfo.tableType}`);
    }

    const sourceColumns = _normalizeMappingArray(storedConfig.source.columns, sourceInfo.dataColumns.map((column) => column.NAME));
    const targetColumns = _normalizeMappingArray(storedConfig.target.columns, targetInfo.dataColumns.map((column) => column.NAME));
    const sourceMeta = _normalizeMappingArray(storedConfig.source.meta, sourceInfo.metaColumns.map((column) => column.NAME));
    const targetMeta = _normalizeMappingArray(storedConfig.target.meta, targetInfo.metaColumns.map((column) => column.NAME));

    if (sourceColumns.length !== targetColumns.length) {
      throw new Error(`source.columns/target.columns length mismatch: ${sourceColumns.length} != ${targetColumns.length}`);
    }
    if (sourceMeta.length !== targetMeta.length) {
      throw new Error(`source.meta/target.meta length mismatch: ${sourceMeta.length} != ${targetMeta.length}`);
    }

    _validateTargetOrder(targetColumns, targetInfo.dataColumns, 'target.columns');
    _validateTargetOrder(targetMeta, targetInfo.metaColumns, 'target.meta');
    _validateSourceNames(sourceColumns, sourceInfo.dataByName, 'source.columns');
    _validateSourceNames(sourceMeta, sourceInfo.metaByName, 'source.meta');
    _validateMappedTypes(sourceColumns, targetColumns, sourceInfo.dataByName, targetInfo.dataByName, 'columns', { requireKeyColumns: true });
    _validateMappedTypes(sourceMeta, targetMeta, sourceInfo.metaByName, targetInfo.metaByName, 'meta');

    const repTargetCond = _validateCondition(storedConfig.source.rep_target_cond, sourceInfo, 'source.rep_target_cond');
    const transform = _validateTransformRules(storedConfig.source.transform, sourceInfo);

    storedConfig.source.columns = sourceColumns;
    storedConfig.target.columns = targetColumns;
    storedConfig.source.meta = sourceMeta;
    storedConfig.target.meta = targetMeta;
    storedConfig.source.rep_target_cond = repTargetCond;
    storedConfig.source.transform = transform;

    runtimeConfig.source.columns = sourceColumns.slice();
    runtimeConfig.target.columns = targetColumns.slice();
    runtimeConfig.source.meta = sourceMeta.slice();
    runtimeConfig.target.meta = targetMeta.slice();
    runtimeConfig.source.rep_target_cond = repTargetCond ? { ...repTargetCond, value: repTargetCond.value.slice() } : null;
    runtimeConfig.source.transform = transform
      ? transform.map((rule) => ({
          criteria: { ...rule.criteria, value: rule.criteria.value.slice() },
          expr: rule.expr.map((item) => ({ ...item })),
        }))
      : null;

    return {
      storedConfig,
      runtimeConfig,
      sourceInfo,
      targetInfo,
    };
  } finally {
    try { sourceClient && sourceClient.close(); } catch (_) {}
    try { targetClient && targetClient.close(); } catch (_) {}
  }
}

module.exports = {
  prepareReplicatorConfig,
  validateServerProfile: _validateServerProfile,
};
