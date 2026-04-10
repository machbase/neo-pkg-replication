'use strict';

/**
 * @fileoverview Replicator 프로세스 진입점
 *
 * 사용법: jsh replication.js <configName>
 *   configName: conf.d/{name}.json 에서 이름 부분
 *
 * 동작:
 *   1. conf.d/{configName}.json 읽기
 *   2. Logger 초기화
 *   3. PID 파일 생성 ({ROOT}/{configName}.pid)
 *   4. Replicator.start() 실행
 *   5. Shutdown hook 등록 (PID 파일 삭제 + Replicator.shutdown())
 */

const process = require('process');
const path = require('path');
const fs = require('fs');

/** @type {string} cgi-bin 디렉토리 절대경로 */
const ROOT = path.resolve(path.dirname(process.argv[1]));

const { init: initLogger, getInstance: getLogger } = require(path.join(ROOT, 'src', 'lib', 'logger.js'));
const { Replicator } = require(path.join(ROOT, 'src', 'replication', 'replicator.js'));
const { CONF_DIR, DATA_DIR } = require(path.join(ROOT, 'src', 'cgi', 'handler.js'));

fs.mkdirSync(CONF_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const configName = process.argv[2];
if (!configName) {
  getLogger().error('app', { msg: 'config name is required: replication.js <name>' });
  process.exit(1);
}

const configPath = path.join(CONF_DIR, `${configName}.json`);

try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  initLogger(config.logging);

  const pidFile = path.join(ROOT, `${configName}.pid`);
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
