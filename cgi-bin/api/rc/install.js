/**
 * POST /cgi-bin/api/rc/install?name=xxx  -- 기존 config로 replicator service 등록
 */

const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const Handler = require(path.join(ROOT, 'src', 'cgi', 'handler.js'));

const { name } = Handler.parseQuery();

function POST() {
  Handler.installReplicator(name, (err) => {
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
