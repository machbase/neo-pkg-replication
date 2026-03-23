'use strict';

const path = require('path');
const process = require('process');
const { Config } = require('./src/config/config.js');
const { Replicator } = require('./src/replicator.js');
const { init: initLogger, getInstance: getLogger } = require('./src/lib/logger.js');

const configPath = process.argv[2] || path.join(process.cwd(), 'config.json');

try {
  const config = Config.load(configPath);
  initLogger(config.logging);
  new Replicator(config).run();
} catch (err) {
  getLogger().error('app', { msg: err.message });
  process.exitCode = 1;
}
