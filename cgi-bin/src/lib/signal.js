'use strict';

const process = require('process');
const { getInstance: getLogger } = require('./logger.js');

/**
 * SIGTERM / SIGINT 핸들러 등록
 * 신호 수신 시 shutdownFlag를 true로 설정하고 shutdown timeout 타이머를 시작한다.
 *
 * @param {{ value: boolean }} shutdownFlag
 * @param {number} timeoutMs
 */
function registerSignals(shutdownFlag, timeoutMs) {
  const onSignal = (signal) => {
    if (shutdownFlag.value) return;
    getLogger().info('signal', { msg: `${signal} received, graceful shutdown initiated` });
    shutdownFlag.value = true;

    const handle = setTimeout(() => {
      getLogger().warn('signal', { msg: `shutdown timeout (${timeoutMs}ms) exceeded, forcing exit` });
      process.exit(1);
    }, timeoutMs);
    if (handle.unref) handle.unref();
  };

  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT',  () => onSignal('SIGINT'));
}

module.exports = { registerSignals };
