'use strict';

const fs = require('fs/promises');

const EXECUTION_DEFAULTS = {
  batch_size_records: 5000,
  poll_interval_ms: 1000,
  start_mode: 'full',
  on_save_failure: 'continue',
};

const EXECUTION_FIELDS = [
  'batch_size_records',
  'poll_interval_ms',
  'start_mode',
  'rid_after',
  'on_save_failure',
  'integrity',
  'retry',
];

const VALID_START_MODES = new Set(['full', 'now', 'rid_after']);
const VALID_ON_SAVE_FAILURE = new Set(['continue', 'abort']);

class ConfigLoader {
  /**
   * config.json을 읽어 Config 객체로 반환
   * @param {string} filePath
   * @returns {Promise<object>} Config
   */
  static async load(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const raw = JSON.parse(content);

    if (raw.version !== 3) {
      throw new Error(`Unsupported config version: ${raw.version} (expected 3)`);
    }
    if (!raw.servers || typeof raw.servers !== 'object' || Array.isArray(raw.servers)) {
      throw new Error('config.servers is required and must be an object');
    }
    if (!Array.isArray(raw.replication?.jobs)) {
      throw new Error('config.replication.jobs is required and must be an array');
    }

    for (const [name, srv] of Object.entries(raw.servers || {})) {
      if (!srv.host) throw new Error(`servers.${name}.host is required`);
      if (!srv.port) throw new Error(`servers.${name}.port is required`);
      if (!srv.user) throw new Error(`servers.${name}.user is required`);
      if (srv.password === undefined) throw new Error(`servers.${name}.password is required`);
    }

    const jobs = raw.replication.jobs.map(job =>
      ConfigLoader._processJob(job, raw.servers)
    );

    return {
      version: raw.version,
      servers: raw.servers,
      replication: { jobs },
    };
  }

  static _processJob(job, servers) {
    if (!job.id) throw new Error(`job.id is required`);

    const jobDefaults = ConfigLoader._mergeExecution(EXECUTION_DEFAULTS, job.execution_defaults || {});

    const mappings = (job.mappings || []).flatMap(mapping =>
      ConfigLoader._processMapping(mapping, servers, jobDefaults, job.id)
    );

    return {
      id: job.id,
      enabled: job.enabled !== false,
      shutdown_timeout_ms: job.shutdown_timeout_ms ?? 30000,
      checkpoint: job.checkpoint || { directory: './checkpoints' },
      integrity: job.integrity,
      retry: job.retry,
      mappings,
    };
  }

  static _processMapping(mapping, servers, jobDefaults, jobId) {
    if (!mapping.mapping_id) throw new Error(`mapping_id is required in job '${jobId}'`);

    const srcServer = mapping.source?.server;
    const dstServer = mapping.target?.server;
    const logCtx = { job_id: jobId, mapping_id: mapping.mapping_id };

    if (!servers[srcServer]) {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: `Unknown source server alias: "${srcServer}", skipping mapping`,
      }));
      return [];
    }
    if (!servers[dstServer]) {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: `Unknown target server alias: "${dstServer}", skipping mapping`,
      }));
      return [];
    }

    // 필드 레벨 merge: mapping.execution > source.execution > job execution_defaults
    const execution = ConfigLoader._mergeExecution(
      jobDefaults,
      mapping.source?.execution || {},
      mapping.execution || {},
    );

    if (!VALID_START_MODES.has(execution.start_mode)) {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: `Invalid start_mode: "${execution.start_mode}", skipping mapping`,
      }));
      return [];
    }
    if (execution.start_mode === 'rid_after') {
      const ridVal = execution.rid_after;
      if (ridVal === undefined || ridVal === null) {
        console.error(JSON.stringify({
          level: 'error', stage: 'config', ...logCtx,
          msg: 'rid_after is required when start_mode is "rid_after", skipping mapping',
        }));
        return [];
      }
      if (!/^\d+$/.test(String(ridVal))) {
        console.error(JSON.stringify({
          level: 'error', stage: 'config', ...logCtx,
          msg: `rid_after must be a non-negative integer, got: ${ridVal}, skipping mapping`,
        }));
        return [];
      }
    }
    if (!VALID_ON_SAVE_FAILURE.has(execution.on_save_failure)) {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: `Invalid on_save_failure: "${execution.on_save_failure}", skipping mapping`,
      }));
      return [];
    }

    const VALID_MODES = ['prefix', 'suffix', 'none'];
    const tagId = mapping.source?.tag_identifier;
    if (tagId && !VALID_MODES.includes(tagId.mode)) {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: `Invalid tag_identifier.mode '${tagId.mode}' in mapping '${mapping.mapping_id}', skipping mapping`,
      }));
      return [];
    }

    return [{
      mapping_id: mapping.mapping_id,
      source: {
        server: srcServer,
        table: mapping.source.table,
        tag_identifier: mapping.source.tag_identifier || { mode: 'none', value: '' },
      },
      target: { server: dstServer, table: mapping.target.table },
      execution,
    }];
  }

  /**
   * 필드 레벨 merge: 오른쪽 인수가 우선
   * _mergeExecution(base, mid, top) → top > mid > base
   */
  static _mergeExecution(...layers) {
    const merged = {};
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue;
      for (const field of EXECUTION_FIELDS) {
        if (layer[field] !== undefined) {
          merged[field] = layer[field];
        }
      }
    }
    return merged;
  }
}

module.exports = ConfigLoader;
