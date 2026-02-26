'use strict';

const fs = require('fs/promises');

const EXECUTION_DEFAULTS = {
  query_limit: 5000,
  rid_range_size: 50000,
  poll_interval_ms: 1000,
  start_mode: 'full',
  on_save_failure: 'continue',
};

const EXECUTION_FIELDS = [
  'query_limit',
  'rid_range_size',
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

    let shutdownTimeout = 30000;
    if (job.shutdown_timeout_ms !== undefined) {
      if (!Number.isInteger(job.shutdown_timeout_ms) || job.shutdown_timeout_ms < 1) {
        console.warn(JSON.stringify({
          level: 'warn', stage: 'config', job_id: job.id,
          msg: `shutdown_timeout_ms must be a positive integer, got: ${job.shutdown_timeout_ms}, using default 30000`,
        }));
      } else {
        shutdownTimeout = job.shutdown_timeout_ms;
      }
    }

    const checkpoint = job.checkpoint || { directory: './checkpoints' };
    if (job.checkpoint) {
      if (typeof checkpoint.directory !== 'string' || checkpoint.directory === '') {
        throw new Error(`checkpoint.directory must be a non-empty string in job '${job.id}'`);
      }
    }

    const jobDefaults = ConfigLoader._mergeExecution(EXECUTION_DEFAULTS, job.execution_defaults || {});

    const mappings = (job.mappings || []).flatMap(mapping =>
      ConfigLoader._processMapping(mapping, servers, jobDefaults, job.id)
    );

    return {
      id: job.id,
      enabled: job.enabled !== false,
      shutdown_timeout_ms: shutdownTimeout,
      checkpoint,
      integrity: job.integrity,
      retry: job.retry,
      mappings,
    };
  }

  static _processMapping(mapping, servers, jobDefaults, jobId) {
    if (!mapping.mapping_id) throw new Error(`mapping_id is required in job '${jobId}'`);

    const logCtx = { job_id: jobId, mapping_id: mapping.mapping_id };

    // source/target 구조 검증
    if (!mapping.source || typeof mapping.source !== 'object') {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: 'mapping.source is required and must be an object, skipping mapping',
      }));
      return [];
    }
    if (!mapping.target || typeof mapping.target !== 'object') {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: 'mapping.target is required and must be an object, skipping mapping',
      }));
      return [];
    }
    if (!mapping.source.table || typeof mapping.source.table !== 'string') {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: 'mapping.source.table is required and must be a non-empty string, skipping mapping',
      }));
      return [];
    }
    if (!mapping.target.table || typeof mapping.target.table !== 'string') {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: 'mapping.target.table is required and must be a non-empty string, skipping mapping',
      }));
      return [];
    }

    const srcServer = mapping.source.server;
    const dstServer = mapping.target.server;

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

    // query_limit 검증
    if (!Number.isInteger(execution.query_limit) || execution.query_limit < 1) {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: `query_limit must be a positive integer, got: ${execution.query_limit}, skipping mapping`,
      }));
      return [];
    }

    // poll_interval_ms 검증
    if (!Number.isInteger(execution.poll_interval_ms) || execution.poll_interval_ms < 1) {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: `poll_interval_ms must be a positive integer, got: ${execution.poll_interval_ms}, skipping mapping`,
      }));
      return [];
    }

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

    const rrs = execution.rid_range_size;
    if (!Number.isInteger(rrs) || rrs < 1) {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: `rid_range_size must be a positive integer, got: ${rrs}, skipping mapping`,
      }));
      return [];
    }

    // retry 구조 검증
    if (execution.retry !== undefined) {
      if (typeof execution.retry !== 'object' || execution.retry === null || Array.isArray(execution.retry)) {
        console.error(JSON.stringify({
          level: 'error', stage: 'config', ...logCtx,
          msg: 'retry must be an object, skipping mapping',
        }));
        return [];
      }
      const r = execution.retry;
      const VALID_STRATEGIES = ['exponential', 'linear'];
      if (r.strategy !== undefined && !VALID_STRATEGIES.includes(r.strategy)) {
        console.error(JSON.stringify({
          level: 'error', stage: 'config', ...logCtx,
          msg: `retry.strategy must be 'exponential' or 'linear', got: "${r.strategy}", skipping mapping`,
        }));
        return [];
      }
      if (r.max_attempts !== undefined && r.max_attempts !== null) {
        if (!Number.isInteger(r.max_attempts) || r.max_attempts < 1) {
          console.error(JSON.stringify({
            level: 'error', stage: 'config', ...logCtx,
            msg: `retry.max_attempts must be a positive integer or null, got: ${r.max_attempts}, skipping mapping`,
          }));
          return [];
        }
      }
      if (r.initial_delay_ms !== undefined) {
        if (!Number.isInteger(r.initial_delay_ms) || r.initial_delay_ms < 0) {
          console.error(JSON.stringify({
            level: 'error', stage: 'config', ...logCtx,
            msg: `retry.initial_delay_ms must be a non-negative integer, got: ${r.initial_delay_ms}, skipping mapping`,
          }));
          return [];
        }
      }
      if (r.max_delay_ms !== undefined) {
        if (!Number.isInteger(r.max_delay_ms) || r.max_delay_ms < 0) {
          console.error(JSON.stringify({
            level: 'error', stage: 'config', ...logCtx,
            msg: `retry.max_delay_ms must be a non-negative integer, got: ${r.max_delay_ms}, skipping mapping`,
          }));
          return [];
        }
      }
      if (r.multiplier !== undefined) {
        if (typeof r.multiplier !== 'number' || r.multiplier <= 0) {
          console.error(JSON.stringify({
            level: 'error', stage: 'config', ...logCtx,
            msg: `retry.multiplier must be a positive number, got: ${r.multiplier}, skipping mapping`,
          }));
          return [];
        }
      }
    }

    // integrity 구조 검증
    if (execution.integrity !== undefined) {
      if (typeof execution.integrity !== 'object' || execution.integrity === null || Array.isArray(execution.integrity)) {
        console.error(JSON.stringify({
          level: 'error', stage: 'config', ...logCtx,
          msg: 'integrity must be an object, skipping mapping',
        }));
        return [];
      }
      if (execution.integrity.enabled !== undefined && typeof execution.integrity.enabled !== 'boolean') {
        console.error(JSON.stringify({
          level: 'error', stage: 'config', ...logCtx,
          msg: `integrity.enabled must be a boolean, got: ${typeof execution.integrity.enabled}, skipping mapping`,
        }));
        return [];
      }
    }

    // tag_identifier 검증
    const VALID_MODES = ['prefix', 'suffix', 'none'];
    const tagId = mapping.source.tag_identifier;
    if (tagId && !VALID_MODES.includes(tagId.mode)) {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: `Invalid tag_identifier.mode '${tagId.mode}' in mapping '${mapping.mapping_id}', skipping mapping`,
      }));
      return [];
    }
    if (tagId && tagId.value !== undefined && typeof tagId.value !== 'string') {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', ...logCtx,
        msg: `tag_identifier.value must be a string, got: ${typeof tagId.value}, skipping mapping`,
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
