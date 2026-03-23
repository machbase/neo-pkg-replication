'use strict';

const path = require('path');
const { getInstance: getLogger } = require('../lib/logger.js');

const fs = require('fs');

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'config.json');
const CHECKPOINT_DIRECTORY = path.join(process.cwd(), 'data');


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

  static load(filePath = DEFAULT_CONFIG_PATH) {
    const content = fs.readFileSync(filePath, 'utf-8');
    let raw;
    try {
      raw = JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse config file '${filePath}': ${err.message}`);
    }

    if (raw.version !== 3) {
      throw new Error(`Unsupported config version: ${raw.version} (expected 3)`);
    }
    const rawServers = raw.servers ?? [];
    if (!Array.isArray(rawServers)) {
      throw new Error('config.servers must be an array');
    }
    const rawJobs = raw.replication?.jobs ?? [];
    if (!Array.isArray(rawJobs)) {
      throw new Error('config.replication.jobs must be an array');
    }

    const servers = rawServers.map(srv => {
      const s = new ServerConfig(srv);
      s.valid();
      return s;
    });

    const jobs = rawJobs.map(job => Config._buildJob(job, servers));

    return new Config(filePath, {
      version: raw.version,
      servers,
      replication: new ReplicationConfig({ jobs }),
      logging: Config._buildLogging(raw.logging),
      api: Config._buildApi(raw.api),
    });
  }

  save() {
    const data = {
      version: this.version,
      servers: this.servers,
      logging: this.logging,
      api: this.api,
      replication: this.replication,
    };
    const tmp = `${this.filePath}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
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

  addServer(raw) {
    const srv = new ServerConfig(raw);
    srv.valid();
    if (this.servers.find(s => s.name === srv.name))
      throw new Error(`Server '${srv.name}' already exists`);
    this.servers.push(srv);
    return srv;
  }

  updateServer(name, raw) {
    const idx = this.servers.findIndex(s => s.name === name);
    if (idx === -1) throw new Error(`Server '${name}' not found`);
    const srv = new ServerConfig({ ...raw, name });
    srv.valid();
    this.servers[idx] = srv;
    return srv;
  }

  removeServer(name) {
    const idx = this.servers.findIndex(s => s.name === name);
    if (idx === -1) throw new Error(`Server '${name}' not found`);
    this.servers.splice(idx, 1);
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

    const metaSync = job.metaSync;

    const rawCols = job.source?.columns;
    let sourceColumns = null;
    if (rawCols !== undefined && rawCols !== null) {
      sourceColumns = Array.isArray(rawCols)
        ? rawCols.map(c => (typeof c === 'string' ? c.toUpperCase() : c))
        : rawCols;
    }

    const rawFilter = job.source?.filter ?? null;
    const filter = rawFilter
      ? rawFilter.map(r => new ColumnFilterConfig(r))
      : null;

    const rawTransform = job.source?.transform ?? null;
    const transform = rawTransform
      ? rawTransform.map(r => new ColumnTransformConfig(r))
      : null;

    const source = job.source
      ? new SourceConfig({
          server:    job.source.server,
          table:     job.source.table,
          columns:   sourceColumns,
          filter,
          transform,
        })
      : null;

    const target = job.target
      ? new TargetConfig({ server: job.target.server, table: job.target.table, autoCreate: job.target.autoCreate })
      : null;

    const jobConfig = new JobConfig({
      id:                 job.id,
      autoStart:          job.autoStart,
      shutdownTimeoutMs:  job.shutdownTimeoutMs ?? 30000,
      source,
      target,
      queryLimit:         job.queryLimit,
      ridRangeSize:       job.ridRangeSize,
      pollIntervalMs:     job.pollIntervalMs,
      startMode:          job.startMode,
      ridAfter:           job.ridAfter,
      onSaveFailure:      job.onSaveFailure,
      integrity,
      metaSync,
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

// ─── ColumnFilterConfig ───────────────────────────────────────────────────────

class ColumnFilterConfig {
  constructor({ column, min, max, in: inList, like }) {
    this.column = typeof column === 'string' ? column.toUpperCase() : column;
    this.min    = min;
    this.max    = max;
    this.in     = inList;
    this.like   = like;
  }

  valid(jobId) {
    if (!this.column || typeof this.column !== 'string' || this.column.trim() === '') {
      throw new Error(`source.filter[].column must be a non-empty string in job '${jobId}'`);
    }
    if (this.min !== undefined) {
      if (typeof this.min !== 'number' || !Number.isFinite(this.min)) {
        throw new Error(`source.filter[].min must be a finite number in job '${jobId}'`);
      }
    }
    if (this.max !== undefined) {
      if (typeof this.max !== 'number' || !Number.isFinite(this.max)) {
        throw new Error(`source.filter[].max must be a finite number in job '${jobId}'`);
      }
    }
    if (this.min !== undefined && this.max !== undefined && this.min > this.max) {
      throw new Error(`source.filter[].min must be <= max in job '${jobId}'`);
    }
    if (this.in !== undefined) {
      if (!Array.isArray(this.in) || this.in.length === 0) {
        throw new Error(`source.filter[].in must be a non-empty array in job '${jobId}'`);
      }
      for (const v of this.in) {
        if (typeof v !== 'string') {
          throw new Error(`source.filter[].in must contain only strings in job '${jobId}'`);
        }
      }
    }
    if (this.like !== undefined && typeof this.like !== 'string') {
      throw new Error(`source.filter[].like must be a string in job '${jobId}'`);
    }
  }
}

// ─── ColumnTransformConfig ────────────────────────────────────────────────────

class ColumnTransformConfig {
  constructor({ column, add, multiply, prefix, suffix }) {
    this.column   = typeof column === 'string' ? column.toUpperCase() : column;
    this.add      = add      !== undefined ? add      : 0;
    this.multiply = multiply !== undefined ? multiply : 1;
    this.prefix   = prefix;
    this.suffix   = suffix;
  }

  valid(jobId) {
    if (!this.column || typeof this.column !== 'string' || this.column.trim() === '') {
      throw new Error(`source.transform[].column must be a non-empty string in job '${jobId}'`);
    }
    if (typeof this.add !== 'number' || !Number.isFinite(this.add)) {
      throw new Error(`source.transform[].add must be a finite number in job '${jobId}'`);
    }
    if (typeof this.multiply !== 'number' || !Number.isFinite(this.multiply)) {
      throw new Error(`source.transform[].multiply must be a finite number in job '${jobId}'`);
    }
    if (this.prefix !== undefined && typeof this.prefix !== 'string') {
      throw new Error(`source.transform[].prefix must be a string in job '${jobId}'`);
    }
    if (this.suffix !== undefined && typeof this.suffix !== 'string') {
      throw new Error(`source.transform[].suffix must be a string in job '${jobId}'`);
    }
  }
}

// ─── SourceConfig ─────────────────────────────────────────────────────────────

class SourceConfig {
  constructor({ server, table, columns, filter, transform }) {
    this.server    = server;
    this.table     = table;
    this.columns   = columns;
    this.filter    = filter    ?? null;
    this.transform = transform ?? null;
  }

  valid(jobId, servers) {
    if (!this.table || typeof this.table !== 'string') {
      throw new Error(`job.source.table is required and must be a non-empty string in job '${jobId}'`);
    }
    if (!servers.find(s => s.name === this.server)) {
      throw new Error(`Unknown source server alias: "${this.server}" in job '${jobId}'`);
    }
    if (this.columns !== null && this.columns !== undefined) {
      if (!Array.isArray(this.columns) || this.columns.length === 0) {
        throw new Error(`source.columns must be a non-empty array when specified in job '${jobId}'`);
      }
      if (!this.columns.every(c => typeof c === 'string' && c.trim() !== '')) {
        throw new Error(`source.columns entries must be non-empty strings in job '${jobId}'`);
      }
    }
    if (this.filter !== null && this.filter !== undefined) {
      if (!Array.isArray(this.filter) || this.filter.length === 0) {
        throw new Error(`source.filter must be a non-empty array when specified in job '${jobId}'`);
      }
      for (const r of this.filter) {
        r.valid(jobId);
      }
      const cols = this.filter.map(r => r.column);
      if (new Set(cols).size !== cols.length) {
        throw new Error(`source.filter has duplicate column entries in job '${jobId}'`);
      }
    }
    if (this.transform !== null && this.transform !== undefined) {
      if (!Array.isArray(this.transform) || this.transform.length === 0) {
        throw new Error(`source.transform must be a non-empty array when specified in job '${jobId}'`);
      }
      for (const r of this.transform) {
        r.valid(jobId);
      }
      const cols = this.transform.map(r => r.column);
      if (new Set(cols).size !== cols.length) {
        throw new Error(`source.transform has duplicate column entries in job '${jobId}'`);
      }
    }
  }
}

// ─── TargetConfig ─────────────────────────────────────────────────────────────

class TargetConfig {
  constructor({ server, table, autoCreate }) {
    this.server     = server;
    this.table      = table ?? '';
    this.autoCreate = autoCreate ?? false;
  }

  valid(jobId, servers) {
    if (typeof this.table !== 'string') {
      throw new Error(`job.target.table must be a string in job '${jobId}'`);
    }
    if (!this.table && !this.autoCreate) {
      throw new Error(`job.target.table is required when autoCreate is false in job '${jobId}'`);
    }
    if (!servers.find(s => s.name === this.server)) {
      throw new Error(`Unknown target server alias: "${this.server}" in job '${jobId}'`);
    }
    if (typeof this.autoCreate !== 'boolean') {
      throw new Error(`job.target.autoCreate must be a boolean in job '${jobId}'`);
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
  constructor({ strategy, maxAttempts, baseDelayMs, maxDelayMs, multiplier } = {}) {
    this.strategy    = strategy;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs  = maxDelayMs;
    this.multiplier  = multiplier;
  }

  valid(jobId) {
    const VALID_STRATEGIES = ['exponential', 'linear'];
    if (this.strategy !== undefined && !VALID_STRATEGIES.includes(this.strategy)) {
      throw new Error(`retry.strategy must be 'exponential' or 'linear', got: "${this.strategy}" in job '${jobId}'`);
    }
    if (this.maxAttempts !== undefined && this.maxAttempts !== null) {
      if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
        throw new Error(`retry.maxAttempts must be a positive integer or null, got: ${this.maxAttempts} in job '${jobId}'`);
      }
    }
    if (this.baseDelayMs !== undefined) {
      if (!Number.isInteger(this.baseDelayMs) || this.baseDelayMs < 0) {
        throw new Error(`retry.baseDelayMs must be a non-negative integer, got: ${this.baseDelayMs} in job '${jobId}'`);
      }
    }
    if (this.maxDelayMs !== undefined) {
      if (!Number.isInteger(this.maxDelayMs) || this.maxDelayMs < 0) {
        throw new Error(`retry.maxDelayMs must be a non-negative integer, got: ${this.maxDelayMs} in job '${jobId}'`);
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

const VALID_START_MODES = new Set(['full', 'now', 'ridAfter']);
const VALID_ON_SAVE_FAILURE = new Set(['continue', 'abort']);

class JobConfig {
  constructor({ id, autoStart, shutdownTimeoutMs, source, target,
                queryLimit, ridRangeSize, pollIntervalMs,
                startMode, ridAfter, onSaveFailure,
                integrity, metaSync, retry }) {
    this.id             = id;
    this.autoStart      = autoStart      ?? true;
    this.startMode      = startMode      ?? 'full';
    this.ridAfter       = ridAfter;
    this.source         = source;
    this.target         = target;
    this.pollIntervalMs = pollIntervalMs ?? 1000;
    this.queryLimit     = queryLimit     ?? 5000;
    this.ridRangeSize   = ridRangeSize   ?? 50000;
    this.onSaveFailure  = onSaveFailure  ?? 'continue';
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.integrity      = integrity;
    this.metaSync       = metaSync;
    this.retry          = retry;
  }

  valid(servers) {
    if (!this.id) throw new Error(`job.id is required`);

    if (typeof this.autoStart !== 'boolean') {
      throw new Error(`autoStart must be a boolean in job '${this.id}'`);
    }

    if (this.shutdownTimeoutMs !== undefined) {
      if (!Number.isInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 1) {
        getLogger().warn('config', {
          jobId: this.id,
          msg: `shutdownTimeoutMs must be a positive integer, got: ${this.shutdownTimeoutMs}, using default 30000`,
        });
        this.shutdownTimeoutMs = 30000;
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

    if (!Number.isInteger(this.queryLimit) || this.queryLimit < 1) {
      throw new Error(`queryLimit must be a positive integer, got: ${this.queryLimit} in job '${this.id}'`);
    }
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new Error(`pollIntervalMs must be a positive integer, got: ${this.pollIntervalMs} in job '${this.id}'`);
    }
    if (!VALID_START_MODES.has(this.startMode)) {
      throw new Error(`Invalid startMode: "${this.startMode}" in job '${this.id}'`);
    }
    if (this.startMode === 'ridAfter') {
      if (this.ridAfter === undefined || this.ridAfter === null) {
        throw new Error(`ridAfter is required when startMode is "ridAfter" in job '${this.id}'`);
      }
      if (!/^\d+$/.test(String(this.ridAfter))) {
        throw new Error(`ridAfter must be a non-negative integer, got: ${this.ridAfter} in job '${this.id}'`);
      }
    }
    if (!VALID_ON_SAVE_FAILURE.has(this.onSaveFailure)) {
      throw new Error(`Invalid onSaveFailure: "${this.onSaveFailure}" in job '${this.id}'`);
    }
    if (!Number.isInteger(this.ridRangeSize) || this.ridRangeSize < 1) {
      throw new Error(`ridRangeSize must be a positive integer, got: ${this.ridRangeSize} in job '${this.id}'`);
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

    if (this.metaSync !== undefined && typeof this.metaSync !== 'boolean') {
      throw new Error(`metaSync must be a boolean, got: ${typeof this.metaSync} in job '${this.id}'`);
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
    const VALID_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error']);
    if (!VALID_LEVELS.has(this.level)) {
      throw new Error(`logging.level must be one of: trace, debug, info, warn, error (got: "${this.level}")`);
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
                   IntegrityConfig, RetryConfig, ColumnFilterConfig, ColumnTransformConfig,
                   LoggingConfig, LoggingFileConfig, ApiConfig, ReplicationConfig,
                   CHECKPOINT_DIRECTORY };
