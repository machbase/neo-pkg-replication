'use strict';

const { getInstance: getLogger } = require('../lib/logger.js');

const fs = require('fs');
const path = require('path');

// ─── 내부 파일 I/O 헬퍼 ──────────────────────────────────────────────────────

const BIGINT_KEYS = new Set(['lastSuccessRid']);

// goja(jsh)에서 typeof bigint === 'bigint'가 동작하지 않으므로 별도 판별
function _isBigInt(v) {
  return typeof v === 'bigint' || (v !== null && typeof v === 'object' && v.constructor && v.constructor.name === 'BigInt');
}

function _stringify(data) {
  return JSON.stringify(
    data,
    (key, value) => (_isBigInt(value) ? value.toString() : value),
    2
  );
}

function _parse(content) {
  return JSON.parse(content, (key, value) => {
    if (BIGINT_KEYS.has(key) && typeof value === 'string' && /^\d+$/.test(value)) {
      return BigInt(value);
    }
    return value;
  });
}

/**
 * JSON atomic write (tmp → rename)
 */
function _writeFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, _stringify(data), 'utf-8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

// ─── CheckpointStore ──────────────────────────────────────────────────────────

class CheckpointStore {
  constructor(directory) {
    if (!directory) throw new Error('directory is required');
    this.directory = directory;
  }

  _filePath(jobId, dataTable) {
    return path.join(this.directory, `${jobId}${dataTable}.json`);
  }

  /**
   * 체크포인트 로드
   * @param {string} jobId
   * @param {string} dataTable
   * @returns {Promise<{ cp: object|null, exists: boolean, err: Error|null }>}
   */
  load(jobId, dataTable) {
    const filePath = this._filePath(jobId, dataTable);

    let data;
    try {
      data = _parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { cp: null, exists: false, err: null };
      }
      const msg = err instanceof SyntaxError ? `parse failed: ${err.message}` : `read failed: ${err.message}`;
      getLogger().error('checkpoint_io', {
        jobId,
        dataTable,
        msg,
      });
      return { cp: null, exists: false, err };
    }

    // source.dataTable 불일치 → 손상 처리
    if (data.source?.dataTable !== dataTable) {
      getLogger().error('checkpoint_io', {
        jobId,
        dataTable,
        msg: `dataTable mismatch in file (got: ${data.source?.dataTable}), invalidating`,
      });
      return { cp: null, exists: false, err: new Error('checkpoint dataTable mismatch') };
    }

    const cp = data.checkpoint;
    if (!cp || typeof cp.lastSuccessRid !== 'bigint') {
      getLogger().error('checkpoint_io', {
        jobId,
        dataTable,
        msg: `invalid checkpoint structure (lastSuccessRid missing or wrong type), invalidating`,
      });
      return { cp: null, exists: false, err: new Error('checkpoint structure invalid') };
    }

    return { cp, exists: true, err: null };
  }

  /**
   * 체크포인트 저장 (atomic write)
   * @param {string} jobId
   * @param {string} dataTable
   * @param {{ lastSuccessRid: bigint, sourceServer?: string, sourceTable?: string }} cp
   * @param {{ rowsRead: number, rowsWritten: number, droppedNoMeta: number, skippedExists: number }} stats
   * @param {{ onSaveFailure?: 'continue'|'abort' }} [opts]
   * @returns {Error|null}
   */
  save(jobId, dataTable, cp, stats, opts) {
    if (!_isBigInt(cp.lastSuccessRid)) {
      throw new TypeError(`lastSuccessRid must be BigInt, got ${typeof cp.lastSuccessRid}`);
    }

    const data = {
      version: 1,
      jobId,
      source: {
        server: cp.sourceServer || '',
        table: cp.sourceTable || '',
        dataTable,
      },
      checkpoint: {
        lastSuccessRid: cp.lastSuccessRid,
        updatedAt: new Date().toISOString(),
      },
    };

    try {
      _writeFile(this._filePath(jobId, dataTable), data);
      getLogger().info('checkpoint_saved', {
        jobId,
        dataTable,
        lastSuccessRid: cp.lastSuccessRid.toString(),
        rowsRead:      stats?.rowsRead      ?? 0,
        rowsWritten:   stats?.rowsWritten   ?? 0,
        droppedNoMeta: stats?.droppedNoMeta ?? 0,
        skippedExists: stats?.skippedExists ?? 0,
      });
      return null;
    } catch (err) {
      getLogger().error('checkpoint_io', {
        jobId,
        dataTable,
        msg: `save failed: ${err.message}`,
      });
      if (opts?.onSaveFailure === 'abort') throw err;
      return err;
    }
  }
}

module.exports = CheckpointStore;
