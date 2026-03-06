'use strict';

const { getInstance: getLogger } = require('../logger/logger.js');

const fs = require('fs/promises');
const path = require('path');

// ─── 내부 파일 I/O 헬퍼 ──────────────────────────────────────────────────────

const BIGINT_KEYS = new Set(['last_success_rid']);

function _stringify(data) {
  return JSON.stringify(
    data,
    (key, value) => (typeof value === 'bigint' ? value.toString() : value),
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
async function _writeFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.hrtime.bigint()}.tmp`;
  await fs.writeFile(tmpPath, _stringify(data), 'utf-8');
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
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
   * @returns {{ cp: object|null, exists: boolean, err: Error|null }}
   */
  async load(jobId, dataTable) {
    const filePath = this._filePath(jobId, dataTable);

    let data;
    try {
      data = _parse(await fs.readFile(filePath, 'utf-8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { cp: null, exists: false, err: null };
      }
      const msg = err instanceof SyntaxError ? `parse failed: ${err.message}` : `read failed: ${err.message}`;
      getLogger().error('checkpoint_io', {
        job_id: jobId,
        data_table: dataTable,
        msg,
      });
      return { cp: null, exists: false, err };
    }

    // source.data_table 불일치 → 손상 처리
    if (data.source?.data_table !== dataTable) {
      getLogger().error('checkpoint_io', {
        job_id: jobId,
        data_table: dataTable,
        msg: `data_table mismatch in file (got: ${data.source?.data_table}), invalidating`,
      });
      return { cp: null, exists: false, err: new Error('checkpoint data_table mismatch') };
    }

    const cp = data.checkpoint;
    if (!cp || typeof cp.last_success_rid !== 'bigint') {
      getLogger().error('checkpoint_io', {
        job_id: jobId,
        data_table: dataTable,
        msg: `invalid checkpoint structure (last_success_rid missing or wrong type), invalidating`,
      });
      return { cp: null, exists: false, err: new Error('checkpoint structure invalid') };
    }

    return { cp, exists: true, err: null };
  }

  /**
   * 체크포인트 저장 (atomic write)
   * @param {string} jobId
   * @param {string} dataTable
   * @param {{ last_success_rid: BigInt, source_server?: string, source_table?: string }} cp
   * @param {{ rows_read: number, rows_written: number, dropped_no_meta: number, skipped_exists: number }} stats
   * @param {{ on_save_failure?: 'continue'|'abort' }} [opts]
   * @returns {Error|null}
   */
  async save(jobId, dataTable, cp, stats, opts) {
    if (typeof cp.last_success_rid !== 'bigint') {
      throw new TypeError(`last_success_rid must be BigInt, got ${typeof cp.last_success_rid}`);
    }

    const data = {
      version: 1,
      job_id: jobId,
      source: {
        server: cp.source_server || '',
        table: cp.source_table || '',
        data_table: dataTable,
      },
      checkpoint: {
        last_success_rid: cp.last_success_rid,
        updated_at: new Date().toISOString(),
      },
    };

    try {
      await _writeFile(this._filePath(jobId, dataTable), data);
      getLogger().info('checkpoint_saved', {
        job_id: jobId,
        data_table: dataTable,
        last_success_rid: cp.last_success_rid.toString(),
        rows_read: stats?.rows_read ?? 0,
        rows_written: stats?.rows_written ?? 0,
        dropped_no_meta: stats?.dropped_no_meta ?? 0,
        skipped_exists: stats?.skipped_exists ?? 0,
      });
      return null;
    } catch (err) {
      getLogger().error('checkpoint_io', {
        job_id: jobId,
        data_table: dataTable,
        msg: `save failed: ${err.message}`,
      });
      if (opts?.on_save_failure === 'abort') throw err;
      return err;
    }
  }
}

module.exports = CheckpointStore;
