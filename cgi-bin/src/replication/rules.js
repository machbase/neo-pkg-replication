'use strict';

function _escapeLikePattern(value) {
  return String(value || '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
}

function _likeRegex(pattern) {
  return new RegExp(`^${_escapeLikePattern(pattern)}$`);
}

function matchesCondition(row, condition) {
  if (!condition || condition.op === 'ALL') return true;
  const actual = row ? row[condition.column] : undefined;
  if (condition.op === 'IN') {
    return (condition.value || []).some((item) => actual === item);
  }
  if (condition.op === 'LIKE') {
    return _likeRegex((condition.value || [])[0]).test(String(actual == null ? '' : actual));
  }
  return true;
}

function applyTransformRules(baseRow, transformRules) {
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
          working[expr.column] = (current + (expr.bias || 0)) * (expr.multiplier == null ? 1 : expr.multiplier);
        }
        continue;
      }
      if (expr.type === 'filter') {
        if (typeof current === 'number') {
          if (expr.min !== undefined && current < expr.min) return { row: working, dropped: true };
          if (expr.max !== undefined && current > expr.max) return { row: working, dropped: true };
        }
      }
    }
  }

  return { row: working, dropped: false };
}

function collectReferencedColumns(repTargetCond, transformRules) {
  const seen = {};
  const columns = [];
  const push = (name) => {
    if (!name || seen[name]) return;
    seen[name] = true;
    columns.push(name);
  };

  if (repTargetCond && repTargetCond.op !== 'ALL') {
    push(repTargetCond.column);
  }
  for (const rule of (transformRules || [])) {
    if (rule.criteria && rule.criteria.op !== 'ALL') {
      push(rule.criteria.column);
    }
    for (const expr of (rule.expr || [])) {
      push(expr.column);
    }
  }
  return columns;
}

function _buildConditionSql(condition, context) {
  if (!condition || condition.op === 'ALL') {
    return { sql: '1=1', params: [] };
  }

  const column = condition.column;
  const value = Array.isArray(condition.value) ? condition.value : [];
  if (context.tableType === 'TAG' && column === context.primaryColumnName) {
    if (condition.op === 'IN') {
      return {
        sql: `${column} IN (SELECT _ID FROM _${context.logicalTable}_META WHERE NAME IN (${value.map(() => '?').join(', ')}))`,
        params: value.slice(),
      };
    }
    return {
      sql: `${column} IN (SELECT _ID FROM _${context.logicalTable}_META WHERE NAME LIKE ?)`,
      params: [value[0]],
    };
  }

  if (condition.op === 'IN') {
    return {
      sql: `${column} IN (${value.map(() => '?').join(', ')})`,
      params: value.slice(),
    };
  }
  return {
    sql: `${column} LIKE ?`,
    params: [value[0]],
  };
}

function buildQueryFilterSql(repTargetCond, transformRules, context) {
  const clauses = [];
  const params = [];

  if (repTargetCond && repTargetCond.op !== 'ALL') {
    const topLevel = _buildConditionSql(repTargetCond, context);
    clauses.push(topLevel.sql);
    params.push(...topLevel.params);
  }

  for (const rule of (transformRules || [])) {
    const criteria = _buildConditionSql(rule.criteria || { op: 'ALL' }, context);
    for (const expr of (rule.expr || [])) {
      if (expr.type !== 'filter') continue;
      const comparisons = [];
      const comparisonParams = [];
      if (expr.min !== undefined) {
        comparisons.push(`${expr.column} < ?`);
        comparisonParams.push(expr.min);
      }
      if (expr.max !== undefined) {
        comparisons.push(`${expr.column} > ?`);
        comparisonParams.push(expr.max);
      }
      if (comparisons.length === 0) continue;

      if (criteria.sql === '1=1') {
        clauses.push(`NOT (${comparisons.join(' OR ')})`);
        params.push(...comparisonParams);
      } else {
        clauses.push(`NOT ((${criteria.sql}) AND (${comparisons.join(' OR ')}))`);
        params.push(...criteria.params, ...comparisonParams);
      }
    }
  }

  return {
    sql: clauses.length > 0 ? clauses.join(' AND ') : '1=1',
    params,
  };
}

module.exports = {
  applyTransformRules,
  buildQueryFilterSql,
  collectReferencedColumns,
  matchesCondition,
};
