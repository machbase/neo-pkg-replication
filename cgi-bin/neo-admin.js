'use strict';

const path = require('path');
const process = require('process');
const ROOT = path.resolve(path.dirname(process.argv[1]));
const { JsonFile } = require(path.join(ROOT, 'src/lib/json_file.js'));
const { init: initLogger, getInstance: getLogger } = require(path.join(ROOT, 'src/lib/logger.js'));
const { ReplicatorManager } = require(path.join(ROOT, 'src/admin/manager.js'));
const { AdminHttpServer } = require(path.join(ROOT, 'src/admin/http_server.js'));

// 기본 로깅으로 초기화 (server.json 로드 전 에러 출력용)
initLogger({ level: 'info', stdout: true });

const serverConfigPath = path.join(ROOT, 'conf.d', 'server.json');
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

const manager = new ReplicatorManager(path.join(ROOT, 'conf.d'));
const server  = new AdminHttpServer(manager, port);

process.addShutdownHook(() => {
  getLogger().info('admin', { msg: 'shutdown: stopping all replicators' });
  manager.stopAll();
  server.stop();
});

getLogger().banner('neo-admin starting');
manager.autoStart();
server.start();
