/**
 * POST /cgi-bin/api/rc/start?name=xxx  -- replicator service 시작
 */

const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const Handler = require(path.join(ROOT, 'src', 'cgi', 'handler.js'));

const { name } = Handler.parseQuery();

function POST() {
  Handler.startReplicator(name, (err) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data: { name } });
  });
}

const handlers = { POST };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
try {
  (handlers[method] || (() => Handler.reply({ ok: false, reason: 'method not allowed' })))();
} catch (err) {
  Handler.reply({ ok: false, reason: err.message });
}
