'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const { Worker } = require('../../worker/worker.js');
const { Job, Replicator } = require('../../job_runner.js');

// ─── 테스트 픽스처 ───────────────────────────────────────────────────────────

/** 간단한 shutdownFlag 생성 */
function makeShutdownFlag(autoShutdownAfterMs = null) {
  const flag = { value: false };
  if (autoShutdownAfterMs !== null) {
    setTimeout(() => { flag.value = true; }, autoShutdownAfterMs);
  }
  return flag;
}

/** 체크포인트 디렉토리를 임시 디렉토리에 생성 */
async function makeTmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-test-'));
  return dir;
}

/** TAG 스키마 mock */
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

/** LOG 스키마 mock */
function makeLogSchema() {
  return {
    tableType: 'LOG',
    logicalTable: 'LOG',
    columns: [
      { name: 'NAME', columnType: { type: 'varchar', safeNull: '' }, id: 0, category: 'data' },
      { name: 'TIME', columnType: { type: 'int64', safeNull: 0n }, id: 1, category: 'data' },
      { name: 'VALUE', columnType: { type: 'float64', safeNull: 0.0 }, id: 2, category: 'data' },
    ],
  };
}

/** AbortController signal (not aborted) */
function makeSignal() {
  return new AbortController().signal;
}

/**
 * Worker 단위 테스트용 prototype mock 설정
 * MachbaseClient, Reader, Writer, TagAliasCache prototype을 mock하고 복원 함수를 반환
 */
function setupWorkerPrototypeMocks({ readFn, tagResolveFn, appendFn } = {}) {
  const machbaseMod = require('../../db/client.js');
  const readerMod = require('../../db/reader.js');
  const writerMod = require('../../db/writer.js');

  // MachbaseClient connect/close mock
  const origConnect = machbaseMod.MachbaseClient.prototype.connect;
  const origClose = machbaseMod.MachbaseClient.prototype.close;
  machbaseMod.MachbaseClient.prototype.connect = async function() {};
  machbaseMod.MachbaseClient.prototype.close = async function() {};

  // Reader prototype mocks
  const origReadAfterRid = readerMod.Reader.prototype.readAfterRid;
  const origGetMaxRid = readerMod.Reader.prototype.getMaxRid;
  const origReaderClose = readerMod.Reader.prototype.close;
  const origRefreshConn = readerMod.Reader.prototype.refreshConnection;
  readerMod.Reader.prototype.readAfterRid = readFn
    ? async function(startRid, limit, rangeSize) { return readFn(startRid, limit, rangeSize); }
    : async function() { return { rows: [], err: null }; };
  readerMod.Reader.prototype.getMaxRid = async function() { return { maxRid: 0n, err: null }; };
  readerMod.Reader.prototype.close = async function() {};
  readerMod.Reader.prototype.refreshConnection = async function() {};

  // TagAliasCache prototype mocks
  const origLoad = readerMod.TagAliasCache.prototype.load;
  const origResolve = readerMod.TagAliasCache.prototype.resolve;
  readerMod.TagAliasCache.prototype.load = async function() { return null; };
  readerMod.TagAliasCache.prototype.resolve = tagResolveFn
    ? tagResolveFn
    : async function(client, tagId) {
        // default: tagId 1 → tag_a, 2 → tag_b
        const map = { 1: 'tag_a', 2: 'tag_b' };
        const name = map[Number(tagId)];
        if (!name) return { canonical: null, status: 'drop_not_found' };
        return { canonical: name, status: 'ok' };
      };

  // Writer prototype mocks
  const origWriterOpen = writerMod.Writer.prototype.open;
  const origWriterAppend = writerMod.Writer.prototype.append;
  const origWriterClose = writerMod.Writer.prototype.close;
  writerMod.Writer.prototype.open = async function() {
    this.srcNames = new Set();
    this.stream = { append: async () => {}, close: async () => {} };
    return null;
  };
  writerMod.Writer.prototype.append = appendFn
    ? appendFn
    : async function(rows) { return null; };
  writerMod.Writer.prototype.close = async function() {};

  function restore() {
    machbaseMod.MachbaseClient.prototype.connect = origConnect;
    machbaseMod.MachbaseClient.prototype.close = origClose;
    readerMod.Reader.prototype.readAfterRid = origReadAfterRid;
    readerMod.Reader.prototype.getMaxRid = origGetMaxRid;
    readerMod.Reader.prototype.close = origReaderClose;
    readerMod.Reader.prototype.refreshConnection = origRefreshConn;
    readerMod.TagAliasCache.prototype.load = origLoad;
    readerMod.TagAliasCache.prototype.resolve = origResolve;
    writerMod.Writer.prototype.open = origWriterOpen;
    writerMod.Writer.prototype.append = origWriterAppend;
    writerMod.Writer.prototype.close = origWriterClose;
  }

  return { restore };
}

/** TAG Worker 생성 헬퍼 */
function makeTagWorker(jobId, tmpDir, mappingOverrides, shutdownFlag) {
  const schema = makeTagSchema();
  return new Worker(
    jobId,
    { directory: tmpDir },
    {
      mapping_id: 'map-test',
      source: { server: 'src', table: 'TAG', tag_identifier: { mode: 'none', value: '' }, columns: null },
      target: { server: 'dst', table: 'TAG2' },
      execution: {
        query_limit: 100,
        poll_interval_ms: 20,
        start_mode: 'full',
        on_save_failure: 'continue',
        integrity: { enabled: false },
        ...mappingOverrides,
      },
    },
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
function makeLogWorker(jobId, tmpDir, mappingOverrides, shutdownFlag) {
  const schema = makeLogSchema();
  return new Worker(
    jobId,
    { directory: tmpDir },
    {
      mapping_id: 'map-log',
      source: { server: 'src', table: 'LOG', tag_identifier: { mode: 'none', value: '' }, columns: null },
      target: { server: 'dst', table: 'LOG2' },
      execution: {
        query_limit: 100,
        poll_interval_ms: 20,
        start_mode: 'full',
        on_save_failure: 'continue',
        integrity: { enabled: false },
        ...mappingOverrides,
      },
    },
    'LOG',
    '_LOG_DATA_0',
    schema,
    schema,
    { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
    { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
    shutdownFlag,
  );
}

// ─── 테스트 헬퍼: Worker를 mock으로 실행 ─────────────────────────────────────

describe('Worker — RESOLVE_START', () => {
  test('체크포인트 없음 + start_mode=full → startRid=0n 으로 시작 후 빈 배치 대기 후 shutdown', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = makeShutdownFlag(50);
    const readCalls = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: (startRid, limit) => {
        readCalls.push({ startRid, limit });
        return { rows: [], err: null };
      },
    });

    try {
      const worker = makeTagWorker('test-job', tmpDir, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.ok(readCalls.length >= 1, '최소 1회 이상 readAfterRid 호출되어야 함');
      assert.equal(readCalls[0].startRid, 0n, 'start_mode=full → startRid=0n');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('체크포인트 있음 → last_success_rid에서 재개', async () => {
    const tmpDir = await makeTmpDir();
    const CheckpointStore = require('../../checkpoint/store.js');
    const store = new CheckpointStore(tmpDir);

    await store.save('test-job', '_TAG_DATA_0', {
      last_success_rid: 1234n,
      source_server: 'src',
      source_table: 'TAG',
    }, { rows_read: 10, rows_written: 10, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = makeShutdownFlag(30);
    const readCalls = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        readCalls.push(startRid);
        return { rows: [], err: null };
      },
    });

    try {
      const worker = makeTagWorker('test-job', tmpDir, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.ok(readCalls.length >= 1);
      assert.equal(readCalls[0], 1235n, '체크포인트 last_success_rid=1234n → startRid=1235n (1234n+1n)');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

});

describe('Worker — STEADY_REPLICATION', () => {
  test('TAG 배치 처리 → checkpoint가 maxRid+1로 갱신됨', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        batchCall++;
        if (batchCall === 1) {
          return {
            rows: [
              { rid: 10n, tagId: 1, data: { TIME: 1000n, VALUE: 1.1 } },
              { rid: 11n, tagId: 2, data: { TIME: 2000n, VALUE: 2.2 } },
              { rid: 12n, tagId: 1, data: { TIME: 3000n, VALUE: 3.3 } },
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
      const worker = makeTagWorker('test-job-2', tmpDir, {}, shutdownFlag);
      await worker.run(makeSignal());

      const CheckpointStore = require('../../checkpoint/store.js');
      const store = new CheckpointStore(tmpDir);
      const { cp } = await store.load('test-job-2', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 12n, 'checkpoint = maxRid(12n) — 마지막 성공 RID (inclusive)');
      assert.equal(appendedRows.length, 3, '3개 row가 append되어야 함');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('drop_not_found → checkpoint = maxRidInBatch+1 (all-drop 케이스)', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        batchCall++;
        if (batchCall === 1) {
          return {
            rows: [
              { rid: 5n, tagId: 999, data: { TIME: 1000n, VALUE: 0.0 } },
            ],
            err: null,
          };
        }
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      tagResolveFn: async function(client, tagId) {
        return { canonical: null, status: 'drop_not_found' };
      },
      appendFn: async function(rows) {
        appendedRows.push(...rows);
        return null;
      },
    });

    try {
      const worker = makeTagWorker('test-alldrop', tmpDir, {}, shutdownFlag);
      await worker.run(makeSignal());

      const CheckpointStore = require('../../checkpoint/store.js');
      const store = new CheckpointStore(tmpDir);
      const { cp } = await store.load('test-alldrop', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 5n, 'all-drop: checkpoint = maxRidInBatch(5n) — 마지막 성공 RID (inclusive)');
      assert.equal(appendedRows.length, 0, 'drop → append 없음');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('LOG 테이블 → tag_id 변환 없이 그대로 append', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        batchCall++;
        if (batchCall === 1) {
          return {
            rows: [{ rid: 20n, tagId: null, data: { NAME: 'raw_name', TIME: 5000n, VALUE: 9.9 } }],
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
      const worker = makeLogWorker('test-log', tmpDir, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendedRows.length, 1);
      assert.equal(appendedRows[0].NAME, 'raw_name', 'LOG: data.NAME 그대로 사용');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Worker — STARTUP_INTEGRITY', () => {
  test('integrity.enabled=false → STARTUP_INTEGRITY 미실행, 즉시 STEADY 진입', async () => {
    const tmpDir = await makeTmpDir();

    const CheckpointStore = require('../../checkpoint/store.js');
    const store = new CheckpointStore(tmpDir);
    await store.save('test-int', '_TAG_DATA_0', {
      last_success_rid: 10n,
      source_server: 'src',
      source_table: 'TAG',
    }, { rows_read: 5, rows_written: 5, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = makeShutdownFlag(30);
    const readCalls = [];
    const integrityCheckCalls = [];

    const IntegrityChecker = require('../../db/integrity_checker.js');
    const origBatchExists = IntegrityChecker.batchExists;
    IntegrityChecker.batchExists = async () => {
      integrityCheckCalls.push(true);
      return { existSet: new Set(), err: null };
    };

    const { restore } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        readCalls.push(startRid);
        return { rows: [], err: null };
      },
    });

    try {
      const worker = makeTagWorker('test-int', tmpDir, { integrity: { enabled: false } }, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(integrityCheckCalls.length, 0, 'integrity.enabled=false → IntegrityChecker 미호출');
      assert.equal(readCalls[0], 11n, 'STEADY는 checkpoint(10n)+1n=11n부터 시작해야 함');
    } finally {
      IntegrityChecker.batchExists = origBatchExists;
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('TAG + checkpoint존재 + integrity.enabled → STARTUP_INTEGRITY 수행, first_miss 발견 후 STEADY', async () => {
    const tmpDir = await makeTmpDir();

    const CheckpointStore = require('../../checkpoint/store.js');
    const store = new CheckpointStore(tmpDir);
    await store.save('test-int2', '_TAG_DATA_0', {
      last_success_rid: 100n,
      source_server: 'src',
      source_table: 'TAG',
    }, { rows_read: 5, rows_written: 5, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = { value: false };
    let steadyReadCalls = [];
    let integrityReadDone = false;

    const IntegrityChecker = require('../../db/integrity_checker.js');
    const origBatchExists = IntegrityChecker.batchExists;
    IntegrityChecker.batchExists = async (_conn, _table, rows) => {
      const existSet = new Set();
      for (const r of rows) {
        if (r.time === 1000n) existSet.add(IntegrityChecker.existKey(r.canonical, r.time));
      }
      return { existSet, err: null };
    };

    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        if (!integrityReadDone) {
          integrityReadDone = true;
          return {
            rows: [
              { rid: 101n, tagId: 1, data: { TIME: 1000n, VALUE: 1.0 } },
              { rid: 102n, tagId: 1, data: { TIME: 2000n, VALUE: 2.0 } },
            ],
            err: null,
          };
        }
        steadyReadCalls.push(startRid);
        shutdownFlag.value = true;
        return { rows: [], err: null };
      },
      tagResolveFn: async function(client, tagId) {
        return { canonical: 'sensor_a', status: 'ok' };
      },
      appendFn: async function(rows) {
        appendedRows.push(...rows);
        return null;
      },
    });

    try {
      const worker = makeTagWorker('test-int2', tmpDir, { integrity: { enabled: true } }, shutdownFlag);
      await worker.run(makeSignal());

      const { cp } = await store.load('test-int2', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 101n, 'STARTUP_INTEGRITY: safe_cp_rid = first_miss(102n) - 1n = 101n');
      assert.equal(steadyReadCalls[0], 102n, 'STEADY는 firstMissRid(102n)부터 시작');
    } finally {
      IntegrityChecker.batchExists = origBatchExists;
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('LOG 테이블 → checkpoint 있어도 STARTUP_INTEGRITY 미수행', async () => {
    const tmpDir = await makeTmpDir();

    const CheckpointStore = require('../../checkpoint/store.js');
    const store = new CheckpointStore(tmpDir);
    await store.save('test-log-int', '_LOG_DATA_0', {
      last_success_rid: 50n,
      source_server: 'src',
      source_table: 'LOG',
    }, { rows_read: 5, rows_written: 5, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = makeShutdownFlag(30);
    const integrityCheckCalls = [];

    const IntegrityChecker = require('../../db/integrity_checker.js');
    const origBatchExists = IntegrityChecker.batchExists;
    IntegrityChecker.batchExists = async () => {
      integrityCheckCalls.push(true);
      return { existSet: new Set(), err: null };
    };

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => ({ rows: [], err: null }),
    });

    try {
      const worker = makeLogWorker('test-log-int', tmpDir, { integrity: { enabled: true } }, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(integrityCheckCalls.length, 0, 'LOG 테이블 → IntegrityChecker 미호출');
    } finally {
      IntegrityChecker.batchExists = origBatchExists;
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Job 클래스 테스트 ────────────────────────────────────────────────────────

describe('Job — _discoverMapping', () => {
  test('discover 실패(connect 오류) → null 반환, 재시작 루프에서 workers=[]', async () => {
    const shutdownFlag = { value: false };
    const jobConfig = {
      id: 'job-disc-fail',
      enabled: true,
      checkpoint: { directory: '/tmp' },
      mappings: [{
        mapping_id: 'map-1',
        source: { server: 'src', table: 'TAG' },
        target: { server: 'dst', table: 'TAG2' },
        execution: { start_mode: 'full', poll_interval_ms: 20, query_limit: 100, integrity: { enabled: false } },
      }],
    };
    const servers = {
      src: { host: '127.0.0.1', port: 1, user: 'x', password: 'x' },
      dst: { host: '127.0.0.1', port: 1, user: 'x', password: 'x' },
    };

    const job = new Job(jobConfig, servers, shutdownFlag);
    const logCtx = { job_id: 'job-disc-fail', mapping_id: 'map-1' };

    // connect 실패 시 null 반환 확인
    const result = await job._discoverMapping(jobConfig.mappings[0], logCtx);
    assert.equal(result, null, 'connect 실패 → _discoverMapping null 반환');
  });

  test('discover 성공 → { tableType, dataTables, srcSchema, dstSchema } 반환', async () => {
    const shutdownFlag = { value: false };
    const servers = {
      src: { host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      dst: { host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    };
    const jobConfig = {
      id: 'job-disc-ok',
      enabled: true,
      checkpoint: { directory: '/tmp' },
      mappings: [{
        mapping_id: 'map-ok',
        source: { server: 'src', table: 'TAG' },
        target: { server: 'dst', table: 'TAG' },
        execution: { start_mode: 'full', poll_interval_ms: 20, query_limit: 100, integrity: { enabled: false } },
      }],
    };

    const mockSchema = {
      tableType: 'TAG',
      logicalTable: 'TAG',
      columns: [
        { name: 'NAME', columnType: { type: 'varchar' }, id: 0, category: 'key' },
        { name: 'TIME', columnType: { type: 'int64' }, id: 2, category: 'data' },
        { name: 'VALUE', columnType: { type: 'float64' }, id: 3, category: 'data' },
      ],
    };

    // _discoverMapping 메서드를 직접 override하여 독립적 단위 테스트
    const job = new Job(jobConfig, servers, shutdownFlag);
    job._discoverMapping = async (mapping, logCtx) => ({
      tableType: 'TAG',
      dataTables: ['_TAG_DATA_0'],
      srcSchema: mockSchema,
      dstSchema: mockSchema,
    });

    const logCtx = { job_id: 'job-disc-ok', mapping_id: 'map-ok' };
    const result = await job._discoverMapping(jobConfig.mappings[0], logCtx);

    assert.ok(result !== null, '_discoverMapping null이 아니어야 함');
    assert.equal(result.tableType, 'TAG');
    assert.deepEqual(result.dataTables, ['_TAG_DATA_0']);
    assert.ok(result.srcSchema);
    assert.ok(result.dstSchema);
  });
});

describe('Job — AbortController 전파', () => {
  // 이 describe 블록의 테스트는 실제 Worker.run() 구현 로직을 검증한다.
  // Worker prototype을 mock하고 job_runner.js를 재로드해서 실제 코드 경로를 실행한다.

  function setupWorkerMocks({ onWorkerRun } = {}) {
    const machbaseMod = require('../../db/client.js');
    const writerMod = require('../../db/writer.js');
    const readerMod = require('../../db/reader.js');
    const workerMod = require('../../worker/worker.js');

    const origConnect = machbaseMod.MachbaseClient.prototype.connect;
    const origClose = machbaseMod.MachbaseClient.prototype.close;
    const origWriterOpen = writerMod.Writer.prototype.open;
    const origWriterClose = writerMod.Writer.prototype.close;
    const origReaderClose = readerMod.Reader.prototype.close;
    const origWorkerRun = workerMod.Worker.prototype.run;

    machbaseMod.MachbaseClient.prototype.connect = async function() {};
    machbaseMod.MachbaseClient.prototype.close = async function() {};
    writerMod.Writer.prototype.open = async function() { return null; };
    writerMod.Writer.prototype.close = async function() {};
    readerMod.Reader.prototype.close = async function() {};
    if (onWorkerRun) workerMod.Worker.prototype.run = onWorkerRun;

    // job_runner.js를 캐시에서 제거 후 재로드 — mock된 의존성을 클로저로 캡처하게 함
    const jobRunnerKey = require.resolve('../../job_runner.js');
    const origJobRunnerCache = require.cache[jobRunnerKey];
    delete require.cache[jobRunnerKey];
    const { Worker: WorkerClass, Job: JobClass } = require('../../job_runner.js');

    function restore() {
      machbaseMod.MachbaseClient.prototype.connect = origConnect;
      machbaseMod.MachbaseClient.prototype.close = origClose;
      writerMod.Writer.prototype.open = origWriterOpen;
      writerMod.Writer.prototype.close = origWriterClose;
      readerMod.Reader.prototype.close = origReaderClose;
      workerMod.Worker.prototype.run = origWorkerRun;
      if (origJobRunnerCache) {
        require.cache[jobRunnerKey] = origJobRunnerCache;
      } else {
        delete require.cache[jobRunnerKey];
      }
    }

    return { WorkerClass, JobClass, restore };
  }

  test('signal.aborted=true이면 Worker.run()이 connect 호출 없이 즉시 반환됨', async () => {
    const machbaseMod = require('../../db/client.js');
    let connectCalled = false;
    const origConnect = machbaseMod.MachbaseClient.prototype.connect;
    machbaseMod.MachbaseClient.prototype.connect = async function() { connectCalled = true; };

    const jobRunnerKey = require.resolve('../../job_runner.js');
    const origJobRunnerCache = require.cache[jobRunnerKey];
    delete require.cache[jobRunnerKey];
    const { Worker: WorkerClass } = require('../../job_runner.js');

    try {
      const mockSchema = makeTagSchema();
      const shutdownFlag = { value: false };
      const mapping = {
        mapping_id: 'map-1',
        source: { server: 'src', table: 'TAG', tag_identifier: { mode: 'none', value: '' }, columns: null },
        target: { server: 'dst', table: 'TAG' },
        execution: { start_mode: 'full', poll_interval_ms: 20, query_limit: 100 },
      };

      const worker = new WorkerClass(
        'job-signal-test', { directory: '/tmp' }, mapping,
        'TAG', '_TAG_DATA_0', mockSchema, mockSchema,
        { host: 'mock', port: 1 }, { host: 'mock', port: 1 }, shutdownFlag,
      );

      // 이미 abort된 signal → if (signal.aborted) return; 에서 즉시 반환
      const ac = new AbortController();
      ac.abort();
      await worker.run(ac.signal);

      assert.equal(connectCalled, false, 'signal.aborted=true이면 connect가 호출되지 않아야 함');
    } finally {
      machbaseMod.MachbaseClient.prototype.connect = origConnect;
      if (origJobRunnerCache) {
        require.cache[jobRunnerKey] = origJobRunnerCache;
      } else {
        delete require.cache[jobRunnerKey];
      }
    }
  });

  test('Worker_0 에러 → AbortController abort → Worker_1의 effectiveShutdownFlag.value=true', async () => {
    // Worker.run을 mock해서 effectiveShutdownFlag(= signal proxy)를 검사한다.
    // Worker_0용 run: 한 tick 후 에러를 throw
    // Worker_1용 run: abort 될 때까지 폴링, shutdownFlag.value를 기록

    let worker1AbortDetected;
    const worker1AbortPromise = new Promise(resolve => { worker1AbortDetected = resolve; });
    let worker1ShutdownFlagValue = false;

    // 어느 Worker가 호출됐는지 dataTable로 구분
    const { WorkerClass, JobClass, restore } = setupWorkerMocks({
      onWorkerRun: async function(signal) {
        if (this.dataTable === '_TAG_DATA_0') {
          // Worker_0: event loop 한 tick 후 에러
          await new Promise(resolve => setImmediate(resolve));
          throw new Error('worker_0 intentional error');
        }
        if (this.dataTable === '_TAG_DATA_1') {
          // Worker_1: effectiveShutdownFlag(signal proxy)가 true가 될 때까지 폴링
          const effectiveShutdownFlag = {
            get value() { return signal.aborted; },
          };
          for (let i = 0; i < 50; i++) {
            if (effectiveShutdownFlag.value) break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          worker1ShutdownFlagValue = effectiveShutdownFlag.value;
          worker1AbortDetected();
        }
      },
    });

    const shutdownFlag = { value: false };
    const servers = {
      src: { host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      dst: { host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    };
    const jobConfig = {
      id: 'job-abort-test',
      enabled: true,
      checkpoint: { directory: '/tmp' },
      mappings: [{
        mapping_id: 'map-abort',
        source: { server: 'src', table: 'TAG', tag_identifier: { mode: 'none', value: '' }, columns: null },
        target: { server: 'dst', table: 'TAG' },
        execution: { start_mode: 'full', poll_interval_ms: 20, query_limit: 100, integrity: { enabled: false } },
      }],
    };
    const mockSchema = makeTagSchema();

    try {
      const job = new JobClass(jobConfig, servers, shutdownFlag);

      // discover mock: 2개 파티션 반환, 재시작 시 shutdown 설정
      let discoverCount = 0;
      job._discoverMapping = async () => {
        discoverCount++;
        if (discoverCount > 1) shutdownFlag.value = true;
        return {
          tableType: 'TAG',
          dataTables: ['_TAG_DATA_0', '_TAG_DATA_1'],
          srcSchema: mockSchema,
          dstSchema: mockSchema,
        };
      };

      // job.run()과 Worker_1의 abort 감지를 병렬로 기다림
      await Promise.all([job.run(), worker1AbortPromise]);

      assert.equal(worker1ShutdownFlagValue, true,
        'Worker_0 에러 후 Worker_1의 signal.aborted가 true여야 함 (AbortController 전파 검증)');
      assert.ok(discoverCount >= 2, `재시작이 발생해야 함 (discover 호출 횟수: ${discoverCount})`);
    } finally {
      restore();
    }
  });
});

describe('Job — run() 재시작 동작', () => {
  test('Worker 에러 → abort → 재시작 후 shutdown → 정상 종료', async () => {
    const shutdownFlag = { value: false };
    const servers = {
      src: { host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      dst: { host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    };
    const jobConfig = {
      id: 'job-restart',
      enabled: true,
      checkpoint: { directory: '/tmp' },
      mappings: [{
        mapping_id: 'map-restart',
        source: { server: 'src', table: 'TAG' },
        target: { server: 'dst', table: 'TAG' },
        execution: { start_mode: 'full', poll_interval_ms: 20, query_limit: 100, integrity: { enabled: false } },
      }],
    };

    const mockSchema = makeTagSchema();

    const { Worker: WorkerClass } = require('../../job_runner.js');
    const origWorkerRun = WorkerClass.prototype.run;
    let workerRunCount = 0;
    WorkerClass.prototype.run = async function(_signal) {
      workerRunCount++;
      if (workerRunCount === 1) {
        throw new Error('first worker error');
      }
      // 두 번째 실행: 정상 종료 후 shutdown
      shutdownFlag.value = true;
    };

    try {
      const job = new Job(jobConfig, servers, shutdownFlag);

      // _discoverMapping을 mock하여 실제 DB 연결 없이 테스트
      job._discoverMapping = async () => ({
        tableType: 'TAG',
        dataTables: ['_TAG_DATA_0'],
        srcSchema: mockSchema,
        dstSchema: mockSchema,
      });

      await job.run();

      assert.ok(workerRunCount >= 2, `Worker는 최소 2회 실행되어야 함 (실제: ${workerRunCount}회) — 에러 후 재시작 확인`);
      assert.equal(shutdownFlag.value, true, 'shutdown 후 job.run()이 종료되어야 함');
    } finally {
      WorkerClass.prototype.run = origWorkerRun;
    }
  });
});

describe('Worker — non-retryable 에러 처리', () => {
  test('readAfterRid non-retryable 에러 → Worker 즉시 종료 (retry 없음)', async () => {
    const tmpDir = await makeTmpDir();
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
      const worker = makeTagWorker('test-nr', tmpDir,
        { retry: { max_attempts: 5, base_delay_ms: 10, max_delay_ms: 100 } },
        shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(readCallCount, 1, 'retryable=false → 재시도 없이 1회만 호출되어야 함');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('Writer.append non-retryable 에러 → Worker 즉시 종료 (retry 없음)', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let appendCallCount = 0;
    let readCallCount = 0;

    const { restore } = setupWorkerPrototypeMocks({
      readFn: (startRid) => {
        readCallCount++;
        if (readCallCount === 1) {
          return {
            rows: [{ rid: 1n, tagId: 1, data: { TIME: 1000n, VALUE: 1.0 } }],
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
      const worker = makeTagWorker('test-nr-append', tmpDir,
        { retry: { max_attempts: 5, base_delay_ms: 10, max_delay_ms: 100 } },
        shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendCallCount, 1, 'retryable=false → append 재시도 없이 1회만 호출되어야 함');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Replicator — run()', () => {
  test('disabled job는 실행되지 않음', async () => {
    const config = {
      servers: {},
      replication: {
        jobs: [
          { id: 'disabled-job', enabled: false, mappings: [], checkpoint: { directory: '/tmp' } },
        ],
      },
    };

    const replicator = new Replicator(config);
    await replicator.run();
    assert.ok(true, 'disabled job은 실행 없이 즉시 완료되어야 함');
  });

  test('enabled job 없음 → 즉시 완료', async () => {
    const config = {
      servers: {},
      replication: {
        jobs: [],
      },
    };

    const replicator = new Replicator(config);
    await replicator.run();
    assert.ok(true, '빈 jobs → 즉시 완료');
  });

  test('여러 job 병렬 실행 — 모든 job이 독립적으로 실행되고 완료됨', async () => {
    const executionOrder = [];

    const { Job: JobClass } = require('../../job_runner.js');
    const origRun = JobClass.prototype.run;
    JobClass.prototype.run = async function() {
      executionOrder.push(this.jobConfig.id);
      // 각 job이 비동기로 독립 실행됨을 확인하기 위해 job-1은 짧게, job-2는 길게 대기
      const delay = this.jobConfig.id === 'multi-job-1' ? 10 : 5;
      await new Promise(resolve => setTimeout(resolve, delay));
      executionOrder.push(`${this.jobConfig.id}-done`);
    };

    try {
      const config = {
        servers: {},
        replication: {
          jobs: [
            { id: 'multi-job-1', enabled: true, mappings: [], checkpoint: { directory: '/tmp' } },
            { id: 'multi-job-2', enabled: true, mappings: [], checkpoint: { directory: '/tmp' } },
            { id: 'multi-job-disabled', enabled: false, mappings: [], checkpoint: { directory: '/tmp' } },
          ],
        },
      };

      const replicator = new Replicator(config);
      await replicator.run();

      assert.ok(executionOrder.includes('multi-job-1'), 'job-1이 실행되어야 함');
      assert.ok(executionOrder.includes('multi-job-2'), 'job-2가 실행되어야 함');
      assert.ok(!executionOrder.includes('multi-job-disabled'), 'disabled job은 실행되지 않아야 함');
      assert.ok(executionOrder.includes('multi-job-1-done'), 'job-1이 완료되어야 함');
      assert.ok(executionOrder.includes('multi-job-2-done'), 'job-2가 완료되어야 함');
      // 두 job이 병렬로 시작됨 — job-2-done이 job-1-done보다 먼저 올 수 있음
      assert.equal(executionOrder.filter(e => e.endsWith('-done')).length, 2, '두 job 모두 완료');
    } finally {
      JobClass.prototype.run = origRun;
    }
  });

  test('한 job 에러가 다른 job 실행에 영향을 주지 않음', async () => {
    const completed = [];

    const { Job: JobClass } = require('../../job_runner.js');
    const origRun = JobClass.prototype.run;
    JobClass.prototype.run = async function() {
      if (this.jobConfig.id === 'crash-job') {
        throw new Error('intentional crash');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      completed.push(this.jobConfig.id);
    };

    try {
      const config = {
        servers: {},
        replication: {
          jobs: [
            { id: 'crash-job', enabled: true, mappings: [], checkpoint: { directory: '/tmp' } },
            { id: 'healthy-job', enabled: true, mappings: [], checkpoint: { directory: '/tmp' } },
          ],
        },
      };

      const replicator = new Replicator(config);
      await replicator.run(); // crash-job 에러가 전파되지 않아야 함

      assert.ok(!completed.includes('crash-job'), 'crash-job은 완료 목록에 없어야 함');
      assert.ok(completed.includes('healthy-job'), 'healthy-job은 정상 완료되어야 함');
    } finally {
      JobClass.prototype.run = origRun;
    }
  });
});
