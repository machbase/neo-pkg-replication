'use strict';

const http = require('http');
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
    const corsOrigin = corsOptions?.origin ?? '*';
    const svr = new http.Server({ network: 'tcp', address: `0.0.0.0:${port}` });

    const corsHeaders = (ctx) => {
      ctx.setHeader('Access-Control-Allow-Origin', corsOrigin);
      ctx.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      ctx.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    };

    // OPTIONS preflight
    svr.options('/*', (ctx) => {
      corsHeaders(ctx);
      ctx.json(http.status.NoContent, null);
    });

    // ── Servers API ──
    svr.get('/api/servers', (ctx) => {
      corsHeaders(ctx);
      getLogger().info('api', { method: 'GET', path: '/api/servers', status: 200 });
      this._listServers(ctx);
    });
    svr.get('/api/servers/:name', (ctx) => {
      corsHeaders(ctx);
      this._getServer(ctx);
    });
    svr.post('/api/servers', (ctx) => {
      corsHeaders(ctx);
      this._createServer(ctx);
    });
    svr.put('/api/servers/:name', (ctx) => {
      corsHeaders(ctx);
      this._updateServer(ctx);
    });
    svr.delete('/api/servers/:name', (ctx) => {
      corsHeaders(ctx);
      this._deleteServer(ctx);
    });
    svr.get('/api/servers/:name/tables', (ctx) => {
      corsHeaders(ctx);
      this._listTables(ctx);
    });
    svr.get('/api/servers/:name/tables/:table/schema', (ctx) => {
      corsHeaders(ctx);
      this._getTableSchema(ctx);
    });
    svr.get('/api/servers/:name/health', (ctx) => {
      corsHeaders(ctx);
      this._checkHealth(ctx);
    });

    // ── Jobs API ──
    svr.get('/api/jobs', (ctx) => {
      corsHeaders(ctx);
      this._listJobs(ctx);
    });
    svr.get('/api/jobs/:id', (ctx) => {
      corsHeaders(ctx);
      this._getJob(ctx);
    });
    svr.post('/api/jobs', (ctx) => {
      corsHeaders(ctx);
      this._createJob(ctx);
    });
    svr.put('/api/jobs/:id', (ctx) => {
      corsHeaders(ctx);
      this._updateJob(ctx);
    });
    svr.delete('/api/jobs/:id', (ctx) => {
      corsHeaders(ctx);
      this._deleteJob(ctx);
    });
    svr.post('/api/jobs/:id/start', (ctx) => {
      corsHeaders(ctx);
      this._startJob(ctx);
    });
    svr.post('/api/jobs/:id/stop', (ctx) => {
      corsHeaders(ctx);
      this._stopJob(ctx);
    });

    svr.serve(() => {
      getLogger().info('api', { msg: `API server listening on port ${port}` });
    });

    this.server = svr;
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  // GET /api/servers
  _listServers(ctx) {
    const data = this.config.servers.map(s => new ServerResponse(s));
    ctx.json(http.status.OK, new Response(data));
  }

  // GET /api/servers/:name
  _getServer(ctx) {
    const name = ctx.param('name');
    const srv = this.config.servers.find(s => s.name === name);
    if (!srv)
      return ctx.json(http.status.NotFound, new Response(null, `Server '${name}' not found`));
    ctx.json(http.status.OK, new Response(new ServerResponse(srv)));
  }

  // POST /api/servers
  _createServer(ctx) {
    let srv;
    try {
      srv = this.config.addServer(ctx.request.body);
    } catch (e) {
      const status = e.message.includes('already exists') ? http.status.Conflict : http.status.BadRequest;
      return ctx.json(status, new Response(null, e.message));
    }
    this.config.save();
    ctx.json(http.status.Created, new Response(new ServerResponse(srv)));
  }

  // PUT /api/servers/:name
  _updateServer(ctx) {
    const name = ctx.param('name');
    let srv;
    try {
      srv = this.config.updateServer(name, ctx.request.body);
    } catch (e) {
      const status = e.message.includes('not found') ? http.status.NotFound : http.status.BadRequest;
      return ctx.json(status, new Response(null, e.message));
    }
    this.config.save();
    ctx.json(http.status.OK, new Response(new ServerResponse(srv)));
  }

  // DELETE /api/servers/:name
  _deleteServer(ctx) {
    const name = ctx.param('name');
    if (!this.config.servers.find(s => s.name === name))
      return ctx.json(http.status.NotFound, new Response(null, `Server '${name}' not found`));

    const jobs = this.config.replication.jobs;
    const inUse = jobs.find(j => j.source?.server === name || j.target?.server === name);
    if (inUse)
      return ctx.json(http.status.Conflict, new Response(null, `Server '${name}' is referenced by job '${inUse.id}'`));

    this.config.removeServer(name);
    this.config.save();
    ctx.json(http.status.NoContent, null);
  }

  // GET /api/servers/:name/tables
  _listTables(ctx) {
    const name = ctx.param('name');
    const srv = this.config.servers.find(s => s.name === name);
    if (!srv)
      return ctx.json(http.status.NotFound, new Response(null, `Server '${name}' not found`));

    const client = new MachbaseClient(srv);
    try {
      client.connect();
      const rows = client.selectAllTables();
      const data = rows.map(r => ({ name: r.NAME, type: r.TYPE === 6 ? 'TAG' : 'LOG' }));
      ctx.json(http.status.OK, new Response(data));
    } catch (e) {
      ctx.json(http.status.InternalServerError, new Response(null, e.message));
    } finally {
      try { client.close(); } catch (_) {}
    }
  }

  // GET /api/servers/:name/tables/:table/schema
  _getTableSchema(ctx) {
    const name  = ctx.param('name');
    const table = ctx.param('table');
    const srv = this.config.servers.find(s => s.name === name);
    if (!srv)
      return ctx.json(http.status.NotFound, new Response(null, `Server '${name}' not found`));

    const client = new MachbaseClient(srv);
    try {
      client.connect();
      const rows = client.selectColumnsByTableName(table.toUpperCase());
      if (!rows || rows.length === 0)
        return ctx.json(http.status.NotFound, new Response(null, `Table '${table}' not found`));
      const data = rows.map(r => ({
        name:   r.NAME,
        type:   ColumnType.fromCode(r.TYPE).type,
        length: r.LENGTH,
      }));
      ctx.json(http.status.OK, new Response(data));
    } catch (e) {
      ctx.json(http.status.InternalServerError, new Response(null, e.message));
    } finally {
      try { client.close(); } catch (_) {}
    }
  }

  // GET /api/servers/:name/health
  _checkHealth(ctx) {
    const name = ctx.param('name');
    const srv = this.config.servers.find(s => s.name === name);
    if (!srv)
      return ctx.json(http.status.NotFound, new Response(null, `Server '${name}' not found`));

    const client = new MachbaseClient(srv);
    try {
      client.connect();
      client.close();
      ctx.json(http.status.OK, new Response());
    } catch (e) {
      ctx.json(http.status.OK, new Response(null, e.message));
    }
  }

  // GET /api/jobs
  _listJobs(ctx) {
    const data = this.scheduler.listEntries().map(e =>
      ({ status: e.status, ...e.jobConfig })
    );
    ctx.json(http.status.OK, new Response(data));
  }

  // GET /api/jobs/:id
  _getJob(ctx) {
    const id = ctx.param('id');
    const entry = this.scheduler.getEntry(id);
    if (!entry)
      return ctx.json(http.status.NotFound, new Response(null, `Job '${id}' not found`));
    ctx.json(http.status.OK, new Response({ status: entry.status, ...entry.jobConfig }));
  }

  // POST /api/jobs
  _createJob(ctx) {
    const body = ctx.request.body;
    if (this.scheduler.registry.has(body.id))
      return ctx.json(http.status.Conflict, new Response(null, `Job '${body.id}' already exists`));

    let jobConfig;
    try {
      jobConfig = this.config.addJob(body);
    } catch (e) {
      return ctx.json(http.status.BadRequest, new Response(null, e.message));
    }

    this.config.save();
    this.scheduler.registry.set(jobConfig.id, { jobConfig, shutdownFlag: { value: false }, promise: null, status: 'stopped' });
    ctx.json(http.status.Created, new Response({ status: 'stopped', ...jobConfig }));
  }

  // PUT /api/jobs/:id
  _updateJob(ctx) {
    const id = ctx.param('id');
    const entry = this.scheduler.getEntry(id);
    if (!entry)
      return ctx.json(http.status.NotFound, new Response(null, `Job '${id}' not found`));
    if (entry.status === 'running')
      return ctx.json(http.status.Conflict, new Response(null, `Job '${id}' is running`));

    let jobConfig;
    try {
      jobConfig = this.config.updateJob(id, ctx.request.body);
    } catch (e) {
      return ctx.json(http.status.BadRequest, new Response(null, e.message));
    }

    this.config.save();
    this.scheduler.update(jobConfig);
    ctx.json(http.status.OK, new Response({ status: entry.status, ...jobConfig }));
  }

  // DELETE /api/jobs/:id
  _deleteJob(ctx) {
    const id = ctx.param('id');
    const entry = this.scheduler.getEntry(id);
    if (!entry)
      return ctx.json(http.status.NotFound, new Response(null, `Job '${id}' not found`));
    if (entry.status === 'running')
      return ctx.json(http.status.Conflict, new Response(null, `Job '${id}' is running`));

    this.config.removeJob(id);
    this.config.save();
    this.scheduler.unregister(id);
    ctx.json(http.status.NoContent, null);
  }

  // POST /api/jobs/:id/start
  _startJob(ctx) {
    const id = ctx.param('id');
    const entry = this.scheduler.getEntry(id);
    if (!entry)
      return ctx.json(http.status.NotFound, new Response(null, `Job '${id}' not found`));
    if (entry.status === 'running')
      return ctx.json(http.status.Conflict, new Response(null, `Job '${id}' is already running`));

    this.scheduler.start(id);
    ctx.json(http.status.OK, new Response({ status: 'running', ...entry.jobConfig }));
  }

  // POST /api/jobs/:id/stop
  _stopJob(ctx) {
    const id = ctx.param('id');
    const entry = this.scheduler.getEntry(id);
    if (!entry)
      return ctx.json(http.status.NotFound, new Response(null, `Job '${id}' not found`));
    if (entry.status !== 'running')
      return ctx.json(http.status.Conflict, new Response(null, `Job '${id}' is not running`));

    entry.shutdownFlag.value = true;
    ctx.json(http.status.OK, new Response({ status: 'stopped', ...entry.jobConfig }));
  }
}

module.exports = { HttpServer };
