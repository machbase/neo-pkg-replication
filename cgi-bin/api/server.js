/**
 * POST   /cgi-bin/api/server          -- server profile 등록
 * GET    /cgi-bin/api/server?name=xxx -- 단건 조회
 * PUT    /cgi-bin/api/server?name=xxx -- 수정
 * DELETE /cgi-bin/api/server?name=xxx -- 삭제
 */

const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const Handler = require(path.join(ROOT, 'src', 'cgi', 'handler.js'));

const { name } = Handler.parseQuery();

function POST() {
  Handler.createServerProfile(Handler.readBody(), (err, data) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data });
  });
}

function GET() {
  Handler.getServerProfile(name, (err, data) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data });
  });
}

function PUT() {
  Handler.updateServerProfile(name, Handler.readBody(), (err, data) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data });
  });
}

function DELETE() {
  Handler.deleteServerProfile(name, (err) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true });
  });
}

const handlers = { POST, GET, PUT, DELETE };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
try {
  (handlers[method] || (() => Handler.reply({ ok: false, reason: 'method not allowed' })))();
} catch (err) {
  Handler.reply({ ok: false, reason: err.message });
}
