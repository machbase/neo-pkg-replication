'use strict';

/**
 * GET    /cgi-bin/replicator?name=xxx  — 단건 조회
 * PUT    /cgi-bin/replicator?name=xxx  — 수정 (body: config)
 * DELETE /cgi-bin/replicator?name=xxx  — 제거
 */

const path = require('path');
const process = require('process');
const { readInternalPort, forward, parseQuery, readBody, reply } = require(path.join(process.cwd(), 'src', 'admin', 'cgi_util.js'));

const port = readInternalPort();
if (!port) return reply(503, { ok: false, reason: 'internalPort not configured in conf.d/server.json' });

const method = (process.env.REQUEST_METHOD || 'GET').toUpperCase();
const { name } = parseQuery();

if (!name) return reply(400, { ok: false, reason: 'name is required' });

(async () => {
  if (method === 'GET') {
    const res = await forward(port, 'GET', `/api/replicators/${encodeURIComponent(name)}`);
    reply(res.status, res.body);
  } else if (method === 'PUT') {
    const res = await forward(port, 'PUT', `/api/replicators/${encodeURIComponent(name)}`, readBody());
    reply(res.status, res.body);
  } else if (method === 'DELETE') {
    const res = await forward(port, 'DELETE', `/api/replicators/${encodeURIComponent(name)}`);
    reply(res.status, res.body);
  } else {
    reply(405, { ok: false, reason: 'method not allowed' });
  }
})();
