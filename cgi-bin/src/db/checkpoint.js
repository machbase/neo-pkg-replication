'use strict';

const { getInstance: getLogger } = require('../lib/logger.js');

const fs = require('fs');
const path = require('path');

const BIGINT_KEYS = new Set(['lastSuccessRid']);

// goja(jsh)에서 typeof bigint === 'bigint'가 동작하지 않으므로 별도 판별
function _isBigInt(v) {
  return typeof v === 'bigint' || (v !== null && typeof v === 'object' && v.constructor && v.constructor.name === 'BigInt');
}

// ─── CheckpointStore ──────────────────────────────────────────────────────────

class CheckpointStore {
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
        if (BIGINT_KEYS.has(key) && typeof value === 'string' && /^\d+$/.test(value)) {
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

    const cp = data.checkpoint;
    if (!cp || typeof cp.lastSuccessRid !== 'bigint') {
      getLogger().error('checkpoint_io', {
        dataTable,
        msg: `invalid checkpoint structure (lastSuccessRid missing or wrong type), invalidating`,
      });
      return { cp: null, exists: false, err: new Error('checkpoint structure invalid') };
    }

    return { cp, exists: true, err: null };
  }

  /**
   * 체크포인트 저장 (atomic write)
   * @param {{ lastSuccessRid: bigint, sourceServer?: string, sourceTable?: string }} cp
   * @param {{ rowsRead: number, rowsWritten: number, droppedNoMeta: number, skippedExists: number }} stats
   * @param {{ onSaveFailure?: 'continue'|'abort' }} [opts]
   * @returns {Error|null}
   */
  save(cp, stats, opts) {
    if (!_isBigInt(cp.lastSuccessRid)) {
      throw new TypeError(`lastSuccessRid must be BigInt, got ${typeof cp.lastSuccessRid}`);
    }

    const { filePath, dataTable } = this;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const content = JSON.stringify({
        version: 1,
        source:     { server: cp.sourceServer || '', table: cp.sourceTable || '', dataTable },
        checkpoint: { lastSuccessRid: cp.lastSuccessRid, updatedAt: new Date().toISOString() },
      }, (_key, value) => (_isBigInt(value) ? value.toString() : value), 2);

      const tmpPath = `${filePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
      getLogger().info('checkpoint_saved', {
        dataTable,
        lastSuccessRid: cp.lastSuccessRid.toString(),
        rowsRead:      stats?.rowsRead      ?? 0,
        rowsWritten:   stats?.rowsWritten   ?? 0,
        droppedNoMeta: stats?.droppedNoMeta ?? 0,
        skippedExists: stats?.skippedExists ?? 0,
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
