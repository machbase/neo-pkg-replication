'use strict';

const path = require('path');
const ConfigLoader = require('./config/config.js');
const JobRunner = require('./job_runner.js');

const configPath = process.argv[2] || path.join(__dirname, 'config.json');

ConfigLoader.load(configPath)
  .then(config => JobRunner.run(config))
  .catch(err => {
    console.error(JSON.stringify({ level: 'error', stage: 'app', msg: err.message }));
    process.exitCode = 1;
  });
