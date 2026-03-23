'use strict';

const process = require('process');
const path = require('path');
const ROOT = process.cwd();

const { JsonFile } = require(path.join(ROOT, 'src', 'lib', 'json_file.js'));
const { init: initLogger, getInstance: getLogger } = require(path.join(ROOT, 'src', 'lib', 'logger.js'));
const { Replicator } = require(path.join(ROOT, 'src', 'replication', 'replicator.js'));
const { registerSignals } = require(path.join(ROOT, 'src', 'lib', 'signal.js'));

const configPath = process.argv[2];
if (!configPath) {
  getLogger().error('app', { msg: 'config path is required: neo-repli.js <config.json>' });
  process.exit(1);
}

try {
  const config = new JsonFile(configPath).read();
  initLogger(config.logging);

  const shutdownFlag = { value: false };
  registerSignals(shutdownFlag, config.shutdownTimeoutMs || 30000);

  const replicator = new Replicator(config, shutdownFlag);

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
