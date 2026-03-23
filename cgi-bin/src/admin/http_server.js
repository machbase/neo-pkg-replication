'use strict';

const http = require('http');
const { getInstance: getLogger } = require('../src/lib/logger.js');

/**
 * REST API
 *
 * GET    /api/replicators           — 목록
 * GET    /api/replicators/:name     — 단건 조회
 * POST   /api/replicators           — 등록 (body: { name, config })
 * PUT    /api/replicators/:name     — 수정 (body: config)
 * DELETE /api/replicators/:name     — 제거
 * POST   /api/replicators/:name/start  — 시작
 * POST   /api/replicators/:name/stop   — 종료
 */
class AdminHttpServer {
  constructor(manager, port) {
    this._manager = manager;
    this._port = port || 8080;
    this._svr = null;
  }

  start() {
    const svr = new http.Server({ network: 'tcp', address: `0.0.0.0:${this._port}` });

    svr.get('/api/replicators', (ctx) => {
      try {
        ctx.json(http.status.OK, { ok: true, data: this._manager.list() });
      } catch (err) {
        ctx.json(http.status.InternalServerError, { ok: false, reason: err.message });
      }
    });

    svr.get('/api/replicators/:name', (ctx) => {
      try {
        const entry = this._manager.get(ctx.param('name'));
        if (!entry) return ctx.json(http.status.NotFound, { ok: false, reason: 'not found' });
        ctx.json(http.status.OK, { ok: true, data: entry });
      } catch (err) {
        ctx.json(http.status.InternalServerError, { ok: false, reason: err.message });
      }
    });

    svr.post('/api/replicators', (ctx) => {
      try {
        const body = ctx.request.body;
        if (!body.name) return ctx.json(http.status.BadRequest, { ok: false, reason: 'name is required' });
        if (!body.config) return ctx.json(http.status.BadRequest, { ok: false, reason: 'config is required' });
        const result = this._manager.register(body.name, body.config);
        ctx.json(http.status.Created, { ok: true, data: result });
      } catch (err) {
        const status = err.message.startsWith('duplicate replicator id') ? http.status.Conflict : http.status.InternalServerError;
        ctx.json(status, { ok: false, reason: err.message });
      }
    });

    svr.put('/api/replicators/:name', (ctx) => {
      try {
        const result = this._manager.update(ctx.param('name'), ctx.request.body);
        ctx.json(http.status.OK, { ok: true, data: result });
      } catch (err) {
        const status = err.message.startsWith('duplicate replicator id') ? http.status.Conflict : http.status.InternalServerError;
        ctx.json(status, { ok: false, reason: err.message });
      }
    });

    svr.delete('/api/replicators/:name', (ctx) => {
      try {
        this._manager.remove(ctx.param('name'));
        ctx.json(http.status.OK, { ok: true });
      } catch (err) {
        ctx.json(http.status.InternalServerError, { ok: false, reason: err.message });
      }
    });

    svr.post('/api/replicators/:name/start', (ctx) => {
      try {
        const result = this._manager.start(ctx.param('name'));
        ctx.json(http.status.OK, { ok: true, data: result });
      } catch (err) {
        ctx.json(http.status.InternalServerError, { ok: false, reason: err.message });
      }
    });

    svr.post('/api/replicators/:name/stop', (ctx) => {
      try {
        const result = this._manager.stop(ctx.param('name'));
        ctx.json(http.status.OK, { ok: true, data: result });
      } catch (err) {
        ctx.json(http.status.InternalServerError, { ok: false, reason: err.message });
      }
    });

    svr.serve(() => {
      getLogger().info('admin', { msg: `HTTP server listening on :${this._port}` });
    });

    this._svr = svr;
  }

  stop() {
    if (this._svr) {
      this._svr.close();
      this._svr = null;
    }
  }
}

module.exports = { AdminHttpServer };
