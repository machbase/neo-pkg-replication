'use strict';

const path = require('path');
const ConfigLoader = require('./config/config.js');
const { Replicator } = require('./job_runner.js');
const { init: initLogger, getInstance: getLogger } = require('./logger/logger.js');

const configPath = process.argv[2] || path.join(__dirname, 'config.json');

ConfigLoader.load(configPath)
  .then(config => {
    initLogger(config.logging);
    const replicator = new Replicator(config, configPath);
    if (config.api?.enabled) {
      const { ApiServer } = require('./api/server.js');
      new ApiServer(replicator, configPath).start(config.api.port);
    }
    return replicator.run();
  })
  .catch(err => {
    getLogger().error('app', { msg: err.message });
    process.exitCode = 1;
  });
