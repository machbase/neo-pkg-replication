'use strict';

/**
 * GET  /cgi-bin/replicators  — 목록 조회
 * POST /cgi-bin/replicators  — 등록 (body: { name, config })
 */

const path = require('path');
const process = require('process');
const { readInternalPort, readBody, reply, forward } = require(path.join(process.cwd(), 'src', 'admin', 'cgi_util.js'));

const port = readInternalPort();
if (!port) return reply(503, { ok: false, reason: 'internalPort not configured in conf.d/server.json' });

const method = (process.env.REQUEST_METHOD || 'GET').toUpperCase();

(async () => {
  if (method === 'GET') {
    const res = await forward(port, 'GET', '/api/replicators');
    reply(res.status, res.body);
  } else if (method === 'POST') {
    const res = await forward(port, 'POST', '/api/replicators', readBody());
    reply(res.status, res.body);
  } else {
    reply(405, { ok: false, reason: 'method not allowed' });
  }
})();
