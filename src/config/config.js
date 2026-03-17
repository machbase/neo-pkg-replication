'use strict';

const path = require('path');
const { getInstance: getLogger } = require('../lib/logger.js');

const fs = require('fs/promises');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '../../config.json');
const CHECKPOINT_DIRECTORY = path.join(__dirname, '../../data');


// ─── Config ───────────────────────────────────────────────────────────────────

class Config {
  constructor(filePath, { version, servers, replication, logging, api }) {
    this.filePath    = filePath;
    this.version     = version;
    this.servers     = servers;
    this.replication = replication;
    this.logging     = logging;
    this.api         = api;
  }

  static async load(filePath = DEFAULT_CONFIG_PATH) {
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
    if (!Array.isArray(raw.servers)) {
      throw new Error('config.servers is required and must be an array');
    }
    if (!Array.isArray(raw.replication?.jobs)) {
      throw new Error('config.replication.jobs is required and must be an array');
    }

    const servers = raw.servers.map(srv => {
      const s = new ServerConfig(srv);
      s.valid();
      return s;
    });

    const jobs = raw.replication.jobs.map(job => Config._buildJob(job, servers));

    return new Config(filePath, {
      version: raw.version,
      servers,
      replication: new ReplicationConfig({ jobs }),
      logging: Config._buildLogging(raw.logging),
      api: Config._buildApi(raw.api),
    });
  }

  async save() {
    const data = {
      version: this.version,
      servers: this.servers,
      logging: this.logging,
      api: this.api,
      replication: this.replication,
    };
    const tmp = `${this.filePath}.${process.hrtime.bigint()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }

  addJob(rawJob) {
    const jobConfig = Config._buildJob(rawJob, this.servers);
    this.replication.jobs.push(jobConfig);
    return jobConfig;
  }

  updateJob(id, rawJob) {
    const jobConfig = Config._buildJob({ ...rawJob, id }, this.servers);
    const idx = this.replication.jobs.findIndex(j => j.id === id);
    if (idx !== -1) this.replication.jobs[idx] = jobConfig;
    return jobConfig;
  }

  removeJob(id) {
    this.replication.jobs = this.replication.jobs.filter(j => j.id !== id);
  }

  static _buildApi(raw = {}) {
    const cors = raw.cors !== undefined ? raw.cors : { origin: '*' };
    const api = new ApiConfig({
      enabled: raw.enabled !== false,
      port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : 8080,
      cors,
    });
    api.valid();
    return api;
  }

  static _buildLogging(raw = {}) {
    const level  = raw.level ?? 'info';
    const stdout = raw.stdout !== undefined ? raw.stdout : true;
    const file   = raw.file || {};
    const fileEnabled = file.enabled !== undefined ? file.enabled : false;

    const logging = new LoggingConfig({
      level,
      stdout,
      file: new LoggingFileConfig({
        enabled: fileEnabled,
        directory: file.directory || './logs',
      }),
    });
    logging.valid();
    return logging;
  }

  static _buildJob(job, servers) {
    const rawRetry = job.retry;
    let retry;
    if (rawRetry !== undefined) {
      if (typeof rawRetry !== 'object' || rawRetry === null || Array.isArray(rawRetry)) {
        throw new Error(`retry must be an object in job '${job.id}'`);
      }
      retry = new RetryConfig(rawRetry);
    }

    const rawIntegrity = job.integrity;
    let integrity;
    if (rawIntegrity !== undefined) {
      if (typeof rawIntegrity !== 'object' || rawIntegrity === null || Array.isArray(rawIntegrity)) {
        throw new Error(`integrity must be an object in job '${job.id}'`);
      }
      integrity = new IntegrityConfig(rawIntegrity);
    }

    const rawTagId = job.source?.tag_identifier;
    const tagIdentifier = rawTagId
      ? new TagIdentifierConfig(rawTagId)
      : new TagIdentifierConfig({ mode: 'none', value: '' });

    const rawCols = job.source?.columns;
    let sourceColumns = null;
    if (rawCols !== undefined && rawCols !== null) {
      sourceColumns = Array.isArray(rawCols)
        ? rawCols.map(c => (typeof c === 'string' ? c.toUpperCase() : c))
        : rawCols;
    }

    const source = job.source
      ? new SourceConfig({
          server:         job.source.server,
          table:          job.source.table,
          tag_identifier: tagIdentifier,
          columns:        sourceColumns,
        })
      : null;

    const target = job.target
      ? new TargetConfig({ server: job.target.server, table: job.target.table })
      : null;

    const jobConfig = new JobConfig({
      id:                  job.id,
      shutdown_timeout_ms: job.shutdown_timeout_ms ?? 30000,
      source,
      target,
      query_limit:         job.query_limit,
      rid_range_size:      job.rid_range_size,
      poll_interval_ms:    job.poll_interval_ms,
      start_mode:          job.start_mode,
      rid_after:           job.rid_after,
      on_save_failure:     job.on_save_failure,
      integrity,
      retry,
    });
    jobConfig.valid(servers);
    return jobConfig;
  }
}

// ─── ServerConfig ─────────────────────────────────────────────────────────────

class ServerConfig {
  constructor({ name, host, port, user, password }) {
    this.name     = name;
    this.host     = host;
    this.port     = port;
    this.user     = user;
    this.password = password;
  }

  valid() {
    if (!this.name) throw new Error(`servers[].name is required`);
    if (!this.host) throw new Error(`servers.${this.name}.host is required`);
    if (!this.port) throw new Error(`servers.${this.name}.port is required`);
    if (!this.user) throw new Error(`servers.${this.name}.user is required`);
    if (this.password === undefined) throw new Error(`servers.${this.name}.password is required`);
  }
}

// ─── TagIdentifierConfig ──────────────────────────────────────────────────────

const VALID_TAG_IDENTIFIER_MODES = ['prefix', 'suffix', 'none'];

class TagIdentifierConfig {
  constructor({ mode, value = '' }) {
    this.mode  = mode;
    this.value = value;
  }

  valid(jobId) {
    if (this.mode === undefined || this.mode === null) {
      throw new Error(`tag_identifier.mode is required (must be one of: ${VALID_TAG_IDENTIFIER_MODES.join(', ')}) in job '${jobId}'`);
    }
    if (!VALID_TAG_IDENTIFIER_MODES.includes(this.mode)) {
      throw new Error(`Invalid tag_identifier.mode '${this.mode}' (must be one of: ${VALID_TAG_IDENTIFIER_MODES.join(', ')}) in job '${jobId}'`);
    }
    if (this.value !== undefined && typeof this.value !== 'string') {
      throw new Error(`tag_identifier.value must be a string, got: ${typeof this.value} in job '${jobId}'`);
    }
  }
}

// ─── SourceConfig ─────────────────────────────────────────────────────────────

class SourceConfig {
  constructor({ server, table, columns, tag_identifier }) {
    this.server         = server;
    this.table          = table;
    this.columns        = columns;
    this.tag_identifier = tag_identifier;
  }

  valid(jobId, servers) {
    if (!this.table || typeof this.table !== 'string') {
      throw new Error(`job.source.table is required and must be a non-empty string in job '${jobId}'`);
    }
    if (!servers.find(s => s.name === this.server)) {
      throw new Error(`Unknown source server alias: "${this.server}" in job '${jobId}'`);
    }
    if (this.tag_identifier) {
      this.tag_identifier.valid(jobId);
    }
    if (this.columns !== null && this.columns !== undefined) {
      if (!Array.isArray(this.columns) || this.columns.length === 0) {
        throw new Error(`source.columns must be a non-empty array when specified in job '${jobId}'`);
      }
      if (!this.columns.every(c => typeof c === 'string' && c.trim() !== '')) {
        throw new Error(`source.columns entries must be non-empty strings in job '${jobId}'`);
      }
    }
  }
}

// ─── TargetConfig ─────────────────────────────────────────────────────────────

class TargetConfig {
  constructor({ server, table }) {
    this.server = server;
    this.table  = table;
  }

  valid(jobId, servers) {
    if (!this.table || typeof this.table !== 'string') {
      throw new Error(`job.target.table is required and must be a non-empty string in job '${jobId}'`);
    }
    if (!servers.find(s => s.name === this.server)) {
      throw new Error(`Unknown target server alias: "${this.server}" in job '${jobId}'`);
    }
  }
}

// ─── IntegrityConfig ──────────────────────────────────────────────────────────

class IntegrityConfig {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
  }

  valid(jobId) {
    if (this.enabled !== undefined && typeof this.enabled !== 'boolean') {
      throw new Error(`integrity.enabled must be a boolean, got: ${typeof this.enabled} in job '${jobId}'`);
    }
  }
}

// ─── RetryConfig ──────────────────────────────────────────────────────────────

class RetryConfig {
  constructor({ strategy, max_attempts, base_delay_ms, max_delay_ms, multiplier } = {}) {
    this.strategy      = strategy;
    this.max_attempts  = max_attempts;
    this.base_delay_ms = base_delay_ms;
    this.max_delay_ms  = max_delay_ms;
    this.multiplier    = multiplier;
  }

  valid(jobId) {
    const VALID_STRATEGIES = ['exponential', 'linear'];
    if (this.strategy !== undefined && !VALID_STRATEGIES.includes(this.strategy)) {
      throw new Error(`retry.strategy must be 'exponential' or 'linear', got: "${this.strategy}" in job '${jobId}'`);
    }
    if (this.max_attempts !== undefined && this.max_attempts !== null) {
      if (!Number.isInteger(this.max_attempts) || this.max_attempts < 1) {
        throw new Error(`retry.max_attempts must be a positive integer or null, got: ${this.max_attempts} in job '${jobId}'`);
      }
    }
    if (this.base_delay_ms !== undefined) {
      if (!Number.isInteger(this.base_delay_ms) || this.base_delay_ms < 0) {
        throw new Error(`retry.base_delay_ms must be a non-negative integer, got: ${this.base_delay_ms} in job '${jobId}'`);
      }
    }
    if (this.max_delay_ms !== undefined) {
      if (!Number.isInteger(this.max_delay_ms) || this.max_delay_ms < 0) {
        throw new Error(`retry.max_delay_ms must be a non-negative integer, got: ${this.max_delay_ms} in job '${jobId}'`);
      }
    }
    if (this.multiplier !== undefined) {
      if (typeof this.multiplier !== 'number' || this.multiplier <= 0) {
        throw new Error(`retry.multiplier must be a positive number, got: ${this.multiplier} in job '${jobId}'`);
      }
    }
  }
}

// ─── JobConfig ───────────────────────────────────────────────────────────────

const VALID_START_MODES = new Set(['full', 'now', 'rid_after']);
const VALID_ON_SAVE_FAILURE = new Set(['continue', 'abort']);

class JobConfig {
  constructor({ id, shutdown_timeout_ms, source, target,
                query_limit, rid_range_size, poll_interval_ms,
                start_mode, rid_after, on_save_failure,
                integrity, retry }) {
    this.id                  = id;
    this.shutdown_timeout_ms = shutdown_timeout_ms;
    this.source              = source;
    this.target              = target;
    this.query_limit         = query_limit      ?? 5000;
    this.rid_range_size      = rid_range_size   ?? 50000;
    this.poll_interval_ms    = poll_interval_ms ?? 1000;
    this.start_mode          = start_mode       ?? 'full';
    this.rid_after           = rid_after;
    this.on_save_failure     = on_save_failure  ?? 'continue';
    this.integrity           = integrity;
    this.retry               = retry;
  }

  valid(servers) {
    if (!this.id) throw new Error(`job.id is required`);

    if (this.shutdown_timeout_ms !== undefined) {
      if (!Number.isInteger(this.shutdown_timeout_ms) || this.shutdown_timeout_ms < 1) {
        getLogger().warn('config', {
          job_id: this.id,
          msg: `shutdown_timeout_ms must be a positive integer, got: ${this.shutdown_timeout_ms}, using default 30000`,
        });
        this.shutdown_timeout_ms = 30000;
      }
    }

    if (!this.source || typeof this.source !== 'object') {
      throw new Error(`job.source is required and must be an object in job '${this.id}'`);
    }
    if (!this.target || typeof this.target !== 'object') {
      throw new Error(`job.target is required and must be an object in job '${this.id}'`);
    }

    this.source.valid(this.id, servers);
    this.target.valid(this.id, servers);

    if (!Number.isInteger(this.query_limit) || this.query_limit < 1) {
      throw new Error(`query_limit must be a positive integer, got: ${this.query_limit} in job '${this.id}'`);
    }
    if (!Number.isInteger(this.poll_interval_ms) || this.poll_interval_ms < 1) {
      throw new Error(`poll_interval_ms must be a positive integer, got: ${this.poll_interval_ms} in job '${this.id}'`);
    }
    if (!VALID_START_MODES.has(this.start_mode)) {
      throw new Error(`Invalid start_mode: "${this.start_mode}" in job '${this.id}'`);
    }
    if (this.start_mode === 'rid_after') {
      if (this.rid_after === undefined || this.rid_after === null) {
        throw new Error(`rid_after is required when start_mode is "rid_after" in job '${this.id}'`);
      }
      if (!/^\d+$/.test(String(this.rid_after))) {
        throw new Error(`rid_after must be a non-negative integer, got: ${this.rid_after} in job '${this.id}'`);
      }
    }
    if (!VALID_ON_SAVE_FAILURE.has(this.on_save_failure)) {
      throw new Error(`Invalid on_save_failure: "${this.on_save_failure}" in job '${this.id}'`);
    }
    if (!Number.isInteger(this.rid_range_size) || this.rid_range_size < 1) {
      throw new Error(`rid_range_size must be a positive integer, got: ${this.rid_range_size} in job '${this.id}'`);
    }

    if (this.retry !== undefined) {
      if (typeof this.retry !== 'object' || this.retry === null || Array.isArray(this.retry)) {
        throw new Error(`retry must be an object in job '${this.id}'`);
      }
      this.retry.valid(this.id);
    }

    if (this.integrity !== undefined) {
      if (typeof this.integrity !== 'object' || this.integrity === null || Array.isArray(this.integrity)) {
        throw new Error(`integrity must be an object in job '${this.id}'`);
      }
      this.integrity.valid(this.id);
    }
  }
}

// ─── LoggingFileConfig ────────────────────────────────────────────────────────

class LoggingFileConfig {
  constructor({ enabled, directory }) {
    this.enabled   = enabled;
    this.directory = directory;
  }

  valid() {
    if (typeof this.enabled !== 'boolean') {
      throw new Error(`logging.file.enabled must be a boolean (got: ${typeof this.enabled})`);
    }
    if (this.enabled) {
      if (this.directory !== undefined && (typeof this.directory !== 'string' || this.directory === '')) {
        throw new Error('logging.file.directory must be a non-empty string');
      }
    }
  }
}

// ─── LoggingConfig ────────────────────────────────────────────────────────────

class LoggingConfig {
  constructor({ level, stdout, file }) {
    this.level  = level;
    this.stdout = stdout;
    this.file   = file;
  }

  valid() {
    const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
    if (!VALID_LEVELS.has(this.level)) {
      throw new Error(`logging.level must be one of: debug, info, warn, error (got: "${this.level}")`);
    }
    if (typeof this.stdout !== 'boolean') {
      throw new Error(`logging.stdout must be a boolean (got: ${typeof this.stdout})`);
    }
    this.file.valid();
  }
}

// ─── ApiConfig ────────────────────────────────────────────────────────────────

class ApiConfig {
  constructor({ enabled, port, cors }) {
    this.enabled = enabled;
    this.port    = port;
    this.cors    = cors;
  }

  valid() {
    // enabled/port/cors have defaults — no strict validation needed
  }
}

// ─── ReplicationConfig ────────────────────────────────────────────────────────

class ReplicationConfig {
  constructor({ jobs }) {
    this.jobs = jobs;
  }
}

module.exports = { Config, JobConfig, ServerConfig, SourceConfig, TargetConfig,
                   IntegrityConfig, RetryConfig, TagIdentifierConfig,
                   LoggingConfig, LoggingFileConfig, ApiConfig, ReplicationConfig,
                   CHECKPOINT_DIRECTORY };
