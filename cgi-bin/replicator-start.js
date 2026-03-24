'use strict';

/**
 * POST /cgi-bin/replicator-start?name=xxx  — replicator 시작
 */

const path = require('path');
const process = require('process');
const { readInternalPort, forward, parseQuery, reply } = require(path.join(process.cwd(), 'src', 'admin', 'cgi_util.js'));

const port = readInternalPort();
if (!port) return reply(503, { ok: false, reason: 'internalPort not configured in conf.d/server.json' });

const { name } = parseQuery();
if (!name) return reply(400, { ok: false, reason: 'name is required' });

(async () => {
  const res = await forward(port, 'POST', `/api/replicators/${encodeURIComponent(name)}/start`);
  reply(res.status, res.body);
})();
