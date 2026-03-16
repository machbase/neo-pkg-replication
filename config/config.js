'use strict';

const { getInstance: getLogger } = require('../logger/logger.js');
const { JobConfig } = require('../core/types.js');

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
    let raw;
    try {
      raw = JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse config file '${filePath}': ${err.message}`);
    }

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
      logging: ConfigLoader._processLogging(raw.logging),
      api: ConfigLoader._processApi(raw.api),
    };
  }

  static async save(filePath, rawConfig) {
    const tmp = `${filePath}.${process.hrtime.bigint()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rawConfig, null, 2), 'utf-8');
    await fs.rename(tmp, filePath);
  }

  static _processApi(raw = {}) {
    return {
      enabled: raw.enabled !== false,
      port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : 8080,
    };
  }

  static _processLogging(raw = {}) {
    const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
    const level = raw.level ?? 'info';
    if (!VALID_LEVELS.has(level)) {
      throw new Error(`logging.level must be one of: debug, info, warn, error (got: "${level}")`);
    }

    const stdout = raw.stdout !== undefined ? raw.stdout : true;
    if (typeof stdout !== 'boolean') {
      throw new Error(`logging.stdout must be a boolean (got: ${typeof stdout})`);
    }

    const file = raw.file || {};
    const fileEnabled = file.enabled !== undefined ? file.enabled : false;
    if (typeof fileEnabled !== 'boolean') {
      throw new Error(`logging.file.enabled must be a boolean (got: ${typeof fileEnabled})`);
    }
    if (fileEnabled) {
      if (file.directory !== undefined && (typeof file.directory !== 'string' || file.directory === '')) {
        throw new Error('logging.file.directory must be a non-empty string');
      }
    }

    return {
      level,
      stdout,
      file: {
        enabled: fileEnabled,
        directory: file.directory || './logs',
      },
    };
  }

  static _processJob(job, servers) {
    if (!job.id) throw new Error(`job.id is required`);

    let shutdownTimeout = 30000;
    if (job.shutdown_timeout_ms !== undefined) {
      if (!Number.isInteger(job.shutdown_timeout_ms) || job.shutdown_timeout_ms < 1) {
        getLogger().warn('config', {
          job_id: job.id,
          msg: `shutdown_timeout_ms must be a positive integer, got: ${job.shutdown_timeout_ms}, using default 30000`,
        });
      } else {
        shutdownTimeout = job.shutdown_timeout_ms;
      }
    }

    const checkpoint = job.checkpoint || { directory: './checkpoints' };
    if (typeof checkpoint.directory !== 'string' || checkpoint.directory === '') {
      throw new Error(`checkpoint.directory must be a non-empty string in job '${job.id}'`);
    }

    // source/target 구조 검증
    if (!job.source || typeof job.source !== 'object') {
      throw new Error(`job.source is required and must be an object in job '${job.id}'`);
    }
    if (!job.target || typeof job.target !== 'object') {
      throw new Error(`job.target is required and must be an object in job '${job.id}'`);
    }
    if (!job.source.table || typeof job.source.table !== 'string') {
      throw new Error(`job.source.table is required and must be a non-empty string in job '${job.id}'`);
    }
    if (!job.target.table || typeof job.target.table !== 'string') {
      throw new Error(`job.target.table is required and must be a non-empty string in job '${job.id}'`);
    }

    const srcServer = job.source.server;
    const dstServer = job.target.server;

    if (!servers[srcServer]) {
      throw new Error(`Unknown source server alias: "${srcServer}" in job '${job.id}'`);
    }
    if (!servers[dstServer]) {
      throw new Error(`Unknown target server alias: "${dstServer}" in job '${job.id}'`);
    }

    // 2-level merge: EXECUTION_DEFAULTS → job.execution
    const execution = ConfigLoader._mergeExecution(EXECUTION_DEFAULTS, job.execution || {});

    // query_limit 검증
    if (!Number.isInteger(execution.query_limit) || execution.query_limit < 1) {
      throw new Error(`query_limit must be a positive integer, got: ${execution.query_limit} in job '${job.id}'`);
    }

    // poll_interval_ms 검증
    if (!Number.isInteger(execution.poll_interval_ms) || execution.poll_interval_ms < 1) {
      throw new Error(`poll_interval_ms must be a positive integer, got: ${execution.poll_interval_ms} in job '${job.id}'`);
    }

    if (!VALID_START_MODES.has(execution.start_mode)) {
      throw new Error(`Invalid start_mode: "${execution.start_mode}" in job '${job.id}'`);
    }
    if (execution.start_mode === 'rid_after') {
      const ridVal = execution.rid_after;
      if (ridVal === undefined || ridVal === null) {
        throw new Error(`rid_after is required when start_mode is "rid_after" in job '${job.id}'`);
      }
      if (!/^\d+$/.test(String(ridVal))) {
        throw new Error(`rid_after must be a non-negative integer, got: ${ridVal} in job '${job.id}'`);
      }
    }
    if (!VALID_ON_SAVE_FAILURE.has(execution.on_save_failure)) {
      throw new Error(`Invalid on_save_failure: "${execution.on_save_failure}" in job '${job.id}'`);
    }

    const rrs = execution.rid_range_size;
    if (!Number.isInteger(rrs) || rrs < 1) {
      throw new Error(`rid_range_size must be a positive integer, got: ${rrs} in job '${job.id}'`);
    }

    // retry 구조 검증
    if (execution.retry !== undefined) {
      if (typeof execution.retry !== 'object' || execution.retry === null || Array.isArray(execution.retry)) {
        throw new Error(`retry must be an object in job '${job.id}'`);
      }
      const r = execution.retry;
      const VALID_STRATEGIES = ['exponential', 'linear'];
      if (r.strategy !== undefined && !VALID_STRATEGIES.includes(r.strategy)) {
        throw new Error(`retry.strategy must be 'exponential' or 'linear', got: "${r.strategy}" in job '${job.id}'`);
      }
      if (r.max_attempts !== undefined && r.max_attempts !== null) {
        if (!Number.isInteger(r.max_attempts) || r.max_attempts < 1) {
          throw new Error(`retry.max_attempts must be a positive integer or null, got: ${r.max_attempts} in job '${job.id}'`);
        }
      }
      if (r.base_delay_ms !== undefined) {
        if (!Number.isInteger(r.base_delay_ms) || r.base_delay_ms < 0) {
          throw new Error(`retry.base_delay_ms must be a non-negative integer, got: ${r.base_delay_ms} in job '${job.id}'`);
        }
      }
      if (r.max_delay_ms !== undefined) {
        if (!Number.isInteger(r.max_delay_ms) || r.max_delay_ms < 0) {
          throw new Error(`retry.max_delay_ms must be a non-negative integer, got: ${r.max_delay_ms} in job '${job.id}'`);
        }
      }
      if (r.multiplier !== undefined) {
        if (typeof r.multiplier !== 'number' || r.multiplier <= 0) {
          throw new Error(`retry.multiplier must be a positive number, got: ${r.multiplier} in job '${job.id}'`);
        }
      }
    }

    // integrity 구조 검증
    if (execution.integrity !== undefined) {
      if (typeof execution.integrity !== 'object' || execution.integrity === null || Array.isArray(execution.integrity)) {
        throw new Error(`integrity must be an object in job '${job.id}'`);
      }
      if (execution.integrity.enabled !== undefined && typeof execution.integrity.enabled !== 'boolean') {
        throw new Error(`integrity.enabled must be a boolean, got: ${typeof execution.integrity.enabled} in job '${job.id}'`);
      }
    }

    // tag_identifier 검증
    const VALID_MODES = ['prefix', 'suffix', 'none'];
    const tagId = job.source.tag_identifier;
    if (tagId) {
      if (tagId.mode === undefined || tagId.mode === null) {
        throw new Error(`tag_identifier.mode is required when tag_identifier is specified (must be one of: ${VALID_MODES.join(', ')}) in job '${job.id}'`);
      }
      if (!VALID_MODES.includes(tagId.mode)) {
        throw new Error(`Invalid tag_identifier.mode '${tagId.mode}' (must be one of: ${VALID_MODES.join(', ')}) in job '${job.id}'`);
      }
    }
    if (tagId && tagId.value !== undefined && typeof tagId.value !== 'string') {
      throw new Error(`tag_identifier.value must be a string, got: ${typeof tagId.value} in job '${job.id}'`);
    }

    // source.columns 검증
    let sourceColumns = null;
    const rawCols = job.source.columns;
    if (rawCols !== undefined && rawCols !== null) {
      if (!Array.isArray(rawCols) || rawCols.length === 0) {
        throw new Error(`source.columns must be a non-empty array when specified in job '${job.id}'`);
      }
      if (!rawCols.every(c => typeof c === 'string' && c.trim() !== '')) {
        throw new Error(`source.columns entries must be non-empty strings in job '${job.id}'`);
      }
      sourceColumns = rawCols.map(c => c.toUpperCase());
    }

    return new JobConfig({
      id: job.id,
      shutdown_timeout_ms: shutdownTimeout,
      checkpoint,
      source: {
        server: srcServer,
        table: job.source.table,
        tag_identifier: job.source.tag_identifier || { mode: 'none', value: '' },
        columns: sourceColumns,
      },
      target: { server: dstServer, table: job.target.table },
      execution,
    });
  }

  /**
   * 필드 레벨 merge: 오른쪽 인수가 우선
   * _mergeExecution(base, top) → top > base
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
