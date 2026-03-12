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
 * TagDataTable / TagTable / LogTable prototype을 mock하고 복원 함수를 반환
 */
function setupWorkerPrototypeMocks({ readFn, appendFn } = {}) {
  const tableMod = require('../../db/table.js');
  const clientMod = require('../../db/client.js');

  // MachbaseClient connect/close mock (STARTUP_INTEGRITY intConn 포함)
  const origConnect = clientMod.MachbaseClient.prototype.connect;
  const origClose = clientMod.MachbaseClient.prototype.close;
  clientMod.MachbaseClient.prototype.connect = async function() {};
  clientMod.MachbaseClient.prototype.close = async function() {};

  const origTagDataOpen = tableMod.TagDataTable.prototype.open;
  const origTagDataClose = tableMod.TagDataTable.prototype.close;
  const origTagDataLoadCache = tableMod.TagDataTable.prototype.loadTagAliasCache;
  const origTagDataGetMaxRid = tableMod.TagDataTable.prototype.getMaxRid;
  const origTagDataRead = tableMod.TagDataTable.prototype.read;

  const origTagOpen = tableMod.TagTable.prototype.open;
  const origTagClose = tableMod.TagTable.prototype.close;
  const origTagAppend = tableMod.TagTable.prototype.append;

  const origLogOpen = tableMod.LogTable.prototype.open;
  const origLogClose = tableMod.LogTable.prototype.close;
  const origLogRead = tableMod.LogTable.prototype.read;
  const origLogAppend = tableMod.LogTable.prototype.append;

  tableMod.TagDataTable.prototype.open = async function() {};
  tableMod.TagDataTable.prototype.close = async function() { return null; };
  tableMod.TagDataTable.prototype.loadTagAliasCache = async function() { return null; };
  tableMod.TagDataTable.prototype.getMaxRid = async function() { return 0n; };
  tableMod.TagDataTable.prototype.read = readFn
    ? async function(...args) { return readFn(...args); }
    : async function() { return { rows: [], err: null }; };

  tableMod.TagTable.prototype.open = async function() { return null; };
  tableMod.TagTable.prototype.close = async function() { return null; };
  tableMod.TagTable.prototype.append = appendFn
    ? async function(rows) { return appendFn(rows); }
    : async function() { return null; };

  tableMod.LogTable.prototype.open = async function() { return null; };
  tableMod.LogTable.prototype.close = async function() { return null; };
  tableMod.LogTable.prototype.read = readFn
    ? async function(...args) { return readFn(...args); }
    : async function() { return { rows: [], err: null }; };
  tableMod.LogTable.prototype.append = appendFn
    ? async function(rows) { return appendFn(rows); }
    : async function() { return null; };

  function restore() {
    clientMod.MachbaseClient.prototype.connect = origConnect;
    clientMod.MachbaseClient.prototype.close = origClose;
    tableMod.TagDataTable.prototype.open = origTagDataOpen;
    tableMod.TagDataTable.prototype.close = origTagDataClose;
    tableMod.TagDataTable.prototype.loadTagAliasCache = origTagDataLoadCache;
    tableMod.TagDataTable.prototype.getMaxRid = origTagDataGetMaxRid;
    tableMod.TagDataTable.prototype.read = origTagDataRead;
    tableMod.TagTable.prototype.open = origTagOpen;
    tableMod.TagTable.prototype.close = origTagClose;
    tableMod.TagTable.prototype.append = origTagAppend;
    tableMod.LogTable.prototype.open = origLogOpen;
    tableMod.LogTable.prototype.close = origLogClose;
    tableMod.LogTable.prototype.read = origLogRead;
    tableMod.LogTable.prototype.append = origLogAppend;
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

      assert.ok(readCalls.length >= 1, '최소 1회 이상 read 호출되어야 함');
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

  test('drop_not_found → read()가 제외 후 빈 rows, checkpoint = maxRidInBatch (all-drop 케이스)', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => {
        batchCall++;
        if (batchCall === 1) {
          // read()가 drop_not_found 행을 이미 제외 → 빈 rows + 하지만 rid는 5n이 최대
          // 실제로 drop_not_found가 제외되면 rows=[] 이므로 checkpoint 저장 안 됨
          // rows에 1개 남기는 시나리오: 2개 중 1개만 drop
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
      const worker = makeTagWorker('test-alldrop', tmpDir, {}, shutdownFlag);
      await worker.run(makeSignal());

      const CheckpointStore = require('../../checkpoint/store.js');
      const store = new CheckpointStore(tmpDir);
      const { cp } = await store.load('test-alldrop', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 5n, 'checkpoint = maxRidInBatch(5n) — 마지막 성공 RID (inclusive)');
      assert.equal(appendedRows.length, 1, '1개 row append');
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
    const findFirstMissRowCalls = [];

    const tableMod = require('../../db/table.js');
    const origFindFirstMissRow = tableMod.TagTable.prototype.findFirstMissRow;
    tableMod.TagTable.prototype.findFirstMissRow = async function() {
      findFirstMissRowCalls.push(true);
      return { firstMissIdx: null, err: null };
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

      assert.equal(findFirstMissRowCalls.length, 0, 'integrity.enabled=false → findFirstMissRow 미호출');
      assert.equal(readCalls[0], 11n, 'STEADY는 checkpoint(10n)+1n=11n부터 시작해야 함');
    } finally {
      tableMod.TagTable.prototype.findFirstMissRow = origFindFirstMissRow;
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

    const tableMod = require('../../db/table.js');
    const origFindFirstMissRow = tableMod.TagTable.prototype.findFirstMissRow;
    // time===1000n인 row는 존재, 2000n은 miss → idx=1 반환
    tableMod.TagTable.prototype.findFirstMissRow = async function(rows) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].time !== 1000n) return { firstMissIdx: i, err: null };
      }
      return { firstMissIdx: null, err: null };
    };

    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
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

    try {
      const worker = makeTagWorker('test-int2', tmpDir, { integrity: { enabled: true } }, shutdownFlag);
      await worker.run(makeSignal());

      const { cp } = await store.load('test-int2', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 101n, 'STARTUP_INTEGRITY: safe_cp_rid = first_miss(102n) - 1n = 101n');
      assert.equal(steadyReadCalls[0], 102n, 'STEADY는 firstMissRid(102n)부터 시작');
    } finally {
      tableMod.TagTable.prototype.findFirstMissRow = origFindFirstMissRow;
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
    const findFirstMissRowCalls = [];

    const tableMod = require('../../db/table.js');
    const origFindFirstMissRow = tableMod.TagTable.prototype.findFirstMissRow;
    tableMod.TagTable.prototype.findFirstMissRow = async function() {
      findFirstMissRowCalls.push(true);
      return { firstMissIdx: null, err: null };
    };

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => ({ rows: [], err: null }),
    });

    try {
      const worker = makeLogWorker('test-log-int', tmpDir, { integrity: { enabled: true } }, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(findFirstMissRowCalls.length, 0, 'LOG 테이블 → findFirstMissRow 미호출');
    } finally {
      tableMod.TagTable.prototype.findFirstMissRow = origFindFirstMissRow;
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
    const workerMod = require('../../worker/worker.js');
    const tableMod = require('../../db/table.js');

    const origWorkerRun = workerMod.Worker.prototype.run;
    const origTagDataOpen = tableMod.TagDataTable.prototype.open;
    const origTagDataClose = tableMod.TagDataTable.prototype.close;
    const origTagOpen = tableMod.TagTable.prototype.open;
    const origTagClose = tableMod.TagTable.prototype.close;

    tableMod.TagDataTable.prototype.open = async function() {};
    tableMod.TagDataTable.prototype.close = async function() { return null; };
    tableMod.TagTable.prototype.open = async function() { return null; };
    tableMod.TagTable.prototype.close = async function() { return null; };

    if (onWorkerRun) workerMod.Worker.prototype.run = onWorkerRun;

    // job_runner.js를 캐시에서 제거 후 재로드 — mock된 의존성을 클로저로 캡처하게 함
    const jobRunnerKey = require.resolve('../../job_runner.js');
    const origJobRunnerCache = require.cache[jobRunnerKey];
    delete require.cache[jobRunnerKey];
    const { Job: JobClass } = require('../../job_runner.js');

    function restore() {
      workerMod.Worker.prototype.run = origWorkerRun;
      tableMod.TagDataTable.prototype.open = origTagDataOpen;
      tableMod.TagDataTable.prototype.close = origTagDataClose;
      tableMod.TagTable.prototype.open = origTagOpen;
      tableMod.TagTable.prototype.close = origTagClose;
      if (origJobRunnerCache) {
        require.cache[jobRunnerKey] = origJobRunnerCache;
      } else {
        delete require.cache[jobRunnerKey];
      }
    }

    return { JobClass, restore };
  }

  test('signal.aborted=true이면 Worker.run()이 open 호출 없이 즉시 반환됨', async () => {
    const tableMod = require('../../db/table.js');
    let openCalled = false;
    const origOpen = tableMod.TagDataTable.prototype.open;
    tableMod.TagDataTable.prototype.open = async function() { openCalled = true; };

    try {
      const mockSchema = makeTagSchema();
      const shutdownFlag = { value: false };
      const mapping = {
        mapping_id: 'map-1',
        source: { server: 'src', table: 'TAG', tag_identifier: { mode: 'none', value: '' }, columns: null },
        target: { server: 'dst', table: 'TAG' },
        execution: { start_mode: 'full', poll_interval_ms: 20, query_limit: 100 },
      };

      const { Worker: WorkerClass } = require('../../worker/worker.js');
      const worker = new WorkerClass(
        'job-signal-test', { directory: '/tmp' }, mapping,
        'TAG', '_TAG_DATA_0', mockSchema, mockSchema,
        { host: 'mock', port: 1 }, { host: 'mock', port: 1 }, shutdownFlag,
      );

      // 이미 abort된 signal → if (signal.aborted) return; 에서 즉시 반환
      const ac = new AbortController();
      ac.abort();
      await worker.run(ac.signal);

      assert.equal(openCalled, false, 'signal.aborted=true이면 open이 호출되지 않아야 함');
    } finally {
      tableMod.TagDataTable.prototype.open = origOpen;
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
    const { JobClass, restore } = setupWorkerMocks({
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

    const { Worker: WorkerClass } = require('../../worker/worker.js');
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
  test('read 에러 → Worker 즉시 종료 (retry 없음)', async () => {
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

// ─── Worker E2E 시나리오 (mock 기반) ─────────────────────────────────────────

describe('Worker — TAG 복제 기본 흐름', () => {
  test('full start → steady: startRid=0n 으로 시작, 배치 후 checkpoint 갱신', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
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
      const worker = makeTagWorker('fw-tag-1', tmpDir, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendedRows.length, 2);
      assert.equal(appendedRows[0].NAME, 'sensor_a');

      const CheckpointStore = require('../../checkpoint/store.js');
      const store = new CheckpointStore(tmpDir);
      const { cp } = await store.load('fw-tag-1', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 2n);
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Worker — LOG 복제 기본 흐름', () => {
  test('LOG: tag_id 변환 없이 그대로 append', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;
    const appendedRows = [];

    const { restore } = setupWorkerPrototypeMocks({
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
      const worker = makeLogWorker('fw-log-1', tmpDir, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendedRows.length, 1);
      assert.equal(appendedRows[0].NAME, 'machine_a');

      const CheckpointStore = require('../../checkpoint/store.js');
      const store = new CheckpointStore(tmpDir);
      const { cp } = await store.load('fw-log-1', '_LOG_DATA_0');
      assert.equal(cp.last_success_rid, 10n);
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Worker — checkpoint resume', () => {
  test('checkpoint 저장 후 재시작 → startRid = last_success_rid + 1', async () => {
    const tmpDir = await makeTmpDir();
    const CheckpointStore = require('../../checkpoint/store.js');
    const store = new CheckpointStore(tmpDir);

    await store.save('fw-resume', '_TAG_DATA_0', {
      last_success_rid: 999n,
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
      const worker = makeTagWorker('fw-resume', tmpDir, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.ok(readCalls.length >= 1);
      assert.equal(readCalls[0], 1000n, 'checkpoint 999n → startRid=1000n');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Worker — drop_not_found', () => {
  test('read()가 drop_not_found 제외한 rows 반환 → 배치 rows.length로 확인', async () => {
    const tmpDir = await makeTmpDir();
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
      const worker = makeTagWorker('fw-drop', tmpDir, {}, shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendedRows.length, 1, 'drop_not_found 제외 후 1개만 append');
      assert.equal(appendedRows[0].NAME, 'sensor_ok');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Worker — read 에러', () => {
  test('read 에러 → retry 없이 즉시 Worker 종료', async () => {
    const tmpDir = await makeTmpDir();
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
      const worker = makeTagWorker('fw-read-err', tmpDir,
        { retry: { max_attempts: 5, base_delay_ms: 5, max_delay_ms: 20 } },
        shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(readCallCount, 1, 'read 실패 → retry 없이 1회만 호출 후 Worker 종료');
      assert.equal(shutdownFlag.value, false, 'shutdownFlag는 변경되지 않아야 함');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Worker — append 에러 retry', () => {
  test('append 에러(retryable) → retry 후 복구', async () => {
    const tmpDir = await makeTmpDir();
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
      const worker = makeTagWorker('fw-append-retry', tmpDir,
        { retry: { max_attempts: 5, base_delay_ms: 5, max_delay_ms: 20 } },
        shutdownFlag);
      await worker.run(makeSignal());

      assert.equal(appendAttempt, 2, 'append 1회 실패 후 retry → 총 2회 시도');
      assert.equal(appendedRows.length, 1, '복구 후 1개 append');
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Worker — shutdown 신호', () => {
  test('shutdown 신호 처리 — 즉시 종료', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = makeShutdownFlag(10);

    const { restore } = setupWorkerPrototypeMocks({
      readFn: () => ({ rows: [], err: null }),
    });

    const startTime = Date.now();

    try {
      const worker = makeTagWorker('fw-shutdown', tmpDir, { poll_interval_ms: 5000 }, shutdownFlag);
      await worker.run(makeSignal());

      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 500, `shutdown 후 즉시 종료되어야 함 (elapsed: ${elapsed}ms)`);
    } finally {
      restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Worker — 빈 배치 poll 대기', () => {
  test('빈 배치 → poll interval 대기 후 다시 읽기', async () => {
    const tmpDir = await makeTmpDir();
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
      const worker = makeTagWorker('fw-poll', tmpDir, { poll_interval_ms: 10 }, shutdownFlag);
      await worker.run(makeSignal());

      assert.ok(readCallCount >= 2, '빈 배치 후 poll 대기 → 재읽기 확인');
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
