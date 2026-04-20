/**
 * POST /cgi-bin/api/server/test  -- 저장된 server 또는 미저장 profile 연결 테스트
 */

const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const Handler = require(path.join(ROOT, 'src', 'cgi', 'handler.js'));

async function POST() {
  await Handler.testServerConnection(Handler.readBody(), (err, data) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data });
  });
}

const handlers = { POST };
const method = (process.env.get('REQUEST_METHOD') || 'POST').toUpperCase();
try {
  Promise.resolve((handlers[method] || (() => Handler.reply({ ok: false, reason: 'method not allowed' })))())
    .catch((err) => Handler.reply({ ok: false, reason: err.message }));
} catch (err) {
  Handler.reply({ ok: false, reason: err.message });
}
