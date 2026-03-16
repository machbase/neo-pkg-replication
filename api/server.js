'use strict';

const http = require('http');
const ConfigLoader = require('../config/config.js');
const { getInstance: getLogger } = require('../logger/logger.js');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

class ApiServer {
  constructor(replicator, configPath) {
    this.replicator = replicator;
    this.configPath = configPath;
    this.server = null;
  }

  start(port) {
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch(err => {
        getLogger().error('api', { msg: err.message });
        send(res, 500, { error: err.message });
      });
    });
    this.server.listen(port, () => {
      getLogger().info('api', { msg: `API server listening on port ${port}` });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  async _handle(req, res) {
    const { method, url } = req;
    const parts = url.replace(/\?.*$/, '').split('/').filter(Boolean);
    // parts: ['api', 'jobs'] or ['api', 'jobs', ':id'] or ['api', 'jobs', ':id', 'start']

    if (parts[0] !== 'api' || parts[1] !== 'jobs') {
      return send(res, 404, { error: 'Not found' });
    }

    const id = parts[2];
    const action = parts[3];

    // GET /api/jobs
    if (method === 'GET' && !id) {
      const jobs = [];
      for (const [, entry] of this.replicator.jobRegistry) {
        jobs.push({ id: entry.jobConfig.id, status: entry.status, jobConfig: entry.jobConfig });
      }
      return send(res, 200, jobs);
    }

    // GET /api/jobs/:id
    if (method === 'GET' && id && !action) {
      const entry = this.replicator.jobRegistry.get(id);
      if (!entry) return send(res, 404, { error: `Job '${id}' not found` });
      return send(res, 200, { id: entry.jobConfig.id, status: entry.status, jobConfig: entry.jobConfig });
    }

    // POST /api/jobs
    if (method === 'POST' && !id) {
      const body = await parseBody(req);
      const rawConfig = await this._readRawConfig();
      if (this.replicator.jobRegistry.has(body.id)) {
        return send(res, 409, { error: `Job '${body.id}' already exists` });
      }
      let jobConfig;
      try {
        jobConfig = ConfigLoader._processJob(body, rawConfig.servers);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      rawConfig.replication.jobs.push(body);
      await ConfigLoader.save(this.configPath, rawConfig);
      this.replicator.jobRegistry.set(jobConfig.id, { jobConfig, shutdownFlag: { value: false }, promise: null, status: 'stopped' });
      return send(res, 201, { id: jobConfig.id, status: 'stopped' });
    }

    // PUT /api/jobs/:id
    if (method === 'PUT' && id && !action) {
      const entry = this.replicator.jobRegistry.get(id);
      if (!entry) return send(res, 404, { error: `Job '${id}' not found` });
      if (entry.status === 'running') return send(res, 409, { error: `Job '${id}' is running` });
      const body = await parseBody(req);
      const rawConfig = await this._readRawConfig();
      let jobConfig;
      try {
        jobConfig = ConfigLoader._processJob({ ...body, id }, rawConfig.servers);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      const idx = rawConfig.replication.jobs.findIndex(j => j.id === id);
      if (idx !== -1) rawConfig.replication.jobs[idx] = { ...body, id };
      await ConfigLoader.save(this.configPath, rawConfig);
      entry.jobConfig = jobConfig;
      return send(res, 200, { id: jobConfig.id, status: entry.status });
    }

    // DELETE /api/jobs/:id
    if (method === 'DELETE' && id && !action) {
      const entry = this.replicator.jobRegistry.get(id);
      if (!entry) return send(res, 404, { error: `Job '${id}' not found` });
      if (entry.status === 'running') return send(res, 409, { error: `Job '${id}' is running` });
      const rawConfig = await this._readRawConfig();
      rawConfig.replication.jobs = rawConfig.replication.jobs.filter(j => j.id !== id);
      await ConfigLoader.save(this.configPath, rawConfig);
      this.replicator.jobRegistry.delete(id);
      res.writeHead(204);
      return res.end();
    }

    // POST /api/jobs/:id/start
    if (method === 'POST' && id && action === 'start') {
      const entry = this.replicator.jobRegistry.get(id);
      if (!entry) return send(res, 404, { error: `Job '${id}' not found` });
      if (entry.status === 'running') return send(res, 409, { error: `Job '${id}' is already running` });
      this.replicator._startJob(entry.jobConfig);
      return send(res, 200, { id, status: 'running' });
    }

    // POST /api/jobs/:id/stop
    if (method === 'POST' && id && action === 'stop') {
      const entry = this.replicator.jobRegistry.get(id);
      if (!entry) return send(res, 404, { error: `Job '${id}' not found` });
      if (entry.status !== 'running') return send(res, 409, { error: `Job '${id}' is not running` });
      await this.replicator._stopJob(id);
      return send(res, 200, { id, status: 'stopped' });
    }

    return send(res, 404, { error: 'Not found' });
  }

  async _readRawConfig() {
    const fs = require('fs/promises');
    const content = await fs.readFile(this.configPath, 'utf-8');
    return JSON.parse(content);
  }
}

module.exports = { ApiServer };
