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
          { id: 'job-1', autoStart: false, shutdownTimeoutMs: 30000 },
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

  test('shutdownTimeoutMs: 여러 job 중 최댓값 사용', async () => {
    // Replicator._startShutdownTimer 호출 여부와 인수를 spy
    const config = {
      servers: [],
      replication: {
        jobs: [
          { id: 'job-a', autoStart: false, shutdownTimeoutMs: 10000 },
          { id: 'job-b', autoStart: false, shutdownTimeoutMs: 60000 },
          { id: 'job-c', autoStart: false, shutdownTimeoutMs: 5000 },
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

    assert.equal(capturedTimeout, 60000, 'shutdownTimeoutMs는 job 중 최댓값(60000)을 사용해야 함');
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

  test('autoStart=true → 시작 시 scheduler.start() 호출됨', async () => {
    const config = {
      servers: [],
      replication: {
        jobs: [
          { id: 'job-auto', autoStart: true, shutdownTimeoutMs: 30000 },
          { id: 'job-manual', autoStart: false, shutdownTimeoutMs: 30000 },
        ],
      },
    };

    const replicator = new Replicator(config);
    const started = [];
    replicator.scheduler.start = function(id) {
      started.push(id);
      // 실제 job 실행 없이 status만 running으로 흉내 (SIGTERM 후 stopAll이 빠르게 완료되도록)
      const entry = this.registry.get(id);
      if (entry) {
        entry.status = 'running';
        entry.promise = Promise.resolve();
      }
    };

    const runPromise = replicator.run();
    setImmediate(() => process.emit('SIGTERM'));
    await runPromise;

    assert.deepEqual(started, ['job-auto'], 'autoStart=true인 job만 start 호출');
  });
});
