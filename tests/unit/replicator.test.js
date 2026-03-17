'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { Replicator } = require('../../src/replicator.js');

describe('Replicator — run()', () => {
  test('SIGTERM 수신 → shutdownFlag 설정 후 run() 완료', async () => {
    const config = {
      servers: [],
      replication: {
        jobs: [
          { id: 'job-1', shutdown_timeout_ms: 30000 },
        ],
      },
    };

    const replicator = new Replicator(config);
    const runPromise = replicator.run();
    setImmediate(() => process.emit('SIGTERM'));
    await runPromise;
    assert.ok(true, 'SIGTERM 후 run() 정상 종료');
  });

  test('job 없음 → SIGTERM 후 즉시 완료', async () => {
    const config = {
      servers: [],
      replication: { jobs: [] },
    };

    const replicator = new Replicator(config);
    const runPromise = replicator.run();
    setImmediate(() => process.emit('SIGTERM'));
    await runPromise;
    assert.ok(true, '빈 jobs → SIGTERM 후 정상 종료');
  });

  test('SIGINT 수신 → run() 정상 종료', async () => {
    const config = {
      servers: [],
      replication: { jobs: [] },
    };

    const replicator = new Replicator(config);
    const runPromise = replicator.run();
    setImmediate(() => process.emit('SIGINT'));
    await runPromise;
    assert.ok(true, 'SIGINT 후 run() 정상 종료');
  });

  test('shutdown_timeout_ms: 여러 job 중 최댓값 사용', async () => {
    // Replicator._startShutdownTimer 호출 여부와 인수를 spy
    const config = {
      servers: [],
      replication: {
        jobs: [
          { id: 'job-a', shutdown_timeout_ms: 10000 },
          { id: 'job-b', shutdown_timeout_ms: 60000 },
          { id: 'job-c', shutdown_timeout_ms: 5000 },
        ],
      },
    };

    const replicator = new Replicator(config);
    let capturedTimeout = null;
    const origTimer = replicator._startShutdownTimer.bind(replicator);
    replicator._startShutdownTimer = function(ms) {
      capturedTimeout = ms;
      return origTimer(ms);
    };

    const runPromise = replicator.run();
    setImmediate(() => process.emit('SIGTERM'));
    await runPromise;

    assert.equal(capturedTimeout, 60000, 'shutdown_timeout_ms는 job 중 최댓값(60000)을 사용해야 함');
  });

  test('config.api.enabled=false → httpServer가 생성되지 않음', async () => {
    const config = {
      servers: [],
      replication: { jobs: [] },
      api: { enabled: false },
    };

    const replicator = new Replicator(config);
    const runPromise = replicator.run();
    setImmediate(() => process.emit('SIGTERM'));
    await runPromise;

    assert.equal(replicator.httpServer, null, 'api.enabled=false → httpServer=null');
  });
});
