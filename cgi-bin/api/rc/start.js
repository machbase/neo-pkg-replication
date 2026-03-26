/**
 * POST /cgi-bin/api/rc/start?name=xxx  -- replicator 시작 (데몬 연동 예정)
 */

const path = require('path');
const process = require('process');
const ROOT = path.join(process.env.get('PWD'), 'cgi-bin');
const CGI = require(path.join(ROOT, 'src', 'cgi', 'cgi_util.js'));

const { name } = CGI.parseQuery();

function POST() {
  if (!name) return CGI.reply({ ok: false, reason: 'name is required' });
  if (!CGI.readConfig(name)) return CGI.reply({ ok: false, reason: `replicator '${name}' not found` });
  // TODO: jsh 비동기 exec 지원 시 process.exec()로 구현 예정
  CGI.reply({ ok: false, reason: `daemon not supported yet. run manually: machbase-neo jsh cgi-bin/bin/replication.js cgi-bin/conf.d/${name}.json` });
}

const handlers = { POST };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
(handlers[method] || (() => CGI.reply({ ok: false, reason: 'method not allowed' })))();
