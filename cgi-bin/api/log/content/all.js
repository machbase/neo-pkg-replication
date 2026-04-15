/**
 * GET /cgi-bin/api/log/content/all?name=...
 *
 * 로그 파일 전체 내용을 문자열로 반환한다.
 */

const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const Handler = require(path.join(ROOT, 'src', 'cgi', 'handler.js'));

function GET() {
  Handler.getLogContentAll(Handler.parseQuery(), (err, data) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data });
  });
}

const handlers = { GET };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
try {
  (handlers[method] || (() => Handler.reply({ ok: false, reason: 'method not allowed' })))();
} catch (err) {
  Handler.reply({ ok: false, reason: err.message });
}
