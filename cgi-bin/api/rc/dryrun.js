/**
 * POST /cgi-bin/api/rc/dryrun  -- replication dry-run validation
 */

const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const Handler = require(path.join(ROOT, 'src', 'cgi', 'handler.js'));

async function POST() {
  await Handler.dryRunReplicator(Handler.readBody(), (err, data) => {
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
