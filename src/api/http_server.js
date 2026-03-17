'use strict';

const express = require('express');
const cors = require('cors');
const { getInstance: getLogger } = require('../lib/logger.js');

// ─── Response 클래스 ──────────────────────────────────────────────────────────

class Response {
  constructor(data = null, reason = null) {
    this.data   = data;
    this.reason = reason;
  }
}

class JobResponse {
  constructor({ id, status, jobConfig }) {
    this.id        = id;
    this.status    = status;
    this.jobConfig = jobConfig;
  }
}

class JobStatusResponse {
  constructor({ id, status }) {
    this.id     = id;
    this.status = status;
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
    if (this.server) this.server.close();
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  // GET /api/jobs → Response<JobResponse[]>
  _listJobs(_req, res) {
    const data = this.scheduler.listEntries().map(e =>
      new JobResponse({ id: e.jobConfig.id, status: e.status, jobConfig: e.jobConfig })
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
      new JobResponse({ id: entry.jobConfig.id, status: entry.status, jobConfig: entry.jobConfig })
    ));
  }

  // POST /api/jobs → Response<JobStatusResponse> (201)
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
      new JobStatusResponse({ id: jobConfig.id, status: 'stopped' })
    ));
  }

  // PUT /api/jobs/:id → Response<JobStatusResponse>
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
      new JobStatusResponse({ id: jobConfig.id, status: entry.status })
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

  // POST /api/jobs/:id/start → Response<JobStatusResponse>
  _startJob(req, res) {
    const { id } = req.params;
    const entry = this.scheduler.getEntry(id);

    if (!entry)
      return res.status(404).json(new Response(null, `Job '${id}' not found`));
    if (entry.status === 'running')
      return res.status(409).json(new Response(null, `Job '${id}' is already running`));

    this.scheduler.start(id);
    res.json(new Response(new JobStatusResponse({ id, status: 'running' })));
  }

  // POST /api/jobs/:id/stop → Response<JobStatusResponse>
  async _stopJob(req, res) {
    const { id } = req.params;
    const entry = this.scheduler.getEntry(id);

    if (!entry)
      return res.status(404).json(new Response(null, `Job '${id}' not found`));
    if (entry.status !== 'running')
      return res.status(409).json(new Response(null, `Job '${id}' is not running`));

    await this.scheduler.stop(id);
    res.json(new Response(new JobStatusResponse({ id, status: 'stopped' })));
  }
}

module.exports = { HttpServer };
