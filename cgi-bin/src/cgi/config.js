'use strict';

const path = require('path');
const process = require('process');

const APP_DIR = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const CONF_DIR = path.join(APP_DIR, 'conf.d');
const DATA_DIR = path.join(APP_DIR, 'data');
const SERVER_CONF_DIR = path.join(CONF_DIR, 'server');
const SERVICE_NAME_PREFIX = '_rpl_';
const DEFAULT_LOG_DIR = '/work/public/neo-pkg-replication/logs';

const CONDITION_OPS = { ALL: true, IN: true, LIKE: true };
const EXPR_TYPES = { prefix: true, suffix: true, calc: true, filter: true };
const SERVER_TYPES = { native: true, http: true, 'mqtt-api': true, 'mqtt-publish': true };
const CALC_ORDERS = { bm: true, mb: true };

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text ? text : null;
}

function normalizePort(value) {
  if (value == null || value === '') return null;
  const port = parseInt(value, 10);
  return Number.isFinite(port) ? port : value;
}

function normalizeTableName(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text ? text.toUpperCase() : null;
}

function normalizeColumnName(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text ? text.toUpperCase() : null;
}

function normalizeNameArray(values) {
  if (!Array.isArray(values)) return values;
  return values.map((value) => {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    const text = value.trim();
    return text ? text.toUpperCase() : null;
  });
}

function normalizeServerType(value) {
  if (typeof value !== 'string') return 'native';
  const text = value.trim().toLowerCase();
  return text || 'native';
}

function normalizeProtocol(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return text || null;
}

function normalizeBoolean(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes' || text === 'y') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'n') return false;
  return value;
}

function normalizeConditionValue(value) {
  if (Array.isArray(value)) return value.slice();
  if (value == null) return [];
  return [value];
}

function normalizeCondition(condition) {
  if (!isObject(condition)) return null;
  const op = String(condition.op || 'ALL').trim().toUpperCase();
  return {
    column: normalizeColumnName(condition.column),
    op: CONDITION_OPS[op] ? op : op,
    value: normalizeConditionValue(condition.value),
  };
}

function normalizeExprType(type) {
  const text = typeof type === 'string' ? type.trim().toLowerCase() : '';
  if (text === 'surfix') return 'suffix';
  return text;
}

function normalizeCalcOrder(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  return text || null;
}

function normalizeExpr(expr) {
  if (!isObject(expr)) return null;
  const type = normalizeExprType(expr.type);
  const normalized = {
    column: normalizeColumnName(expr.column),
    type,
  };
  if (type === 'prefix' || type === 'suffix') {
    normalized.value = expr.value == null ? '' : String(expr.value);
  } else if (type === 'calc') {
    if (expr.bias !== undefined) normalized.bias = Number(expr.bias);
    else if (expr.add !== undefined) normalized.bias = Number(expr.add);
    if (expr.multiplier !== undefined) normalized.multiplier = Number(expr.multiplier);
    else if (expr.multplier !== undefined) normalized.multiplier = Number(expr.multplier);
    else if (expr.multiply !== undefined) normalized.multiplier = Number(expr.multiply);
    const calcOrder = normalizeCalcOrder(expr.calcOrder);
    if (calcOrder) normalized.calcOrder = calcOrder;
  } else if (type === 'filter') {
    if (expr.min !== undefined && expr.min !== null && expr.min !== '') normalized.min = Number(expr.min);
    if (expr.max !== undefined && expr.max !== null && expr.max !== '') normalized.max = Number(expr.max);
  }
  return normalized;
}

function normalizeCriteria(criteria) {
  const normalized = normalizeCondition(criteria || { op: 'ALL', value: [] });
  if (!normalized) return { column: null, op: 'ALL', value: [] };
  if (normalized.op === 'ALL' && !normalized.column) {
    normalized.value = [];
  }
  return normalized;
}

function normalizeLegacyTransformRule(rule) {
  if (!isObject(rule)) return null;
  const column = normalizeColumnName(rule.column);
  const expr = [];
  if (rule.prefix !== undefined) {
    expr.push({ column, type: 'prefix', value: String(rule.prefix) });
  }
  if (rule.suffix !== undefined || rule.surfix !== undefined) {
    expr.push({ column, type: 'suffix', value: String(rule.suffix !== undefined ? rule.suffix : rule.surfix) });
  }
  const hasCalc = rule.add !== undefined
    || rule.multiply !== undefined
    || rule.bias !== undefined
    || rule.multiplier !== undefined
    || rule.multplier !== undefined;
  if (hasCalc) {
    const bias = rule.bias !== undefined ? Number(rule.bias) : Number(rule.add || 0);
    let multiplier = 1;
    if (rule.multiplier !== undefined) multiplier = Number(rule.multiplier);
    else if (rule.multplier !== undefined) multiplier = Number(rule.multplier);
    else if (rule.multiply !== undefined) multiplier = Number(rule.multiply);
    expr.push({ column, type: 'calc', bias, multiplier, calcOrder: 'bm' });
  }
  if (expr.length === 0) return null;
  return { criteria: { column: null, op: 'ALL', value: [] }, expr };
}

function normalizeTransformRules(rules) {
  if (!Array.isArray(rules)) return null;
  const normalized = [];
  for (const rule of rules) {
    if (!isObject(rule)) continue;
    if (Array.isArray(rule.expr) || isObject(rule.criteria)) {
      const expr = Array.isArray(rule.expr)
        ? rule.expr.map(normalizeExpr).filter((item) => item !== null)
        : [];
      if (expr.length === 0) continue;
      normalized.push({
        criteria: normalizeCriteria(rule.criteria),
        expr,
      });
      continue;
    }
    const legacy = normalizeLegacyTransformRule(rule);
    if (legacy) normalized.push(legacy);
  }
  return normalized.length > 0 ? normalized : [];
}

function normalizeLegacyFilterRules(filter) {
  const result = { repTargetCond: null, transform: [] };
  if (!Array.isArray(filter)) return result;

  for (const entry of filter) {
    if (!isObject(entry)) continue;
    const column = normalizeColumnName(entry.column);
    if (!column) continue;

    const hasStringCond = (Array.isArray(entry.in) && entry.in.length > 0) || entry.like !== undefined;
    if (hasStringCond) {
      if (result.repTargetCond) {
        throw new Error('multiple legacy string filters are not supported together');
      }
      if (Array.isArray(entry.in) && entry.in.length > 0) {
        result.repTargetCond = { column, op: 'IN', value: entry.in.slice() };
      } else {
        result.repTargetCond = { column, op: 'LIKE', value: [String(entry.like)] };
      }
      continue;
    }

    if (entry.min !== undefined || entry.max !== undefined) {
      const expr = { column, type: 'filter' };
      if (entry.min !== undefined && entry.min !== null && entry.min !== '') expr.min = Number(entry.min);
      if (entry.max !== undefined && entry.max !== null && entry.max !== '') expr.max = Number(entry.max);
      result.transform.push({
        criteria: { column: null, op: 'ALL', value: [] },
        expr: [expr],
      });
    }
  }

  return result;
}

function normalizeLoggingConfig(logging) {
  if (!isObject(logging)) return logging;
  const normalized = {
    level: typeof logging.level === 'string' ? logging.level.trim().toLowerCase() : 'info',
    maxFiles: Number.isFinite(Number(logging.maxFiles)) ? Number(logging.maxFiles) : 10,
  };
  if (normalized.maxFiles <= 0) normalized.maxFiles = 10;
  return normalized;
}

function normalizeServerProfileForSave(profile) {
  if (!isObject(profile)) return profile;
  const type = normalizeServerType(profile.type);
  return {
    name: normalizeOptionalString(profile.name),
    host: normalizeOptionalString(profile.host),
    port: normalizePort(profile.port),
    user: normalizeOptionalString(profile.user),
    password: profile.password == null ? '' : String(profile.password),
    token: normalizeOptionalString(profile.token),
    clientId: normalizeOptionalString(profile.clientId),
    protocol: normalizeProtocol(profile.protocol),
    qos: profile.qos == null || profile.qos === '' ? null : Number(profile.qos),
    retain: normalizeBoolean(profile.retain),
    type: SERVER_TYPES[type] ? type : type,
  };
}

function sanitizeServerProfile(profile) {
  if (!isObject(profile)) return profile;
  const safe = { ...profile };
  delete safe.password;
  delete safe.token;
  safe.targetOnly = safe.type === 'mqtt-api' || safe.type === 'mqtt-publish';
  return safe;
}

function _normalizeEndpointForSave(endpoint) {
  if (!isObject(endpoint)) return endpoint;

  const normalized = { ...endpoint };
  normalized.table = normalizeTableName(endpoint.table);
  if (endpoint.columns !== undefined) normalized.columns = normalizeNameArray(endpoint.columns);
  if (endpoint.meta !== undefined) normalized.meta = normalizeNameArray(endpoint.meta);

  const serverName = normalizeOptionalString(endpoint.server);
  if (serverName) {
    normalized.server = serverName;
    delete normalized.host;
    delete normalized.port;
    delete normalized.user;
    delete normalized.password;
    delete normalized.token;
    delete normalized.clientId;
    delete normalized.protocol;
    delete normalized.qos;
    delete normalized.retain;
    delete normalized.type;
  } else {
    if (endpoint.host !== undefined) normalized.host = normalizeOptionalString(endpoint.host);
    if (endpoint.port !== undefined) normalized.port = normalizePort(endpoint.port);
    if (endpoint.user !== undefined) normalized.user = normalizeOptionalString(endpoint.user);
    if (endpoint.password !== undefined) normalized.password = endpoint.password == null ? '' : String(endpoint.password);
    if (endpoint.type !== undefined) normalized.type = normalizeServerType(endpoint.type);
    if (endpoint.token !== undefined) normalized.token = normalizeOptionalString(endpoint.token);
    if (endpoint.clientId !== undefined) normalized.clientId = normalizeOptionalString(endpoint.clientId);
    if (endpoint.protocol !== undefined) normalized.protocol = normalizeProtocol(endpoint.protocol);
    if (endpoint.qos !== undefined && endpoint.qos !== null && endpoint.qos !== '') {
      const qos = Number(endpoint.qos);
      normalized.qos = Number.isFinite(qos) ? qos : endpoint.qos;
    }
    if (endpoint.retain !== undefined) normalized.retain = normalizeBoolean(endpoint.retain);
  }

  if (endpoint.rep_target_cond !== undefined) {
    normalized.rep_target_cond = normalizeCondition(endpoint.rep_target_cond);
  }

  const transformInput = Array.isArray(endpoint.transform)
    ? endpoint.transform
    : (Array.isArray(endpoint.trandform) ? endpoint.trandform : null);
  if (transformInput !== null) {
    normalized.transform = normalizeTransformRules(transformInput);
  }
  delete normalized.trandform;

  const legacyFilter = normalizeLegacyFilterRules(endpoint.filter);
  if (!normalized.rep_target_cond && legacyFilter.repTargetCond) {
    normalized.rep_target_cond = legacyFilter.repTargetCond;
  }
  if (legacyFilter.transform.length > 0) {
    normalized.transform = (normalized.transform || []).concat(legacyFilter.transform);
  }
  delete normalized.filter;

  if (normalized.transform && normalized.transform.length === 0) normalized.transform = null;
  if (!normalized.rep_target_cond) normalized.rep_target_cond = null;

  return normalized;
}

function normalizeReplicatorConfigForSave(config) {
  if (!isObject(config)) return config;
  const normalized = { ...config };

  if (normalized.id !== undefined && normalized.id !== null) {
    normalized.id = String(normalized.id).trim();
  }
  if (config.source) normalized.source = _normalizeEndpointForSave(config.source);
  if (config.target) normalized.target = _normalizeEndpointForSave(config.target);

  delete normalized.ridRangeSize;
  if (normalized.target && isObject(normalized.target)) {
    delete normalized.target.autoCreate;
  }
  if (normalized.logging !== undefined) {
    normalized.logging = normalizeLoggingConfig(normalized.logging);
  }
  if (normalized.queryLimit !== undefined && normalized.queryLimit !== null && normalized.queryLimit !== '') {
    const value = Number(normalized.queryLimit);
    if (Number.isFinite(value)) normalized.queryLimit = value;
  }
  if (normalized.pollIntervalMs !== undefined && normalized.pollIntervalMs !== null && normalized.pollIntervalMs !== '') {
    const value = Number(normalized.pollIntervalMs);
    if (Number.isFinite(value)) normalized.pollIntervalMs = value;
  }
  if (normalized.shutdownTimeoutMs !== undefined && normalized.shutdownTimeoutMs !== null && normalized.shutdownTimeoutMs !== '') {
    const value = Number(normalized.shutdownTimeoutMs);
    if (Number.isFinite(value)) normalized.shutdownTimeoutMs = value;
  }
  return normalized;
}

function resolveEndpointConnection(endpoint, readServerProfile, side) {
  if (!isObject(endpoint)) return endpoint;
  const normalized = _normalizeEndpointForSave(endpoint);
  let profile = null;
  if (normalized.server) {
    profile = readServerProfile(normalized.server);
    if (!profile) {
      throw new Error(`${side}.server '${normalized.server}' not found`);
    }
  }

  const resolved = profile ? { ...profile, ...normalized } : { ...normalized };
  resolved.type = normalizeServerType(resolved.type);
  if (!resolved.host) throw new Error(`${side}.host is required`);
  if (!resolved.port) throw new Error(`${side}.port is required`);
  if (resolved.type === 'native') {
    if (!resolved.user) throw new Error(`${side}.user is required`);
    if (resolved.password == null) resolved.password = '';
  } else if (resolved.type === 'http') {
    if (resolved.password == null) resolved.password = '';
    if (!resolved.protocol) resolved.protocol = 'http';
  } else if (resolved.type === 'mqtt-api' || resolved.type === 'mqtt-publish') {
    if (resolved.password == null) resolved.password = '';
    if (resolved.qos == null || !Number.isFinite(Number(resolved.qos))) resolved.qos = 1;
    else resolved.qos = Number(resolved.qos);
    if (resolved.retain == null) resolved.retain = false;
  } else {
    throw new Error(`${side}.type '${resolved.type}' is not supported`);
  }
  resolved.table = normalizeTableName(resolved.table);
  return resolved;
}

function resolveReplicatorRuntimeConfig(config, readServerProfile) {
  const stored = normalizeReplicatorConfigForSave(config);
  if (!isObject(stored)) return stored;

  const resolved = { ...stored };
  if (stored.source) {
    resolved.source = resolveEndpointConnection(stored.source, readServerProfile, 'source');
  }
  if (stored.target) {
    resolved.target = resolveEndpointConnection(stored.target, readServerProfile, 'target');
  }
  if (resolved.source && resolved.target && !resolved.target.table) {
    resolved.target.table = resolved.source.table;
  }
  return resolved;
}

function sanitizeReplicatorConfig(config) {
  if (!isObject(config)) return config;
  const safe = { ...config };
  delete safe._runtime;
  if (isObject(config.source)) {
    safe.source = { ...config.source };
    delete safe.source.password;
    delete safe.source.token;
  }
  if (isObject(config.target)) {
    safe.target = { ...config.target };
    delete safe.target.password;
    delete safe.target.token;
  }
  return safe;
}

module.exports = {
  APP_DIR,
  CONF_DIR,
  DATA_DIR,
  SERVER_CONF_DIR,
  SERVICE_NAME_PREFIX,
  DEFAULT_LOG_DIR,
  EXPR_TYPES,
  CONDITION_OPS,
  CALC_ORDERS,
  isObject,
  normalizeOptionalString,
  normalizePort,
  normalizeTableName,
  normalizeColumnName,
  normalizeNameArray,
  normalizeServerType,
  normalizeProtocol,
  normalizeCalcOrder,
  normalizeBoolean,
  normalizeCondition,
  normalizeTransformRules,
  normalizeServerProfileForSave,
  sanitizeServerProfile,
  normalizeReplicatorConfigForSave,
  resolveEndpointConnection,
  resolveReplicatorRuntimeConfig,
  sanitizeReplicatorConfig,
};
