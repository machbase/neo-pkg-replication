/**
 * POST /cgi-bin/api/table/list
 * body: { server } or inline connection
 *
 * 지정한 DB에 연결하여 일반 사용자가 보는 TAG/LOG 논리 테이블 목록을 반환한다.
 */

const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const Handler = require(path.join(ROOT, 'src', 'cgi', 'handler.js'));

async function POST() {
  await Handler.getTableList(Handler.readBody(), (err, data) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data });
  });
}

const handlers = { POST };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
try {
  Promise.resolve((handlers[method] || (() => Handler.reply({ ok: false, reason: 'method not allowed' })))())
    .catch((err) => Handler.reply({ ok: false, reason: err.message }));
} catch (err) {
  Handler.reply({ ok: false, reason: err.message });
}
