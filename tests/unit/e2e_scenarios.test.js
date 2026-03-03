'use strict';

/**
 * E2E 시나리오 단위 테스트 (mock 기반)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const { runDataTableWorker } = require('../../worker/worker.js');
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
    source: { server: 'src', table: 'TAG' },
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
    source: { server: 'src', table: 'LOG_TABLE' },
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

/** TAG Reader mock */
function makeTagSourceReader(metaMap = new Map([[1, 'sensor_a']]), readFn = null) {
  return {
    schema: {
      tableType: 'TAG',
      logicalTable: 'TAG',
      dataColumns: [
        { name: 'TIME', columnType: { type: 'int64' }, id: 2, category: 'data' },
        { name: 'VALUE', columnType: { type: 'float64' }, id: 3, category: 'data' },
      ],
      metadataColumns: [],
      writeColumns: [
        { name: 'NAME', columnType: { type: 'varchar' }, id: 0, category: 'key' },
        { name: 'TIME', columnType: { type: 'int64' }, id: 2, category: 'data' },
        { name: 'VALUE', columnType: { type: 'float64' }, id: 3, category: 'data' },
      ],
      getSelectColumnNames() { return ['time', 'value']; },
    },
    aliasCache: { _map: metaMap, get size() { return metaMap.size; } },
    dataTable: '_TAG_DATA_0',
    get aliasSize() { return metaMap.size; },
    async loadAliases() { return null; },
    async resolveTagCanonical(tagId) {
      const tagIdBig = BigInt(tagId);
      const name = metaMap.get(tagIdBig) || metaMap.get(Number(tagId));
      if (!name) return { canonical: null, status: 'drop_not_found' };
      return { canonical: name, status: 'ok' };
    },
    async close() {},
    async refreshConnection(config) {},
    async getMaxRid() {
      return { maxRid: 0n, err: null };
    },
    async readAfterRid(startRid, limit, rangeSize) {
      if (readFn) return readFn(startRid, limit, rangeSize);
      return { rows: [], err: null };
    },
  };
}

/** LOG Reader mock */
function makeLogSourceReader(readFn = null) {
  return {
    schema: {
      tableType: 'LOG',
      logicalTable: 'LOG_TABLE',
      dataColumns: [
        { name: 'NAME', columnType: { type: 'varchar' }, id: 0, category: 'data' },
        { name: 'TIME', columnType: { type: 'int64' }, id: 1, category: 'data' },
        { name: 'VALUE', columnType: { type: 'float64' }, id: 2, category: 'data' },
      ],
      metadataColumns: [],
      writeColumns: [
        { name: 'NAME', columnType: { type: 'varchar' }, id: 0, category: 'data' },
        { name: 'TIME', columnType: { type: 'int64' }, id: 1, category: 'data' },
        { name: 'VALUE', columnType: { type: 'float64' }, id: 2, category: 'data' },
      ],
      getSelectColumnNames() { return ['name', 'time', 'value']; },
    },
    aliasCache: null,
    dataTable: 'LOG_TABLE',
    get aliasSize() { return 0; },
    async loadAliases() { return null; },
    async close() {},
    async refreshConnection(config) {},
    async getMaxRid() {
      return { maxRid: 0n, err: null };
    },
    async readAfterRid(startRid, limit, rangeSize) {
      if (readFn) return readFn(startRid, limit, rangeSize);
      return { rows: [], err: null };
    },
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

function patchWriter(appendFn) {
  const TW = require('../../machbase/writer.js');
  const origOpen = TW.prototype.open;
  const origAppend = TW.prototype.append;
  const origClose = TW.prototype.close;
  TW.prototype.open = async function() {
    this.appendColumns = [];
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

    const reader = makeTagSourceReader(new Map([[1, 'sensor_a']]), (startRid) => {
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
    });

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

    restores.push(patchMachbaseClient());

    restores.push(patchWriter(async function(rows) {
      for (const r of rows) writtenRids.push(r);
      return null;
    }));

    try {
      const Writer = require('../../machbase/writer.js');
      await runDataTableWorker({
        jobId: 'e2e02',
        mapping: baseMapping({ integrity: { enabled: true } }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        writer: new Writer(),
        shutdownFlag,
      });

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

    const reader = makeTagSourceReader(new Map([[1, 'sensor_a']]), (startRid) => {
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
    });

    const writtenRows = [];
    restores.push(patchWriter(async function(rows) {
      writtenRows.push(...rows);
      return null;
    }));

    const startTime = Date.now();

    try {
      const Writer = require('../../machbase/writer.js');
      await runDataTableWorker({
        jobId: 'e2e03',
        mapping: baseMapping({ integrity: { enabled: false } }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        writer: new Writer(),
        shutdownFlag,
      });

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

    const reader = makeTagSourceReader(new Map([[1, 'sensor_a']]), () => {
      readCount++;
      if (readCount === 1) {
        setTimeout(() => { shutdownFlag.value = true; }, 10);
        return { rows: [], err: null };
      }
      return { rows: [], err: null };
    });

    restores.push(patchWriter(null));

    const startTime = Date.now();

    try {
      const Writer = require('../../machbase/writer.js');
      await runDataTableWorker({
        jobId: 'e2e03-sleep',
        mapping: baseMapping({ poll_interval_ms: 5000, integrity: { enabled: false } }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        writer: new Writer(),
        shutdownFlag,
      });

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
    const IC = require('../../machbase/integrity_checker.js');
    const integrityCallCount = { count: 0 };

    let batchCount = 0;
    const reader = makeLogSourceReader((startRid) => {
      batchCount++;
      if (batchCount === 1) {
        return {
          rows: [
            { rid: 51n, tagId: 'machine_temp', data: { TIME: 1000n, VALUE: 25.5 } },
            { rid: 52n, tagId: 'machine_vibr', data: { TIME: 2000n, VALUE: 0.3 } },
          ],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    });

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
      const Writer = require('../../machbase/writer.js');
      await runDataTableWorker({
        jobId: 'e2e05',
        mapping: logMapping(),
        checkpoint: { directory: tmpDir },
        tableType: 'LOG',
        dataTable: 'LOG_TABLE',
        reader: reader,
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        writer: new Writer(),
        shutdownFlag,
      });

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
    const reader = makeTagSourceReader(new Map([[1, 'sensor_x']]), (startRid) => {
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
    });

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
      const Writer = require('../../machbase/writer.js');
      await runDataTableWorker({
        jobId: 'e2e06',
        mapping: baseMapping({
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
        }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        writer: new Writer(),
        shutdownFlag,
      });

      assert.equal(appendAttempt, 2, 'append 1회 실패 후 retry → 총 2회 시도');
      assert.equal(writtenRows.length, 1, '최종적으로 1개 row가 기록되어야 함');
      assert.equal(writtenRows[0].NAME, 'sensor_x', '복구 후 정상 기록');

      const { cp } = await store.load('e2e06', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 100n, 'cp = maxRid(100n) — 마지막 성공 RID');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('retry max_attempts 초과 → mapping skip (Worker 종료)', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };

    const reader = makeTagSourceReader(new Map([[1, 'tag_a']]), () => ({
      rows: [{ rid: 1n, tagId: 1, data: { TIME: 1000n, VALUE: 1.0 } }],
      err: null,
    }));

    let appendCount = 0;
    restores.push(patchWriter(async function(rows) {
      appendCount++;
      const err = new Error('Connection refused');
      err.code = 'ECONNREFUSED';
      return err;
    }));

    try {
      const Writer = require('../../machbase/writer.js');
      await runDataTableWorker({
        jobId: 'e2e06-exhaust',
        mapping: baseMapping({
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
        }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        writer: new Writer(),
        shutdownFlag,
      });

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
  let origConsoleError;

  beforeEach(() => {
    origConsoleError = console.error;
  });

  afterEach(() => {
    console.error = origConsoleError;
    while (restores.length) restores.pop()();
  });

  test('JSON 파싱 실패한 cp 파일 → start_mode=full → startRid=0n, stage=checkpoint_io 로그 출력', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = makeFlag(30);

    const cpFile = path.join(tmpDir, 'e2e07___TAG_DATA_0.json');
    await fs.writeFile(cpFile, '{ broken json !!', 'utf-8');

    const logs = [];
    console.error = (...args) => { logs.push(args.join(' ')); };

    const readCalls = [];
    const reader = makeTagSourceReader(new Map([[1, 'sensor_a']]), (startRid) => {
      readCalls.push(startRid);
      return { rows: [], err: null };
    });

    restores.push(patchWriter(null));

    try {
      const Writer = require('../../machbase/writer.js');
      await runDataTableWorker({
        jobId: 'e2e07',
        mapping: baseMapping({ start_mode: 'full', integrity: { enabled: false } }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        writer: new Writer(),
        shutdownFlag,
      });

      assert.ok(readCalls.length >= 1, '최소 1회 이상 read 호출');
      assert.equal(readCalls[0], 0n, '파싱 실패 → start_mode=full → startRid=0n');

      const cpIoLog = logs.find(l => l.includes('checkpoint_io'));
      assert.ok(cpIoLog !== undefined, 'stage="checkpoint_io" 오류 로그가 출력되어야 함');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('source.data_table 불일치 cp 파일 → start_mode=now → startRid=getMaxRid(), stage=checkpoint_io 로그', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = makeFlag(30);

    const cpFile = path.join(tmpDir, 'e2e07b___TAG_DATA_0.json');
    const corruptedCp = {
      version: 1,
      job_id: 'e2e07b',
      source: {
        server: 'src',
        table: 'TAG',
        data_table: '_TAG_DATA_WRONG',
      },
      checkpoint: {
        last_success_rid: '9999',
        updated_at: new Date().toISOString(),
      },
    };
    await fs.writeFile(cpFile, JSON.stringify(corruptedCp), 'utf-8');

    const logs = [];
    console.error = (...args) => { logs.push(args.join(' ')); };

    const readCalls = [];
    const reader = makeTagSourceReader(new Map([[1, 'sensor_a']]), (startRid) => {
      readCalls.push(startRid);
      return { rows: [], err: null };
    });
    reader.getMaxRid = async () => ({ maxRid: 777n, err: null });

    restores.push(patchWriter(null));

    try {
      const Writer = require('../../machbase/writer.js');
      await runDataTableWorker({
        jobId: 'e2e07b',
        mapping: baseMapping({ start_mode: 'now', integrity: { enabled: false } }),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        writer: new Writer(),
        shutdownFlag,
      });

      assert.ok(readCalls.length >= 1, '최소 1회 read 호출');
      assert.equal(readCalls[0], 778n, 'startRid = getMaxRid() + 1n = 778n (기존 마지막 RID 제외)');

      const cpIoLog = logs.find(l => l.includes('checkpoint_io'));
      assert.ok(cpIoLog !== undefined, 'stage="checkpoint_io" 오류 로그가 출력되어야 함');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
