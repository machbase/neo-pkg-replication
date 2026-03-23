'use strict';

const fs = require('fs');
const path = require('path');
const { JsonFile } = require('../src/lib/json_file.js');
const { Replicator } = require('../src/replication/replicator.js');
const { getInstance: getLogger } = require('../src/lib/logger.js');

const CONF_DIR = path.join(process.cwd(), 'conf.d');

// status 값: 'stopped' | 'running' | 'stopping'
class ReplicatorManager {
  constructor() {
    // Map<configName, { config, replicator, status, promise }>
    this._registry = new Map();
  }

  // ── conf.d 스캔 및 auto start ──────────────────────────────────────────────

  autoStart() {
    let files;
    try {
      files = fs.readdirSync(CONF_DIR).filter(f => f.endsWith('.json') && f !== 'server.json');
    } catch (_) {
      getLogger().warn('manager', { msg: `conf.d not found or unreadable: ${CONF_DIR}` });
      return;
    }

    for (const file of files) {
      const name = file.replace(/\.json$/, '');
      try {
        const config = new JsonFile(path.join(CONF_DIR, file)).read();
        this._register(name, config);
        this._start(name);
      } catch (err) {
        getLogger().error('manager', { name, msg: `auto start failed: ${err.message}` });
      }
    }
  }

  // ── REST API 용 메서드 ─────────────────────────────────────────────────────

  list() {
    const result = [];
    for (const [name, entry] of this._registry) {
      result.push({ name, status: entry.status });
    }
    return result;
  }

  get(name) {
    const entry = this._registry.get(name);
    if (!entry) return null;
    return { name, status: entry.status, config: entry.config };
  }

  register(name, config) {
    if (this._registry.has(name)) {
      throw new Error(`replicator '${name}' already exists`);
    }
    const newId = config.id || `${config.source?.table}_${config.target?.table || config.source?.table}`;
    for (const entry of this._registry.values()) {
      const existingId = entry.config.id || `${entry.config.source?.table}_${entry.config.target?.table || entry.config.source?.table}`;
      if (existingId === newId) throw new Error(`duplicate replicator id '${newId}'`);
    }
    this._saveConfig(name, config);
    this._register(name, config);
    return { name, status: 'stopped' };
  }

  update(name, config) {
    const entry = this._registry.get(name);
    if (!entry) throw new Error(`replicator '${name}' not found`);
    if (entry.status === 'running') throw new Error(`replicator '${name}' is running, stop first`);
    const newId = config.id || `${config.source?.table}_${config.target?.table || config.source?.table}`;
    for (const [n, e] of this._registry) {
      if (n === name) continue;
      const existingId = e.config.id || `${e.config.source?.table}_${e.config.target?.table || e.config.source?.table}`;
      if (existingId === newId) throw new Error(`duplicate replicator id '${newId}'`);
    }
    this._saveConfig(name, config);
    entry.config = config;
    entry.replicator = null;
    return { name, status: entry.status };
  }

  remove(name) {
    const entry = this._registry.get(name);
    if (!entry) throw new Error(`replicator '${name}' not found`);
    if (entry.status === 'running') throw new Error(`replicator '${name}' is running, stop first`);
    this._deleteConfig(name);
    this._registry.delete(name);
  }

  start(name) {
    const entry = this._registry.get(name);
    if (!entry) throw new Error(`replicator '${name}' not found`);
    if (entry.status === 'running') throw new Error(`replicator '${name}' is already running`);
    this._start(name);
    return { name, status: 'running' };
  }

  stop(name) {
    const entry = this._registry.get(name);
    if (!entry) throw new Error(`replicator '${name}' not found`);
    if (entry.status !== 'running') throw new Error(`replicator '${name}' is not running`);
    entry.status = 'stopping';
    entry.replicator.shutdown();
    return { name, status: 'stopping' };
  }

  stopAll() {
    for (const [name, entry] of this._registry) {
      if (entry.status === 'running') {
        entry.status = 'stopping';
        entry.replicator.shutdown();
        getLogger().info('manager', { name, msg: 'shutdown requested' });
      }
    }
  }

  // ── 내부 ──────────────────────────────────────────────────────────────────

  _register(name, config) {
    this._registry.set(name, { config, replicator: null, status: 'stopped', promise: null });
  }

  _start(name) {
    const entry = this._registry.get(name);
    const replicator = new Replicator(entry.config);
    entry.replicator = replicator;
    entry.status = 'running';

    entry.promise = replicator.start().then(() => {
      entry.status = 'stopped';
      entry.replicator = null;
      getLogger().info('manager', { name, msg: 'stopped' });
    }).catch(err => {
      entry.status = 'stopped';
      entry.replicator = null;
      getLogger().error('manager', { name, msg: `exited with error: ${err.message}` });
    });
  }

  _saveConfig(name, config) {
    new JsonFile(path.join(CONF_DIR, `${name}.json`)).write(config);
  }

  _deleteConfig(name) {
    try { fs.unlinkSync(path.join(CONF_DIR, `${name}.json`)); } catch (_) {}
  }
}

module.exports = { ReplicatorManager };
