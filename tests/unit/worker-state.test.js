'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  makeShutdownFlag, makeSignal,
  setupWorkerPrototypeMocks, makeTagWorker, makeLogWorker,
} = require('./fixtures/worker_fixtures.js');

// ─── RESOLVE_START ────────────────────────────────────────────────────────────

describe('Worker — RESOLVE_START', () => {
  test('체크포인트 없음 + startMode=full → startRid=0n 으로 시작 후 빈 배치 대기 후 shutdown', async () => {
    const shutdownFlag = makeShutdownFlag(50);
    const readCalls = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: (startRid, limit) => {
        readCalls.push({ startRid, limit });
        return { rows: [], err: null };
      },
    });

    try {
      const worker = makeTagWorker('test-job', null, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.ok(readCalls.length >= 1, '최소 1회 이상 read 호출되어야 함');
      assert.equal(readCalls[0].startRid, 0n, 'startMode=full → startRid=0n');
    } finally {
      restore();
    }
  });

  test('체크포인트 있음 → lastSuccessRid에서 재개', async () => {
    const shutdownFlag = makeShutdownFlag(30);
    const readCalls = [];

    const { restore, seedCheckpoint } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        readCalls.push(startRid);
        return { rows: [], err: null };
      },
    });
    seedCheckpoint('test-job', '_TAG_DATA_0', 1234n);

    try {
      const worker = makeTagWorker('test-job', null, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.ok(readCalls.length >= 1);
      assert.equal(readCalls[0], 1235n, '체크포인트 lastSuccessRid=1234n → startRid=1235n (1234n+1n)');
    } finally {
      restore();
    }
  });
});

// ─── STEADY_REPLICATION ───────────────────────────────────────────────────────

describe('Worker — STEADY_REPLICATION', () => {
  test('TAG 배치 처리 → checkpoint가 maxRid+1로 갱신됨', async () => {
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore, getCheckpoint } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        batchCall++;
        if (batchCall === 1) {
          return {
            rows: [
              { rid: 10n, data: { NAME: 'tag_a', TIME: 1000n, VALUE: 1.1 } },
              { rid: 11n, data: { NAME: 'tag_b', TIME: 2000n, VALUE: 2.2 } },
              { rid: 12n, data: { NAME: 'tag_a', TIME: 3000n, VALUE: 3.3 } },
            ],
            err: null,
          };
        }
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      appendFn: async function(rows) {
        appendedRows.push(...rows);
        return null;
      },
    });

    try {
      const worker = makeTagWorker('test-job-2', null, {}, shutdownFlag);
      await worker.run(makeSignal());

      const { cp } = getCheckpoint('test-job-2', '_TAG_DATA_0');
      assert.equal(cp.lastSuccessRid, 12n, 'checkpoint = maxRid(12n)');
      assert.equal(appendedRows.length, 3, '3개 row가 append되어야 함');
    } finally {
      restore();
    }
  });

  test('drop_not_found → read()가 제외 후 남은 rows만 append, checkpoint = maxRidInBatch', async () => {
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore, getCheckpoint } = setupWorkerPrototypeMocks({
      readFn: () => {
        batchCall++;
        if (batchCall === 1) {
          return {
            rows: [
              { rid: 5n, data: { NAME: 'sensor_ok', TIME: 1000n, VALUE: 0.0 } },
            ],
            err: null,
          };
        }
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      appendFn: async function(rows) {
        appendedRows.push(...rows);
        return null;
      },
    });

    try {
      const worker = makeTagWorker('test-alldrop', null, {}, shutdownFlag);
      await worker.run(makeSignal());

      const { cp } = getCheckpoint('test-alldrop', '_TAG_DATA_0');
      assert.equal(cp.lastSuccessRid, 5n, 'checkpoint = maxRidInBatch(5n)');
      assert.equal(appendedRows.length, 1, '1개 row append');
    } finally {
      restore();
    }
  });

  test('LOG 테이블 → tag_id 변환 없이 그대로 append', async () => {
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => {
        batchCall++;
        if (batchCall === 1) {
          return {
            rows: [{ rid: 20n, data: { NAME: 'raw_name', TIME: 5000n, VALUE: 9.9 } }],
            err: null,
          };
        }
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      appendFn: async function(rows) {
        appendedRows.push(...rows);
        return null;
      },
    });

    try {
      const worker = makeLogWorker('test-log', null, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendedRows.length, 1);
      assert.equal(appendedRows[0].NAME, 'raw_name', 'LOG: data.NAME 그대로 사용');
    } finally {
      restore();
    }
  });

  test('stmtCount >= STMT_REFRESH_THRESHOLD(900) 도달 시 srcTable 연결 갱신', async () => {
    const shutdownFlag = { value: false };
    let batchCall = 0;

    // open/close 호출 횟수 추적 (초기 open 포함)
    const tableMod = require('../../src/db/table.js');
    const origOpen = tableMod.TagDataTable.prototype.open;
    const origClose = tableMod.TagDataTable.prototype.close;
    let openCount = 0;
    let closeCount = 0;

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => {
        batchCall++;
        // 450배치 × 2 쿼리 = 900 (STMT_REFRESH_THRESHOLD) 도달 후 한 배치 더 실행
        if (batchCall <= 451) {
          return {
            rows: [{ rid: BigInt(batchCall), data: { NAME: 'sensor_a', TIME: BigInt(batchCall * 1000), VALUE: 1.0 } }],
            err: null,
          };
        }
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      appendFn: async function() { return null; },
    });

    // setupWorkerPrototypeMocks 이후 open/close를 추가로 intercept
    const mockedOpen = tableMod.TagDataTable.prototype.open;
    tableMod.TagDataTable.prototype.open = async function() {
      openCount++;
      return mockedOpen.call(this);
    };
    const mockedClose = tableMod.TagDataTable.prototype.close;
    tableMod.TagDataTable.prototype.close = async function() {
      closeCount++;
      return mockedClose.call(this);
    };

    try {
      const worker = makeTagWorker('test-stmt-refresh', null, {}, shutdownFlag);
      await worker.run(makeSignal());

      // 초기 open 1회 + 갱신 1회 이상 = openCount >= 2
      assert.ok(openCount >= 2, `stmtCount 갱신 시 open이 재호출되어야 함 (실제 openCount=${openCount})`);
      // 갱신 시 close 후 open — 갱신 close 1회 이상 + finally close 1회
      assert.ok(closeCount >= 2, `stmtCount 갱신 시 close가 호출되어야 함 (실제 closeCount=${closeCount})`);
    } finally {
      tableMod.TagDataTable.prototype.open = origOpen;
      tableMod.TagDataTable.prototype.close = origClose;
      restore();
    }
  });
});

// ─── STARTUP_INTEGRITY ────────────────────────────────────────────────────────

describe('Worker — STARTUP_INTEGRITY', () => {
  test('integrity.enabled=false → STARTUP_INTEGRITY 미실행, 즉시 STEADY 진입', async () => {
    const shutdownFlag = makeShutdownFlag(30);
    const readCalls = [];
    const findFirstMissRowCalls = [];

    const tableMod = require('../../src/db/table.js');
    const origFindFirstMissRow = tableMod.TagTable.prototype.findFirstMissRow;
    tableMod.TagTable.prototype.findFirstMissRow = async function() {
      findFirstMissRowCalls.push(true);
      return { firstMissIdx: null, err: null };
    };

    const { restore, seedCheckpoint } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        readCalls.push(startRid);
        return { rows: [], err: null };
      },
    });
    seedCheckpoint('test-int', '_TAG_DATA_0', 10n);

    try {
      const worker = makeTagWorker('test-int', null, { integrity: { enabled: false } }, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(findFirstMissRowCalls.length, 0, 'integrity.enabled=false → findFirstMissRow 미호출');
      assert.equal(readCalls[0], 11n, 'STEADY는 checkpoint(10n)+1n=11n부터 시작해야 함');
    } finally {
      tableMod.TagTable.prototype.findFirstMissRow = origFindFirstMissRow;
      restore();
    }
  });

  test('TAG + checkpoint존재 + integrity.enabled → STARTUP_INTEGRITY 수행, firstMiss 발견 후 STEADY', async () => {
    const shutdownFlag = { value: false };
    let steadyReadCalls = [];
    let integrityReadDone = false;

    const tableMod = require('../../src/db/table.js');
    const origFindFirstMissRow = tableMod.TagTable.prototype.findFirstMissRow;
    // time===1000n인 row는 존재, 2000n은 miss → idx=1 반환
    tableMod.TagTable.prototype.findFirstMissRow = async function(rows) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].time !== 1000n) return { firstMissIdx: i, err: null };
      }
      return { firstMissIdx: null, err: null };
    };

    const appendedRows = [];

    const { restore, seedCheckpoint, getCheckpoint } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        if (!integrityReadDone) {
          integrityReadDone = true;
          return {
            rows: [
              { rid: 101n, data: { NAME: 'sensor_a', TIME: 1000n, VALUE: 1.0 } },
              { rid: 102n, data: { NAME: 'sensor_a', TIME: 2000n, VALUE: 2.0 } },
            ],
            err: null,
          };
        }
        steadyReadCalls.push(startRid);
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      appendFn: async function(rows) {
        appendedRows.push(...rows);
        return null;
      },
    });
    seedCheckpoint('test-int2', '_TAG_DATA_0', 100n);

    try {
      const worker = makeTagWorker('test-int2', null, { integrity: { enabled: true } }, shutdownFlag);
      await worker.run(makeSignal());

      const { cp } = getCheckpoint('test-int2', '_TAG_DATA_0');
      assert.equal(cp.lastSuccessRid, 101n, 'STARTUP_INTEGRITY: safe_cp_rid = firstMiss(102n) - 1n = 101n');
      assert.equal(steadyReadCalls[0], 102n, 'STEADY는 firstMissRid(102n)부터 시작');
    } finally {
      tableMod.TagTable.prototype.findFirstMissRow = origFindFirstMissRow;
      restore();
    }
  });

  test('STARTUP_INTEGRITY: 배치 내 모든 row 존재 → 다음 배치로 진행 후 소스 소진 시 STEADY 진입', async () => {
    const tableMod = require('../../src/db/table.js');
    const origFindFirstMissRow = tableMod.TagTable.prototype.findFirstMissRow;
    // 모든 row 존재 → firstMissIdx: null
    tableMod.TagTable.prototype.findFirstMissRow = async function() {
      return { firstMissIdx: null, err: null };
    };

    let integrityBatch = 0;
    let steadyStartRid = null;
    const shutdownFlag = { value: false };

    const { restore, seedCheckpoint } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        integrityBatch++;
        if (integrityBatch === 1) {
          return {
            rows: [
              { rid: 51n, data: { NAME: 'sensor_a', TIME: 1000n, VALUE: 1.0 } },
              { rid: 52n, data: { NAME: 'sensor_b', TIME: 2000n, VALUE: 2.0 } },
            ],
            err: null,
          };
        }
        if (integrityBatch === 2) {
          return { rows: [], err: null };
        }
        steadyStartRid = startRid;
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
    });
    seedCheckpoint('test-int-allexist', '_TAG_DATA_0', 50n);

    try {
      const worker = makeTagWorker('test-int-allexist', null, { integrity: { enabled: true } }, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(steadyStartRid, 53n, 'STEADY는 integrity 마지막 배치 maxRid(52n)+1n=53n부터 시작');
    } finally {
      tableMod.TagTable.prototype.findFirstMissRow = origFindFirstMissRow;
      restore();
    }
  });

  test('LOG 테이블 → checkpoint 있어도 STARTUP_INTEGRITY 미수행', async () => {
    const shutdownFlag = makeShutdownFlag(30);
    const findFirstMissRowCalls = [];

    const tableMod = require('../../src/db/table.js');
    const origFindFirstMissRow = tableMod.TagTable.prototype.findFirstMissRow;
    tableMod.TagTable.prototype.findFirstMissRow = async function() {
      findFirstMissRowCalls.push(true);
      return { firstMissIdx: null, err: null };
    };

    const { restore, seedCheckpoint } = setupWorkerPrototypeMocks({
      readFn: () => ({ rows: [], err: null }),
    });
    seedCheckpoint('test-log-int', '_LOG_DATA_0', 50n);

    try {
      const worker = makeLogWorker('test-log-int', null, { integrity: { enabled: true } }, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(findFirstMissRowCalls.length, 0, 'LOG 테이블 → findFirstMissRow 미호출');
    } finally {
      tableMod.TagTable.prototype.findFirstMissRow = origFindFirstMissRow;
      restore();
    }
  });
});

// ─── 에러 처리 ────────────────────────────────────────────────────────────────

describe('Worker — non-retryable 에러 처리', () => {
  test('read 에러 → Worker 즉시 종료 (retry 없음)', async () => {
    const shutdownFlag = { value: false };
    let readCallCount = 0;

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => {
        readCallCount++;
        const err = new Error('non-retryable read error');
        err.retryable = false;
        return { rows: [], err };
      },
    });

    try {
      const worker = makeTagWorker('test-nr', null,
        { retry: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 } },
        shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(readCallCount, 1, 'retryable=false → 재시도 없이 1회만 호출되어야 함');
    } finally {
      restore();
    }
  });

  test('Writer.append non-retryable 에러 → Worker 즉시 종료 (retry 없음)', async () => {
    const shutdownFlag = { value: false };
    let appendCallCount = 0;
    let readCallCount = 0;

    const { restore } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        readCallCount++;
        if (readCallCount === 1) {
          return {
            rows: [{ rid: 1n, data: { NAME: 'sensor_a', TIME: 1000n, VALUE: 1.0 } }],
            err: null,
          };
        }
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      appendFn: async function() {
        appendCallCount++;
        const err = new Error('non-retryable append error');
        err.retryable = false;
        return err;
      },
    });

    try {
      const worker = makeTagWorker('test-nr-append', null,
        { retry: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 } },
        shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendCallCount, 1, 'retryable=false → append 재시도 없이 1회만 호출되어야 함');
    } finally {
      restore();
    }
  });
});

describe('Worker — read 에러', () => {
  test('read 에러 → retry 없이 즉시 Worker 종료', async () => {
    const shutdownFlag = { value: false };
    let readCallCount = 0;

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => {
        readCallCount++;
        const err = new Error('read failure');
        return { rows: [], err };
      },
    });

    try {
      const worker = makeTagWorker('fw-read-err', null,
        { retry: { maxAttempts: 5, baseDelayMs: 5, maxDelayMs: 20 } },
        shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(readCallCount, 1, 'read 실패 → retry 없이 1회만 호출 후 Worker 종료');
      assert.equal(shutdownFlag.value, false, 'shutdownFlag는 변경되지 않아야 함');
    } finally {
      restore();
    }
  });
});

describe('Worker — append 에러 retry', () => {
  test('append 에러(retryable) → retry 후 복구', async () => {
    const shutdownFlag = { value: false };
    let batchCall = 0;
    let appendAttempt = 0;
    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => {
        batchCall++;
        if (batchCall === 1) {
          return {
            rows: [{ rid: 10n, data: { NAME: 'sensor_a', TIME: 5000n, VALUE: 9.9 } }],
            err: null,
          };
        }
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      appendFn: async (rows) => {
        appendAttempt++;
        if (appendAttempt === 1) {
          const err = new Error('Connection refused');
          err.code = 'ECONNREFUSED';
          return err;
        }
        appendedRows.push(...rows);
        return null;
      },
    });

    try {
      const worker = makeTagWorker('fw-append-retry', null,
        { retry: { maxAttempts: 5, baseDelayMs: 5, maxDelayMs: 20 } },
        shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendAttempt, 2, 'append 1회 실패 후 retry → 총 2회 시도');
      assert.equal(appendedRows.length, 1, '복구 후 1개 append');
    } finally {
      restore();
    }
  });
});

describe('Worker — shutdown 신호', () => {
  test('shutdown 신호 처리 — 즉시 종료', async () => {
    const shutdownFlag = makeShutdownFlag(10);

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => ({ rows: [], err: null }),
    });

    const startTime = Date.now();

    try {
      const worker = makeTagWorker('fw-shutdown', null, { pollIntervalMs: 5000 }, shutdownFlag);
      await worker.run(makeSignal());

      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 500, `shutdown 후 즉시 종료되어야 함 (elapsed: ${elapsed}ms)`);
    } finally {
      restore();
    }
  });
});

describe('Worker — 빈 배치 poll 대기', () => {
  test('빈 배치 → poll interval 대기 후 다시 읽기', async () => {
    const shutdownFlag = { value: false };
    let readCallCount = 0;

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => {
        readCallCount++;
        if (readCallCount >= 2) shutdownFlag.value = true;
        return { rows: [], err: null };
      },
    });

    try {
      const worker = makeTagWorker('fw-poll', null, { pollIntervalMs: 10 }, shutdownFlag);
      await worker.run(makeSignal());

      assert.ok(readCallCount >= 2, '빈 배치 후 poll 대기 → 재읽기 확인');
    } finally {
      restore();
    }
  });
});

// ─── E2E 시나리오 ─────────────────────────────────────────────────────────────

describe('Worker — TAG 복제 기본 흐름', () => {
  test('full start → steady: startRid=0n 으로 시작, 배치 후 checkpoint 갱신', async () => {
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore, getCheckpoint } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        batchCall++;
        if (batchCall === 1) {
          assert.equal(startRid, 0n, 'full start → startRid=0n');
          return {
            rows: [
              { rid: 1n, data: { NAME: 'sensor_a', TIME: 1000n, VALUE: 1.1 } },
              { rid: 2n, data: { NAME: 'sensor_b', TIME: 2000n, VALUE: 2.2 } },
            ],
            err: null,
          };
        }
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      appendFn: async (rows) => {
        appendedRows.push(...rows);
        return null;
      },
    });

    try {
      const worker = makeTagWorker('fw-tag-1', null, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendedRows.length, 2);
      assert.equal(appendedRows[0].NAME, 'sensor_a');

      const { cp } = getCheckpoint('fw-tag-1', '_TAG_DATA_0');
      assert.equal(cp.lastSuccessRid, 2n);
    } finally {
      restore();
    }
  });
});

describe('Worker — LOG 복제 기본 흐름', () => {
  test('LOG: tag_id 변환 없이 그대로 append', async () => {
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore, getCheckpoint } = setupWorkerPrototypeMocks({
      readFn: () => {
        batchCall++;
        if (batchCall === 1) {
          return {
            rows: [
              { rid: 10n, data: { NAME: 'machine_a', TIME: 5000n, VALUE: 9.9 } },
            ],
            err: null,
          };
        }
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      appendFn: async (rows) => {
        appendedRows.push(...rows);
        return null;
      },
    });

    try {
      const worker = makeLogWorker('fw-log-1', null, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendedRows.length, 1);
      assert.equal(appendedRows[0].NAME, 'machine_a');

      const { cp } = getCheckpoint('fw-log-1', '_LOG_DATA_0');
      assert.equal(cp.lastSuccessRid, 10n);
    } finally {
      restore();
    }
  });
});

describe('Worker — checkpoint resume', () => {
  test('checkpoint 저장 후 재시작 → startRid = lastSuccessRid + 1', async () => {
    const shutdownFlag = makeShutdownFlag(30);
    const readCalls = [];

    const { restore, seedCheckpoint } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        readCalls.push(startRid);
        return { rows: [], err: null };
      },
    });
    seedCheckpoint('fw-resume', '_TAG_DATA_0', 999n);

    try {
      const worker = makeTagWorker('fw-resume', null, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.ok(readCalls.length >= 1);
      assert.equal(readCalls[0], 1000n, 'checkpoint 999n → startRid=1000n');
    } finally {
      restore();
    }
  });
});

describe('Worker — drop_not_found', () => {
  test('read()가 drop_not_found 제외한 rows 반환 → 배치 rows.length로 확인', async () => {
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => {
        batchCall++;
        if (batchCall === 1) {
          return {
            rows: [
              { rid: 5n, data: { NAME: 'sensor_ok', TIME: 1000n, VALUE: 1.0 } },
            ],
            err: null,
          };
        }
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      appendFn: async (rows) => {
        appendedRows.push(...rows);
        return null;
      },
    });

    try {
      const worker = makeTagWorker('fw-drop', null, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendedRows.length, 1, 'drop_not_found 제외 후 1개만 append');
      assert.equal(appendedRows[0].NAME, 'sensor_ok');
    } finally {
      restore();
    }
  });
});
