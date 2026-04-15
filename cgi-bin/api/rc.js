/**
 * POST   /cgi-bin/api/rc          -- 등록 (body: { name, config })
 * GET    /cgi-bin/api/rc?name=xxx -- 단건 조회
 * PUT    /cgi-bin/api/rc?name=xxx -- 수정 (body: config)
 * DELETE /cgi-bin/api/rc?name=xxx -- 제거
 */

const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const Handler = require(path.join(ROOT, 'src', 'cgi', 'handler.js'));

const { name } = Handler.parseQuery();

async function POST() {
  await Handler.createReplicator(Handler.readBody(), (err, data) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data });
  });
}

async function GET() {
  await Handler.getReplicator(name, (err, data) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data });
  });
}

async function PUT() {
  await Handler.updateReplicator(name, Handler.readBody(), (err) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data: { name } });
  });
}

function DELETE() {
  Handler.deleteReplicator(name, (err) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true });
  });
}

const handlers = { POST, GET, PUT, DELETE };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
try {
  Promise.resolve((handlers[method] || (() => Handler.reply({ ok: false, reason: 'method not allowed' })))())
    .catch((err) => Handler.reply({ ok: false, reason: err.message }));
} catch (err) {
  Handler.reply({ ok: false, reason: err.message });
}
