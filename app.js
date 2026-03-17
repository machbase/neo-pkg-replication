'use strict';

const path = require('path');
const { Config } = require('./src/config/config.js');
const { Replicator } = require('./src/replicator.js');
const { init: initLogger, getInstance: getLogger } = require('./src/lib/logger.js');

const configPath = process.argv[2] || path.join(__dirname, 'config.json');

Config.load(configPath)
  .then(config => {
    initLogger(config.logging);
    return new Replicator(config).run();
  })
  .catch(err => {
    getLogger().error('app', { msg: err.message });
    process.exitCode = 1;
  });
