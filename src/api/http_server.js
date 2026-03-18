'use strict';

const express = require('express');
const cors = require('cors');
const { getInstance: getLogger } = require('../lib/logger.js');
const { MachbaseClient } = require('../db/client.js');
const { ColumnType } = require('../db/types.js');

// ─── Response 클래스 ──────────────────────────────────────────────────────────

class Response {
  constructor(data = null, reason = null) {
    this.ok     = !reason;
    this.reason = reason;
    this.data   = data;
  }
}

class ServerResponse {
  constructor({ name, host, port, user }) {
    this.name = name;
    this.host = host;
    this.port = port;
    this.user = user;
  }
}

// ─── HttpServer ───────────────────────────────────────────────────────────────

class HttpServer {
  constructor(scheduler, config) {
    this.scheduler = scheduler;
    this.config = config;
    this.server = null;
  }

  start(port, corsOptions) {
    const app = express();
    app.use(cors(corsOptions));
    app.use(express.json());
    app.use((req, res, next) => {
      res.on('finish', () => {
        getLogger().info('api', { method: req.method, path: req.path, status: res.statusCode });
      });
      next();
    });

    app.get('/api/servers',                            (req, res) => this._listServers(req, res));
    app.get('/api/servers/:name',                      (req, res) => this._getServer(req, res));
    app.post('/api/servers',                           (req, res) => this._createServer(req, res));
    app.put('/api/servers/:name',                      (req, res) => this._updateServer(req, res));
    app.delete('/api/servers/:name',                   (req, res) => this._deleteServer(req, res));
    app.get('/api/servers/:name/tables',               (req, res) => this._listTables(req, res));
    app.get('/api/servers/:name/tables/:table/schema', (req, res) => this._getTableSchema(req, res));
    app.get('/api/servers/:name/health',               (req, res) => this._checkHealth(req, res));

    app.get('/api/jobs',          (req, res) => this._listJobs(req, res));
    app.get('/api/jobs/:id',      (req, res) => this._getJob(req, res));
    app.post('/api/jobs',         (req, res) => this._createJob(req, res));
    app.put('/api/jobs/:id',      (req, res) => this._updateJob(req, res));
    app.delete('/api/jobs/:id',   (req, res) => this._deleteJob(req, res));
    app.post('/api/jobs/:id/start', (req, res) => this._startJob(req, res));
    app.post('/api/jobs/:id/stop',  (req, res) => this._stopJob(req, res));

    app.use((err, _req, res, _next) => {
      getLogger().error('api', { msg: err.message });
      res.status(500).json(new Response(null, err.message));
    });

    this.server = app.listen(port, () => {
      getLogger().info('api', { msg: `API server listening on port ${port}` });
    });
  }

  stop() {
    if (this.server) {
      this.server.closeAllConnections();
      this.server.close();
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  // GET /api/servers → Response<ServerResponse[]>
  _listServers(_req, res) {
    const data = this.config.servers.map(s => new ServerResponse(s));
    res.json(new Response(data));
  }

  // GET /api/servers/:name → Response<ServerResponse>
  _getServer(req, res) {
    const { name } = req.params;
    const srv = this.config.servers.find(s => s.name === name);
    if (!srv)
      return res.status(404).json(new Response(null, `Server '${name}' not found`));
    res.json(new Response(new ServerResponse(srv)));
  }

  // POST /api/servers → Response<ServerResponse> (201)
  async _createServer(req, res) {
    let srv;
    try {
      srv = this.config.addServer(req.body);
    } catch (e) {
      const status = e.message.includes('already exists') ? 409 : 400;
      return res.status(status).json(new Response(null, e.message));
    }
    await this.config.save();
    res.status(201).json(new Response(new ServerResponse(srv)));
  }

  // PUT /api/servers/:name → Response<ServerResponse>
  async _updateServer(req, res) {
    const { name } = req.params;
    let srv;
    try {
      srv = this.config.updateServer(name, req.body);
    } catch (e) {
      const status = e.message.includes('not found') ? 404 : 400;
      return res.status(status).json(new Response(null, e.message));
    }
    await this.config.save();
    res.json(new Response(new ServerResponse(srv)));
  }

  // DELETE /api/servers/:name → 204
  async _deleteServer(req, res) {
    const { name } = req.params;
    if (!this.config.servers.find(s => s.name === name))
      return res.status(404).json(new Response(null, `Server '${name}' not found`));

    const jobs = this.config.replication.jobs;
    const inUse = jobs.find(j => j.source?.server === name || j.target?.server === name);
    if (inUse)
      return res.status(409).json(new Response(null, `Server '${name}' is referenced by job '${inUse.id}'`));

    this.config.removeServer(name);
    await this.config.save();
    res.status(204).end();
  }

  // GET /api/servers/:name/tables → Response<{name, type}[]>
  async _listTables(req, res) {
    const { name } = req.params;
    const srv = this.config.servers.find(s => s.name === name);
    if (!srv)
      return res.status(404).json(new Response(null, `Server '${name}' not found`));

    const client = new MachbaseClient(srv);
    try {
      await client.connect();
      const rows = await client.selectAllTables();
      const data = rows.map(r => ({ name: r.NAME, type: r.TYPE === 6 ? 'TAG' : 'LOG' }));
      res.json(new Response(data));
    } catch (e) {
      res.status(500).json(new Response(null, e.message));
    } finally {
      try { await client.close(); } catch (_) {}
    }
  }

  // GET /api/servers/:name/tables/:table/schema → Response<column[]>
  async _getTableSchema(req, res) {
    const { name, table } = req.params;
    const srv = this.config.servers.find(s => s.name === name);
    if (!srv)
      return res.status(404).json(new Response(null, `Server '${name}' not found`));

    const client = new MachbaseClient(srv);
    try {
      await client.connect();
      const rows = await client.selectColumnsByTableName(table.toUpperCase());
      if (!rows || rows.length === 0)
        return res.status(404).json(new Response(null, `Table '${table}' not found`));
      const data = rows.map(r => ({
        name:     r.NAME,
        type:     ColumnType.fromCode(r.TYPE).type,
        length:   r.LENGTH,
      }));
      res.json(new Response(data));
    } catch (e) {
      res.status(500).json(new Response(null, e.message));
    } finally {
      try { await client.close(); } catch (_) {}
    }
  }

  // GET /api/servers/:name/health → Response<null>
  async _checkHealth(req, res) {
    const { name } = req.params;
    const srv = this.config.servers.find(s => s.name === name);
    if (!srv)
      return res.status(404).json(new Response(null, `Server '${name}' not found`));

    const client = new MachbaseClient(srv);
    try {
      await client.connect();
      await client.close();
      res.json(new Response());
    } catch (e) {
      res.json(new Response(null, e.message));
    }
  }

  // GET /api/jobs → Response<JobResponse[]>
  _listJobs(_req, res) {
    const data = this.scheduler.listEntries().map(e =>
      ({ status: e.status, ...e.jobConfig })
    );
    res.json(new Response(data));
  }

  // GET /api/jobs/:id → Response<JobResponse>
  _getJob(req, res) {
    const { id } = req.params;
    const entry = this.scheduler.getEntry(id);

    if (!entry)
      return res.status(404).json(new Response(null, `Job '${id}' not found`));

    res.json(new Response(
      { status: entry.status, ...entry.jobConfig }
    ));
  }

  // POST /api/jobs → Response<JobResponse> (201)
  async _createJob(req, res) {
    const body = req.body;

    if (this.scheduler.registry.has(body.id))
      return res.status(409).json(new Response(null, `Job '${body.id}' already exists`));

    let jobConfig;
    try {
      jobConfig = this.config.addJob(body);
    } catch (e) {
      return res.status(400).json(new Response(null, e.message));
    }

    await this.config.save();
    this.scheduler.registry.set(jobConfig.id, { jobConfig, shutdownFlag: { value: false }, promise: null, status: 'stopped' });
    res.status(201).json(new Response(
      { status: 'stopped', ...jobConfig }
    ));
  }

  // PUT /api/jobs/:id → Response<JobResponse>
  async _updateJob(req, res) {
    const { id } = req.params;
    const entry = this.scheduler.getEntry(id);

    if (!entry)
      return res.status(404).json(new Response(null, `Job '${id}' not found`));
    if (entry.status === 'running')
      return res.status(409).json(new Response(null, `Job '${id}' is running`));

    let jobConfig;
    try {
      jobConfig = this.config.updateJob(id, req.body);
    } catch (e) {
      return res.status(400).json(new Response(null, e.message));
    }

    await this.config.save();
    this.scheduler.update(jobConfig);
    res.json(new Response(
      { status: entry.status, ...jobConfig }
    ));
  }

  // DELETE /api/jobs/:id → 204
  async _deleteJob(req, res) {
    const { id } = req.params;
    const entry = this.scheduler.getEntry(id);

    if (!entry)
      return res.status(404).json(new Response(null, `Job '${id}' not found`));
    if (entry.status === 'running')
      return res.status(409).json(new Response(null, `Job '${id}' is running`));

    this.config.removeJob(id);
    await this.config.save();
    this.scheduler.unregister(id);
    res.status(204).end();
  }

  // POST /api/jobs/:id/start → Response<JobResponse>
  _startJob(req, res) {
    const { id } = req.params;
    const entry = this.scheduler.getEntry(id);

    if (!entry)
      return res.status(404).json(new Response(null, `Job '${id}' not found`));
    if (entry.status === 'running')
      return res.status(409).json(new Response(null, `Job '${id}' is already running`));

    this.scheduler.start(id);
    res.json(new Response({ status: 'running', ...entry.jobConfig }));
  }

  // POST /api/jobs/:id/stop → Response<JobResponse>
  async _stopJob(req, res) {
    const { id } = req.params;
    const entry = this.scheduler.getEntry(id);

    if (!entry)
      return res.status(404).json(new Response(null, `Job '${id}' not found`));
    if (entry.status !== 'running')
      return res.status(409).json(new Response(null, `Job '${id}' is not running`));

    await this.scheduler.stop(id);
    res.json(new Response({ status: 'stopped', ...entry.jobConfig }));
  }
}

module.exports = { HttpServer };
