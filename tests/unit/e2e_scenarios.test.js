'use strict';

/**
 * E2E 시나리오 단위 테스트 (mock 기반)
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const { Worker } = require('../../worker/worker.js');
const CheckpointStore = require('../../file/checkpoint.js');

// ─── 공통 헬퍼 ───────────────────────────────────────────────────────────────

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'e2e-test-'));
}

function makeFlag(autoShutdownAfterMs) {
  const flag = { value: false };
  if (autoShutdownAfterMs != null) {
    setTimeout(() => { flag.value = true; }, autoShutdownAfterMs);
  }
  return flag;
}

function baseMapping(overrides = {}) {
  return {
    mapping_id: 'map-e2e',
    source: { server: 'src', table: 'TAG', tag_identifier: { mode: 'none', value: '' }, columns: null },
    target: { server: 'dst', table: 'TAG2' },
    execution: {
      query_limit: 100,
      poll_interval_ms: 20,
      start_mode: 'full',
      on_save_failure: 'continue',
      integrity: { enabled: false },
      ...overrides,
    },
  };
}

function logMapping(overrides = {}) {
  return {
    mapping_id: 'map-log',
    source: { server: 'src', table: 'LOG_TABLE', tag_identifier: { mode: 'none', value: '' }, columns: null },
    target: { server: 'dst', table: 'LOG_TABLE2' },
    execution: {
      query_limit: 100,
      poll_interval_ms: 20,
      start_mode: 'full',
      on_save_failure: 'continue',
      integrity: { enabled: true },
      ...overrides,
    },
  };
}

function makeTagSchema() {
  return {
    tableType: 'TAG',
    logicalTable: 'TAG',
    columns: [
      { name: 'NAME', columnType: { type: 'varchar', safeNull: '' }, id: 0, category: 'key' },
      { name: 'TIME', columnType: { type: 'int64', safeNull: 0n }, id: 2, category: 'data' },
      { name: 'VALUE', columnType: { type: 'float64', safeNull: 0.0 }, id: 3, category: 'data' },
    ],
  };
}

function makeLogSchema() {
  return {
    tableType: 'LOG',
    logicalTable: 'LOG_TABLE',
    columns: [
      { name: 'NAME', columnType: { type: 'varchar', safeNull: '' }, id: 0, category: 'data' },
      { name: 'TIME', columnType: { type: 'int64', safeNull: 0n }, id: 1, category: 'data' },
      { name: 'VALUE', columnType: { type: 'float64', safeNull: 0.0 }, id: 2, category: 'data' },
    ],
  };
}

function patchIntegrityChecker(batchExistsFn) {
  const IC = require('../../machbase/integrity_checker.js');
  const origBatch = IC.batchExists;
  if (batchExistsFn) IC.batchExists = batchExistsFn;
  return () => { IC.batchExists = origBatch; };
}

function patchMachbaseClient() {
  const mod = require('../../machbase/machbase.js');
  const origConnect = mod.MachbaseClient.prototype.connect;
  const origClose = mod.MachbaseClient.prototype.close;
  mod.MachbaseClient.prototype.connect = async function() {};
  mod.MachbaseClient.prototype.close = async function() {};
  return () => {
    mod.MachbaseClient.prototype.connect = origConnect;
    mod.MachbaseClient.prototype.close = origClose;
  };
}

function patchReader(readFn) {
  const mod = require('../../machbase/reader.js');
  const origReadAfterRid = mod.Reader.prototype.readAfterRid;
  const origGetMaxRid = mod.Reader.prototype.getMaxRid;
  const origClose = mod.Reader.prototype.close;
  const origRefresh = mod.Reader.prototype.refreshConnection;
  const origLoad = mod.TagAliasCache.prototype.load;
  const origResolve = mod.TagAliasCache.prototype.resolve;

  mod.Reader.prototype.readAfterRid = readFn
    ? async function(startRid, limit, rangeSize) { return readFn(startRid, limit, rangeSize); }
    : async function() { return { rows: [], err: null }; };
  mod.Reader.prototype.getMaxRid = async function() { return { maxRid: 0n, err: null }; };
  mod.Reader.prototype.close = async function() {};
  mod.Reader.prototype.refreshConnection = async function() {};
  mod.TagAliasCache.prototype.load = async function() { return null; };
  mod.TagAliasCache.prototype.resolve = async function(client, tagId) {
    // default: tagId 1 → sensor_a
    const map = { 1: 'sensor_a' };
    const name = map[Number(tagId)];
    if (!name) return { canonical: null, status: 'drop_not_found' };
    return { canonical: name, status: 'ok' };
  };

  return () => {
    mod.Reader.prototype.readAfterRid = origReadAfterRid;
    mod.Reader.prototype.getMaxRid = origGetMaxRid;
    mod.Reader.prototype.close = origClose;
    mod.Reader.prototype.refreshConnection = origRefresh;
    mod.TagAliasCache.prototype.load = origLoad;
    mod.TagAliasCache.prototype.resolve = origResolve;
  };
}

function patchWriter(appendFn) {
  const { Writer: TW } = require('../../machbase/writer.js');
  const origOpen = TW.prototype.open;
  const origAppend = TW.prototype.append;
  const origClose = TW.prototype.close;
  TW.prototype.open = async function() {
    this.srcNames = new Set();
    this.stream = { append: async () => {}, close: async () => {} };
    return null;
  };
  if (appendFn) TW.prototype.append = appendFn;
  TW.prototype.close = async function() { return null; };
  return () => {
    TW.prototype.open = origOpen;
    TW.prototype.append = origAppend;
    TW.prototype.close = origClose;
  };
}

/** TAG Worker 생성 헬퍼 */
function makeTagWorker(jobId, tmpDir, mapping, shutdownFlag) {
  const schema = makeTagSchema();
  return new Worker(
    jobId,
    { directory: tmpDir },
    mapping,
    'TAG',
    '_TAG_DATA_0',
    schema,
    schema,
    { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
    { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
    shutdownFlag,
  );
}

/** LOG Worker 생성 헬퍼 */
function makeLogWorker(jobId, tmpDir, mapping, shutdownFlag) {
  const schema = makeLogSchema();
  return new Worker(
    jobId,
    { directory: tmpDir },
    mapping,
    'LOG',
    'LOG_TABLE',
    schema,
    schema,
    { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
    { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
    shutdownFlag,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// E2E-02: SIGKILL 후 재시작 — STARTUP_INTEGRITY가 기존 복제분 skip
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E-02: SIGKILL 후 재시작 — STARTUP_INTEGRITY skip 동작', () => {
  let restores = [];

  afterEach(() => {
    while (restores.length) restores.pop()();
  });

  test('재시작 시 대상에 이미 존재하는 행은 skipped_exists로 건너뜀', async () => {
    const tmpDir = await makeTmpDir();
    const store = new CheckpointStore(tmpDir);
    const IC = require('../../machbase/integrity_checker.js');

    await store.save('e2e02', '_TAG_DATA_0', {
      last_success_rid: 1n,
      source_server: 'src',
      source_table: 'TAG',
    }, { rows_read: 1, rows_written: 1, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = { value: false };
    const skippedRids = [];
    const writtenRids = [];

    let integrityReadDone = false;
    let steadyBatch = 0;

    restores.push(patchMachbaseClient());

    restores.push(patchReader((startRid) => {
      if (!integrityReadDone) {
        integrityReadDone = true;
        return {
          rows: [
            { rid: 2n, tagId: 1, data: { TIME: 1000n, VALUE: 1.0 } },
            { rid: 3n, tagId: 1, data: { TIME: 2000n, VALUE: 2.0 } },
          ],
          err: null,
        };
      }
      steadyBatch++;
      if (steadyBatch === 1) {
        return {
          rows: [
            { rid: 3n, tagId: 1, data: { TIME: 2000n, VALUE: 2.0 } },
            { rid: 4n, tagId: 1, data: { TIME: 3000n, VALUE: 3.0 } },
          ],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    }));

    restores.push(patchIntegrityChecker(async (conn, table, rows) => {
      const existSet = new Set();
      for (const r of rows) {
        if (r.time === 1000n) {
          existSet.add(IC.existKey(r.canonical, r.time));
          skippedRids.push(2n);
        }
      }
      return { existSet, err: null };
    }));

    restores.push(patchWriter(async function(rows) {
      for (const r of rows) writtenRids.push(r);
      return null;
    }));

    try {
      const worker = makeTagWorker('e2e02', tmpDir, baseMapping({ integrity: { enabled: true } }), shutdownFlag);
      await worker.run(new AbortController().signal);

      assert.ok(skippedRids.length >= 1, 'skipped_exists > 0: 기존 복제분이 skip되어야 함');
      assert.ok(writtenRids.length >= 2, 'STEADY에서 rid=2,3이 기록되어야 함');

      const { cp } = await store.load('e2e02', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 4n, '최종 checkpoint = maxRid(4n) — 마지막 성공 RID');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-03: SIGTERM graceful — shutdown_timeout_ms 이내 종료, cp 최신 상태
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E-03: SIGTERM graceful shutdown', () => {
  let restores = [];

  afterEach(() => {
    while (restores.length) restores.pop()();
  });

  test('배치 처리 도중 shutdown_requested=true → 현재 배치 완료 후 종료, cp 갱신', async () => {
    const tmpDir = await makeTmpDir();
    const store = new CheckpointStore(tmpDir);
    const shutdownFlag = { value: false };
    let batchCount = 0;

    restores.push(patchMachbaseClient());

    restores.push(patchReader((startRid) => {
      batchCount++;
      if (batchCount === 1) {
        return {
          rows: [
            { rid: 10n, tagId: 1, data: { TIME: 1000n, VALUE: 1.0 } },
            { rid: 11n, tagId: 1, data: { TIME: 2000n, VALUE: 2.0 } },
          ],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    }));

    const writtenRows = [];
    restores.push(patchWriter(async function(rows) {
      writtenRows.push(...rows);
      return null;
    }));

    const startTime = Date.now();

    try {
      const worker = makeTagWorker('e2e03', tmpDir, baseMapping({ integrity: { enabled: false } }), shutdownFlag);
      await worker.run(new AbortController().signal);

      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 30000, `종료 시간(${elapsed}ms)이 shutdown_timeout_ms(30000ms) 이내여야 함`);

      const { cp } = await store.load('e2e03', '_TAG_DATA_0');
      assert.ok(cp !== null, 'checkpoint가 저장되어야 함');
      assert.equal(cp.last_success_rid, 11n, '첫 배치 완료 후 cp = maxRid(11n) — 마지막 성공 RID');
      assert.equal(writtenRows.length, 2, '배치 처리 완료: 2개 row가 기록되어야 함');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('SLEEP 중 shutdown_requested=true → 즉시 깨어나 종료', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let readCount = 0;

    restores.push(patchMachbaseClient());

    restores.push(patchReader(() => {
      readCount++;
      if (readCount === 1) {
        setTimeout(() => { shutdownFlag.value = true; }, 10);
        return { rows: [], err: null };
      }
      return { rows: [], err: null };
    }));

    restores.push(patchWriter(null));

    const startTime = Date.now();

    try {
      const worker = makeTagWorker('e2e03-sleep', tmpDir, baseMapping({ poll_interval_ms: 5000, integrity: { enabled: false } }), shutdownFlag);
      await worker.run(new AbortController().signal);

      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 500, `SLEEP 중 즉시 깨어나야 함: elapsed=${elapsed}ms (기대 < 500ms)`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-05: LOG 테이블 복제 — STARTUP_INTEGRITY 미수행 확인
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E-05: LOG 테이블 복제 — STARTUP_INTEGRITY 미수행', () => {
  let restores = [];

  afterEach(() => {
    while (restores.length) restores.pop()();
  });

  test('LOG 테이블 + cp 존재 + integrity.enabled=true → STARTUP_INTEGRITY 미수행, tag_id 변환 없이 기록', async () => {
    const tmpDir = await makeTmpDir();
    const store = new CheckpointStore(tmpDir);

    await store.save('e2e05', 'LOG_TABLE', {
      last_success_rid: 50n,
      source_server: 'src',
      source_table: 'LOG_TABLE',
    }, { rows_read: 10, rows_written: 10, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = { value: false };
    const integrityCallCount = { count: 0 };

    let batchCount = 0;

    restores.push(patchMachbaseClient());

    restores.push(patchReader((startRid) => {
      batchCount++;
      if (batchCount === 1) {
        return {
          rows: [
            { rid: 51n, tagId: null, data: { NAME: 'machine_temp', TIME: 1000n, VALUE: 25.5 } },
            { rid: 52n, tagId: null, data: { NAME: 'machine_vibr', TIME: 2000n, VALUE: 0.3 } },
          ],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    }));

    restores.push(patchIntegrityChecker(async () => {
      integrityCallCount.count++;
      return { existSet: new Set(), err: null };
    }));

    const writtenRows = [];
    restores.push(patchWriter(async function(rows) {
      writtenRows.push(...rows);
      return null;
    }));

    try {
      const worker = makeLogWorker('e2e05', tmpDir, logMapping(), shutdownFlag);
      await worker.run(new AbortController().signal);

      assert.equal(integrityCallCount.count, 0, 'LOG 테이블 → STARTUP_INTEGRITY(batchExists) 미수행');
      assert.equal(writtenRows.length, 2, '2개 LOG row가 기록되어야 함');
      assert.equal(writtenRows[0].NAME, 'machine_temp', 'LOG: tag_id 변환 없이 NAME에 그대로 사용');
      assert.equal(writtenRows[1].NAME, 'machine_vibr', 'LOG: tag_id 변환 없이 NAME에 그대로 사용');

      const { cp } = await store.load('e2e05', 'LOG_TABLE');
      assert.equal(cp.last_success_rid, 52n, 'LOG 복제 후 cp = maxRid(52n) — 마지막 성공 RID');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-06: 대상 DB 연결 차단 → retry → 복구 후 자동 재개
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E-06: 대상 DB 연결 차단 → retry → 복구 후 자동 재개', () => {
  let restores = [];

  afterEach(() => {
    while (restores.length) restores.pop()();
  });

  test('append 첫 호출 실패(retryable) → retry 후 성공, 정상 복제 완료', async () => {
    const tmpDir = await makeTmpDir();
    const store = new CheckpointStore(tmpDir);
    const shutdownFlag = { value: false };

    let batchCount = 0;

    restores.push(patchMachbaseClient());

    restores.push(patchReader((startRid) => {
      batchCount++;
      if (batchCount === 1) {
        return {
          rows: [
            { rid: 100n, tagId: 1, data: { TIME: 5000n, VALUE: 9.9 } },
          ],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    }));

    let appendAttempt = 0;
    const writtenRows = [];
    restores.push(patchWriter(async function(rows) {
      appendAttempt++;
      if (appendAttempt === 1) {
        const err = new Error('Connection refused');
        err.code = 'ECONNREFUSED';
        return err;
      }
      writtenRows.push(...rows);
      return null;
    }));

    try {
      const worker = makeTagWorker('e2e06', tmpDir, baseMapping({
        integrity: { enabled: false },
        retry: {
          enabled: true,
          strategy: 'linear',
          base_delay_ms: 10,
          max_delay_ms: 50,
          multiplier: 1,
          jitter: false,
          max_attempts: 5,
        },
      }), shutdownFlag);
      await worker.run(new AbortController().signal);

      assert.equal(appendAttempt, 2, 'append 1회 실패 후 retry → 총 2회 시도');
      assert.equal(writtenRows.length, 1, '최종적으로 1개 row가 기록되어야 함');
      assert.equal(writtenRows[0].NAME, 'sensor_a', '복구 후 정상 기록');

      const { cp } = await store.load('e2e06', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 100n, 'cp = maxRid(100n) — 마지막 성공 RID');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('retry max_attempts 초과 → mapping skip (Worker 종료)', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };

    restores.push(patchMachbaseClient());

    restores.push(patchReader(() => ({
      rows: [{ rid: 1n, tagId: 1, data: { TIME: 1000n, VALUE: 1.0 } }],
      err: null,
    })));

    let appendCount = 0;
    restores.push(patchWriter(async function(rows) {
      appendCount++;
      const err = new Error('Connection refused');
      err.code = 'ECONNREFUSED';
      return err;
    }));

    try {
      const worker = makeTagWorker('e2e06-exhaust', tmpDir, baseMapping({
        integrity: { enabled: false },
        retry: {
          enabled: true,
          strategy: 'linear',
          base_delay_ms: 5,
          max_delay_ms: 20,
          multiplier: 1,
          jitter: false,
          max_attempts: 3,
        },
      }), shutdownFlag);
      await worker.run(new AbortController().signal);

      assert.equal(appendCount, 3, 'max_attempts=3 → 3회 append 시도 후 종료');
      assert.equal(shutdownFlag.value, false, 'shutdownFlag는 변경되지 않아야 함');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-07: cp 파일 손상 → start_mode 기준 시작, stage="checkpoint_io" 로그
// ─────────────────────────────────────────────────────────────────────────────
describe('E2E-07: cp 파일 손상 → start_mode 기준 시작', () => {
  let restores = [];

  afterEach(() => {
    while (restores.length) restores.pop()();
  });

  test('JSON 파싱 실패한 cp 파일 → start_mode=full → startRid=0n, stage=checkpoint_io 로그 출력', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = makeFlag(30);

    const cpFile = path.join(tmpDir, 'e2e07_TAG_DATA_0.json');
    await fs.writeFile(cpFile, '{ broken json !!', 'utf-8');

    // Logger를 mock하여 error 로그를 캡처
    const loggerMod = require('../../logger/logger.js');
    const logger = loggerMod.getInstance();
    const origError = logger.error.bind(logger);
    const logs = [];
    logger.error = (stage, fields) => { logs.push({ stage, ...fields }); };
    restores.push(() => { logger.error = origError; });

    const readCalls = [];

    restores.push(patchMachbaseClient());

    restores.push(patchReader((startRid) => {
      readCalls.push(startRid);
      return { rows: [], err: null };
    }));

    restores.push(patchWriter(null));

    try {
      const worker = makeTagWorker('e2e07', tmpDir, baseMapping({ start_mode: 'full', integrity: { enabled: false } }), shutdownFlag);
      await worker.run(new AbortController().signal);

      assert.ok(readCalls.length >= 1, '최소 1회 이상 read 호출');
      assert.equal(readCalls[0], 0n, '파싱 실패 → start_mode=full → startRid=0n');

      const cpIoLog = logs.find(l => l.stage === 'checkpoint_io');
      assert.ok(cpIoLog !== undefined, 'stage="checkpoint_io" 오류 로그가 출력되어야 함');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

});
