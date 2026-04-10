/**
 * POST /cgi-bin/api/table/columns
 * body: { host, port, user, password, table }
 *
 * 지정한 DB에 연결하여 테이블 컬럼 정보를 반환한다.
 */

const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const Handler = require(path.join(ROOT, 'src', 'cgi', 'handler.js'));

function POST() {
  Handler.getTableColumns(Handler.readBody(), (err, data) => {
    Handler.reply(err ? { ok: false, reason: err.message } : { ok: true, data });
  });
}

const handlers = { POST };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
try {
  (handlers[method] || (() => Handler.reply({ ok: false, reason: 'method not allowed' })))();
} catch (err) {
  Handler.reply({ ok: false, reason: err.message });
}
