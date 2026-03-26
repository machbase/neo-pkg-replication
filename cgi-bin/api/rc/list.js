/**
 * GET /cgi-bin/api/rc/list  -- 목록 조회
 */

const path = require('path');
const process = require('process');
const ROOT = path.join(process.env.get('PWD'), 'cgi-bin');
const CGI = require(path.join(ROOT, 'src', 'cgi', 'cgi_util.js'));

function GET() {
  const names = CGI.listConfigs();
  const data = names.map(name => {
    const config   = CGI.readConfig(name);
    const configId = config?.id || `${config?.source?.table}_${config?.target?.table}`;
    return {
      name,
      running: CGI.isRunning(name),
      checkpoints: CGI.readCheckpoints(configId),
    };
  });
  CGI.reply({ ok: true, data });
}

const handlers = { GET };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
(handlers[method] || (() => CGI.reply({ ok: false, reason: 'method not allowed' })))();
