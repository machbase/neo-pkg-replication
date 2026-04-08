/**
 * GET /cgi-bin/api/rc/list  -- 목록 조회
 */

const path = require('path');
const process = require('process');
const _argv = process.argv[1];
const ROOT = _argv.slice(0, _argv.lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const CGI = require(path.join(ROOT, 'src', 'cgi', 'cgi_util.js'));

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function replyConfigs(names, index, data) {
  if (index >= names.length) {
    CGI.reply({ ok: true, data });
    return;
  }

  const name = names[index];
  const installed = CGI.hasInstalledService(name);
  CGI.getServiceStatus(name, (err, serviceInfo) => {
    if (err) {
      data.push({
        name,
        installed,
        running: installed ? CGI.isRunning(name) : false,
      });
      replyConfigs(names, index + 1, data);
      return;
    }

    data.push({
      name,
      installed: true,
      running: CGI.isServiceRunningStatus(serviceInfo),
    });
    replyConfigs(names, index + 1, data);
  });
}

function GET() {
  const names = CGI.listConfigs();
  replyConfigs(names, 0, []);
}

const handlers = { GET };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
try {
  (handlers[method] || (() => CGI.reply({ ok: false, reason: 'method not allowed' })))();
} catch (err) {
  CGI.reply({ ok: false, reason: errorMessage(err) });
}
