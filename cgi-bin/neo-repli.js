'use strict';

const process = require('process');
const path = require('path');
const ROOT = path.resolve(path.dirname(process.argv[1]));

const { JsonFile } = require(path.join(ROOT, 'src', 'lib', 'json_file.js'));
const { init: initLogger, getInstance: getLogger } = require(path.join(ROOT, 'src', 'lib', 'logger.js'));
const { Replicator } = require(path.join(ROOT, 'src', 'replication', 'replicator.js'));

const configPath = process.argv[2];
if (!configPath) {
  getLogger().error('app', { msg: 'config path is required: neo-repli.js <config.json>' });
  process.exit(1);
}

try {
  const config = new JsonFile(configPath).read();
  initLogger(config.logging);

  const shutdownFlag = { value: false };
  const replicator = new Replicator(config, shutdownFlag);

  process.addShutdownHook(() => {
    getLogger().info('app', { msg: 'shutdown requested' });
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
