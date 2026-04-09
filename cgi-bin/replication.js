'use strict';

const process = require('process');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(path.dirname(process.argv[1]));

const { init: initLogger, getInstance: getLogger } = require(path.join(ROOT, 'src', 'lib', 'logger.js'));
const { Replicator } = require(path.join(ROOT, 'src', 'replication', 'replicator.js'));

const configPath = process.argv[2];
if (!configPath) {
  getLogger().error('app', { msg: 'config path is required: neo-repli.js <config.json>' });
  process.exit(1);
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  initLogger(config.logging);

  const configName = path.basename(configPath, '.json');
  const pidFile = path.join(ROOT, 'run', `${configName}.pid`);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), 'utf-8');

  const shutdownFlag = { value: false };
  const replicator = new Replicator(config, shutdownFlag);

  process.addShutdownHook(() => {
    try { fs.unlinkSync(pidFile); } catch (_) {}
    try { getLogger().info('app', { msg: 'shutdown requested' }); } catch (_) {}
    replicator.shutdown();
  });

  replicator.start().then(() => {
    process.exit(0);
  }).catch(err => {
    getLogger().error('app', { msg: err.message });
    process.exit(1);
  });
} catch (err) {
  getLogger().error('app', { msg: err.message });
  process.exit(1);
}
