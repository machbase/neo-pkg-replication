'use strict';

/**
 * @fileoverview TAG metadata sync state file helper
 *
 * 의도:
 * - data partition checkpoint와 분리된 job-level metadata sync 상태를 보관한다.
 * - metadata sync는 TAG logical table 전체에 대한 상태이므로 파티션별 checkpoint에 섞지 않는다.
 * - CGI는 이 파일만 읽어서 "초기 동기화 진행중/완료" 상태를 그대로 노출할 수 있어야 한다.
 */

const fs = require('fs');
const path = require('path');
const { getInstance: getLogger } = require('../lib/logger.js');

const BIGINT_KEYS = new Set(['lastMetaId', 'goalMetaId']);

function _isBigInt(value) {
  return typeof value === 'bigint' || (value !== null && typeof value === 'object' && value.constructor && value.constructor.name === 'BigInt');
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
    expr: Array.isArray(rule?.expr)
      ? rule.expr.map((item) => ({
          column: item.column || null,
          type: item.type || null,
          value: item.value,
        }))
      : [],
  }));
}

function _normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const lastMetaId = raw.lastMetaId == null
    ? -1n
    : (_isBigInt(raw.lastMetaId) ? raw.lastMetaId : BigInt(String(raw.lastMetaId)));
  const goalMetaId = raw.goalMetaId == null
    ? -1n
    : (_isBigInt(raw.goalMetaId) ? raw.goalMetaId : BigInt(String(raw.goalMetaId)));

  return {
    status: raw.status || 'ready',
    message: raw.message || '',
    progress: typeof raw.progress === 'number' ? raw.progress : 0,
    lastMetaId,
    goalMetaId,
    repTargetCond: _cloneCondition(raw.repTargetCond),
    pendingRepTargetCond: _cloneCondition(raw.pendingRepTargetCond),
    nameTransformRules: _cloneRules(raw.nameTransformRules),
    startedAt: raw.startedAt || '',
    updatedAt: raw.updatedAt || '',
  };
}

class MetaSyncStateStore {
  constructor(directory) {
    if (!directory) throw new Error('directory is required');
    this.filePath = path.join(directory, 'meta-sync.json');
  }

  load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'), (key, value) => {
        if (BIGINT_KEYS.has(key) && typeof value === 'string' && /^-?\d+$/.test(value)) {
          return BigInt(value);
        }
        return value;
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { exists: false, state: null, err: null };
      }
      getLogger().error('meta_sync_state', { msg: `load failed: ${err.message}` });
      return { exists: false, state: null, err };
    }

    if (!data || data.kind !== 'tag-meta-sync' || !data.state) {
      const err = new Error('invalid meta sync state file');
      getLogger().error('meta_sync_state', { msg: err.message });
      return { exists: false, state: null, err };
    }

    try {
      return { exists: true, state: _normalizeState(data.state), err: null };
    } catch (err) {
      getLogger().error('meta_sync_state', { msg: `normalize failed: ${err.message}` });
      return { exists: false, state: null, err };
    }
  }

  save(state) {
    const normalized = _normalizeState(state);
    if (!normalized) throw new Error('state is required');

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const content = JSON.stringify({
        version: 1,
        kind: 'tag-meta-sync',
        state: normalized,
      }, (_key, value) => (_isBigInt(value) ? value.toString() : value), 2);

      const tmpPath = `${this.filePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, this.filePath);
      return null;
    } catch (err) {
      getLogger().error('meta_sync_state', { msg: `save failed: ${err.message}` });
      return err;
    }
  }

  static toPublic(state) {
    const normalized = _normalizeState(state);
    if (!normalized) return null;
    return {
      enabled: true,
      status: normalized.status,
      message: normalized.message,
      progress: normalized.progress,
      lastMetaId: normalized.lastMetaId >= 0n ? normalized.lastMetaId.toString() : '',
      goalMetaId: normalized.goalMetaId >= 0n ? normalized.goalMetaId.toString() : '',
      repTargetCond: _cloneCondition(normalized.pendingRepTargetCond || normalized.repTargetCond),
      startedAt: normalized.startedAt,
      updatedAt: normalized.updatedAt,
    };
  }
}

module.exports = { MetaSyncStateStore };
