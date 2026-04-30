'use strict';

/**
 * @fileoverview CheckpointStore — 파티션별 복제 진행 위치(RID) 저장/로드
 *
 * 저장 파일 형식 (cgi-bin/data/{replicatorId}/{dataTable}.json):
 * {
 *   "version": 1,
 *   "source": { "server": "...", "table": "...", "dataTable": "...", "tableId": "123", "dataTableId": "456" },
 *   "checkpoint": { "lastSuccessRid": "12345", "totalRowsWritten": "12345", "updatedAt": "...", "hasMore": false }
 * }
 */

const { getInstance: getLogger } = require('../lib/logger.js');

const fs = require('fs');
const path = require('path');

/** @type {Set<string>} BigInt로 복원해야 하는 JSON 키 집합 */
const BIGINT_KEYS = new Set(['lastSuccessRid', 'totalRowsWritten']);

/**
 * goja(jsh)에서 `typeof v === 'bigint'`가 올바르게 동작하지 않으므로 별도 판별한다.
 * @param {*} v
 * @returns {boolean}
 */
function _isBigInt(v) {
  return typeof v === 'bigint' || (v !== null && typeof v === 'object' && v.constructor && v.constructor.name === 'BigInt');
}

/**
 * checkpoint에 저장할 table id를 문자열로 정규화한다.
 * legacy checkpoint는 이 필드가 없을 수 있으므로 null을 허용한다.
 * @param {*|null} value
 * @returns {string|null}
 */
function _normalizeTableId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

// ─── CheckpointStore ──────────────────────────────────────────────────────────

/**
 * 파티션 단위 checkpoint 파일 저장소
 *
 * 하나의 인스턴스가 하나의 파티션(dataTable) 파일을 관리한다.
 * 파일 경로: {directory}/{dataTable}.json
 */
class CheckpointStore {
  /**
   * @param {string} directory - checkpoint 파일 저장 디렉토리 (cgi-bin/data/{replicatorId})
   * @param {string} dataTable - 파티션 테이블명 (예: _TAG_DATA_0)
   */
  constructor(directory, dataTable) {
    if (!directory) throw new Error('directory is required');
    if (!dataTable)  throw new Error('dataTable is required');
    this.filePath = path.join(directory, `${dataTable}.json`);
    this.dataTable = dataTable;
  }

  /**
   * 체크포인트 로드
   * @returns {{ cp: object|null, exists: boolean, err: Error|null }}
   */
  load() {
    const { filePath, dataTable } = this;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'), (key, value) => {
        if (BIGINT_KEYS.has(key) && typeof value === 'string' && /^-?\d+$/.test(value)) {
          return BigInt(value);
        }
        return value;
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { cp: null, exists: false, err: null };
      }
      const msg = err instanceof SyntaxError ? `parse failed: ${err.message}` : `read failed: ${err.message}`;
      getLogger().error('checkpoint_io', { dataTable, msg });
      return { cp: null, exists: false, err };
    }

    // source.dataTable 불일치 → 손상 처리
    if (data.source?.dataTable !== dataTable) {
      getLogger().error('checkpoint_io', {
        dataTable,
        msg: `dataTable mismatch in file (got: ${data.source?.dataTable}), invalidating`,
      });
      return { cp: null, exists: false, err: new Error('checkpoint dataTable mismatch') };
    }

    const rawCp = data.checkpoint;
    if (!rawCp || typeof rawCp.lastSuccessRid !== 'bigint') {
      getLogger().error('checkpoint_io', {
        dataTable,
        msg: `invalid checkpoint structure (lastSuccessRid missing or wrong type), invalidating`,
      });
      return { cp: null, exists: false, err: new Error('checkpoint structure invalid') };
    }
    if (rawCp.totalRowsWritten === undefined) {
      rawCp.totalRowsWritten = 0n;
    } else if (typeof rawCp.totalRowsWritten !== 'bigint') {
      getLogger().error('checkpoint_io', {
        dataTable,
        msg: `invalid checkpoint structure (totalRowsWritten wrong type), invalidating`,
      });
      return { cp: null, exists: false, err: new Error('checkpoint structure invalid') };
    }
    if (rawCp.initializedOnly === true) {
      // placeholder checkpoint는 "resume 가능한 checkpoint"로 취급하지 않는다.
      return { cp: null, exists: false, err: null };
    }

    const cp = {
      lastSuccessRid: rawCp.lastSuccessRid,
      totalRowsWritten: rawCp.totalRowsWritten,
      updatedAt: rawCp.updatedAt || '',
      hasMore: rawCp.hasMore === true,
      sourceServer: data.source?.server || '',
      sourceTable: data.source?.table || '',
      sourceDataTable: data.source?.dataTable || dataTable,
      sourceTableId: _normalizeTableId(data.source?.tableId),
      sourceDataTableId: _normalizeTableId(data.source?.dataTableId),
    };

    return { cp, exists: true, err: null };
  }

  /**
   * 체크포인트 저장 (atomic write)
   * @param {{ lastSuccessRid: bigint, totalRowsWritten?: bigint, sourceServer?: string, sourceTable?: string, sourceTableId?: string|number|bigint|null, sourceDataTableId?: string|number|bigint|null }} cp
   * @param {{ rowsRead: number, rowsWritten: number, droppedNoMeta: number, skippedExists: number }} stats
   * @param {{ onSaveFailure?: 'continue'|'abort', queryLimit?: number, initializedOnly?: boolean, hasMore?: boolean }} [opts]
   * @returns {Error|null}
   */
  save(cp, stats, opts) {
    if (!_isBigInt(cp.lastSuccessRid)) {
      throw new TypeError(`lastSuccessRid must be BigInt, got ${typeof cp.lastSuccessRid}`);
    }
    const totalRowsWritten = cp.totalRowsWritten === undefined ? 0n : cp.totalRowsWritten;
    if (!_isBigInt(totalRowsWritten)) {
      throw new TypeError(`totalRowsWritten must be BigInt, got ${typeof totalRowsWritten}`);
    }

    const { filePath, dataTable } = this;
    const rowsRead = stats?.rowsRead ?? 0;
    const rowsWritten = stats?.rowsWritten ?? 0;
    const droppedNoMeta = stats?.droppedNoMeta ?? 0;
    const skippedExists = stats?.skippedExists ?? 0;
    const queryLimit = opts?.queryLimit;
    const sourceTableId = _normalizeTableId(cp.sourceTableId);
    const sourceDataTableId = _normalizeTableId(cp.sourceDataTableId);
    const hasMore = typeof opts?.hasMore === 'boolean'
      ? opts.hasMore
      : (typeof queryLimit === 'number'
        && queryLimit > 0
        && rowsRead === queryLimit);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const content = JSON.stringify({
        version: 1,
        source:     {
          server: cp.sourceServer || '',
          table: cp.sourceTable || '',
          dataTable,
          tableId: sourceTableId || undefined,
          dataTableId: sourceDataTableId || undefined,
        },
        checkpoint: {
          lastSuccessRid: cp.lastSuccessRid,
          totalRowsWritten,
          updatedAt: new Date().toISOString(),
          hasMore,
          initializedOnly: opts?.initializedOnly === true ? true : undefined,
        },
      }, (_key, value) => (_isBigInt(value) ? value.toString() : value), 2);

      const tmpPath = `${filePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
      getLogger().debug('checkpoint_saved', {
        dataTable,
        lastSuccessRid: cp.lastSuccessRid.toString(),
        totalRowsWritten: totalRowsWritten.toString(),
        rowsRead,
        rowsWritten,
        droppedNoMeta,
        skippedExists,
        hasMore,
      });
      return null;
    } catch (err) {
      getLogger().error('checkpoint_io', { dataTable, msg: `save failed: ${err.message}` });
      if (opts?.onSaveFailure === 'abort') throw err;
      return err;
    }
  }
}

module.exports = CheckpointStore;
