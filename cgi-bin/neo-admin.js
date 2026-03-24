'use strict';

const path = require('path');
const process = require('process');
const { JsonFile } = require('./src/lib/json_file.js');
const { init: initLogger, getInstance: getLogger } = require('./src/lib/logger.js');
const { ReplicatorManager } = require('./src/admin/manager.js');
const { AdminHttpServer } = require('./src/admin/http_server.js');
const { registerSignals } = require('./src/lib/signal.js');

// 기본 로깅으로 초기화 (server.json 로드 전 에러 출력용)
initLogger({ level: 'info', stdout: true });

const serverConfigPath = path.join(process.cwd(), 'conf.d', 'server.json');
let serverConfig = {};
try {
  serverConfig = new JsonFile(serverConfigPath).read();
} catch (err) {
  getLogger().warn('admin', { msg: `conf.d/server.json not found, using defaults: ${err.message}` });
}

initLogger(serverConfig.logging);

const port = serverConfig.internalPort;
if (!port) {
  getLogger().error('admin', { msg: 'conf.d/server.json: internalPort is required' });
  process.exit(1);
}

const shutdownTimeoutMs = serverConfig.shutdownTimeoutMs || 30000;
const shutdownFlag = { value: false };

const manager = new ReplicatorManager();
const server  = new AdminHttpServer(manager, port);

registerSignals(shutdownFlag, shutdownTimeoutMs);

const shutdownWatcher = setInterval(() => {
  if (!shutdownFlag.value) return;
  clearInterval(shutdownWatcher);
  getLogger().info('admin', { msg: 'shutdown: stopping all replicators' });
  manager.stopAll();
  server.stop();
}, 200);

getLogger().banner('neo-admin starting');
manager.autoStart();
server.start();
