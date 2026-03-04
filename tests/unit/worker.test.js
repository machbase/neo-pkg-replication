'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

const { runDataTableWorker } = require('../../worker/worker.js');

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

/** TAG Reader mock 생성 */
function makeTagSourceReader(metaMap = new Map([[1, 'tag_a'], [2, 'tag_b']]), readFn = null) {
  return {
    schema: {
      tableType: 'TAG',
      logicalTable: 'TAG',
      columns: [
        { name: 'NAME', columnType: { type: 'varchar' }, id: 0, category: 'key' },
        { name: 'TIME', columnType: { type: 'int64' }, id: 2, category: 'data' },
        { name: 'VALUE', columnType: { type: 'float64' }, id: 3, category: 'data' },
      ],
    },
    aliasCache: { _map: metaMap, get size() { return metaMap.size; } },
    dataTable: '_TAG_DATA_0',
    get aliasSize() { return metaMap.size; },
    async loadAliases() { return null; },
    async resolveTagCanonical(tagId, tagIdentifier) {
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

/** LOG Reader mock 생성 */
function makeLogSourceReader(readFn = null) {
  return {
    schema: {
      tableType: 'LOG',
      logicalTable: 'LOG',
      columns: [
        { name: 'NAME', columnType: { type: 'varchar' }, id: 0, category: 'data' },
        { name: 'TIME', columnType: { type: 'int64' }, id: 1, category: 'data' },
        { name: 'VALUE', columnType: { type: 'float64' }, id: 2, category: 'data' },
      ],
    },
    aliasCache: null,
    dataTable: '_LOG_DATA_0',
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

// ─── 테스트 헬퍼: Worker를 mock으로 실행 ─────────────────────────────────────

describe('runDataTableWorker — RESOLVE_START', () => {
  test('체크포인트 없음 + start_mode=full → startRid=0n 으로 시작 후 빈 배치 대기 후 shutdown', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = makeShutdownFlag(50);

    const readCalls = [];
    const appendedRows = [];

    const reader = makeTagSourceReader(new Map([[1, 'tag_a'], [2, 'tag_b']]), (startRid, limit) => {
      readCalls.push({ startRid, limit });
      return { rows: [], err: null };
    });

    const Writer = require('../../machbase/writer.js');
    const origOpen = Writer.prototype.open;
    Writer.prototype.open = async function() {
      this.appendColumns = [];
      this.stream = { append: async (m) => appendedRows.push(...m), close: async () => {} };
      return null;
    };

    try {
      await runDataTableWorker({
        jobId: 'test-job',
        mapping: {
          source: { server: 'src', table: 'TAG' },
          target: { server: 'dst', table: 'TAG2' },
          execution: {
            query_limit: 100,
            poll_interval_ms: 20,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        writer: new Writer(),
        shutdownFlag,
      });

      assert.ok(readCalls.length >= 1, '최소 1회 이상 readAfterRid 호출되어야 함');
      assert.equal(readCalls[0].startRid, 0n, 'start_mode=full → startRid=0n');
      assert.equal(appendedRows.length, 0, '빈 배치 → append 없음');
    } finally {
      Writer.prototype.open = origOpen;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('체크포인트 있음 → last_success_rid에서 재개', async () => {
    const tmpDir = await makeTmpDir();
    const CheckpointStore = require('../../file/checkpoint.js');
    const store = new CheckpointStore(tmpDir);

    await store.save('test-job', '_TAG_DATA_0', {
      last_success_rid: 1234n,
      source_server: 'src',
      source_table: 'TAG',
    }, { rows_read: 10, rows_written: 10, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = makeShutdownFlag(30);
    const readCalls = [];

    const reader = makeTagSourceReader(new Map([[1, 'tag_a'], [2, 'tag_b']]), (startRid) => {
      readCalls.push(startRid);
      return { rows: [], err: null };
    });

    const Writer = require('../../machbase/writer.js');
    const origOpen = Writer.prototype.open;
    Writer.prototype.open = async function() {
      this.appendColumns = [];
      this.stream = { append: async () => {}, close: async () => {} };
      return null;
    };

    try {
      await runDataTableWorker({
        jobId: 'test-job',
        mapping: {
          source: { server: 'src', table: 'TAG' },
          target: { server: 'dst', table: 'TAG2' },
          execution: {
            query_limit: 100,
            poll_interval_ms: 20,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        writer: new Writer(),
        shutdownFlag,
      });

      assert.ok(readCalls.length >= 1);
      assert.equal(readCalls[0], 1235n, '체크포인트 last_success_rid=1234n → startRid=1235n (1234n+1n)');
    } finally {
      Writer.prototype.open = origOpen;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

});

describe('runDataTableWorker — STEADY_REPLICATION', () => {
  test('TAG 배치 처리 → checkpoint가 maxRid+1로 갱신됨', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;

    const reader = makeTagSourceReader(new Map([[1, 'tag_a'], [2, 'tag_b']]), (startRid) => {
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
    });

    const appendedRows = [];
    const Writer = require('../../machbase/writer.js');
    const origOpen = Writer.prototype.open;
    const origAppend = Writer.prototype.append;
    Writer.prototype.open = async function() {
      this.appendColumns = [];
      this.stream = {
        append: async (matrix) => { appendedRows.push(...matrix); },
        close: async () => {},
      };
      return null;
    };
    Writer.prototype.append = async function(rows) {
      appendedRows.push(...rows);
      return null;
    };

    try {
      await runDataTableWorker({
        jobId: 'test-job-2',
        mapping: {
          source: { server: 'src', table: 'TAG' },
          target: { server: 'dst', table: 'TAG2' },
          execution: {
            query_limit: 100,
            poll_interval_ms: 1000,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        writer: new Writer(),
        shutdownFlag,
      });

      const CheckpointStore = require('../../file/checkpoint.js');
      const store = new CheckpointStore(tmpDir);
      const { cp } = await store.load('test-job-2', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 12n, 'checkpoint = maxRid(12n) — 마지막 성공 RID (inclusive)');
      assert.equal(appendedRows.length, 3, '3개 row가 append되어야 함');
    } finally {
      Writer.prototype.open = origOpen;
      Writer.prototype.append = origAppend;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('drop_not_found → checkpoint = maxRidInBatch+1 (all-drop 케이스)', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;

    const reader = makeTagSourceReader(new Map(), (startRid) => {
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
    });

    const appendedRows = [];
    const Writer = require('../../machbase/writer.js');
    const origOpen = Writer.prototype.open;
    const origAppend = Writer.prototype.append;
    Writer.prototype.open = async function() {
      this.appendColumns = [];
      this.stream = { append: async () => {}, close: async () => {} };
      return null;
    };
    Writer.prototype.append = async function(rows) {
      appendedRows.push(...rows);
      return null;
    };

    try {
      await runDataTableWorker({
        jobId: 'test-alldrop',
        mapping: {
          source: { server: 'src', table: 'TAG' },
          target: { server: 'dst', table: 'TAG2' },
          execution: {
            query_limit: 100,
            poll_interval_ms: 1000,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        writer: new Writer(),
        shutdownFlag,
      });

      const CheckpointStore = require('../../file/checkpoint.js');
      const store = new CheckpointStore(tmpDir);
      const { cp } = await store.load('test-alldrop', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 5n, 'all-drop: checkpoint = maxRidInBatch(5n) — 마지막 성공 RID (inclusive)');
      assert.equal(appendedRows.length, 0, 'drop → append 없음');
    } finally {
      Writer.prototype.open = origOpen;
      Writer.prototype.append = origAppend;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('LOG 테이블 → tag_id 변환 없이 그대로 append', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;

    const reader = makeLogSourceReader((startRid) => {
      batchCall++;
      if (batchCall === 1) {
        return {
          rows: [{ rid: 20n, tagId: null, data: { NAME: 'raw_name', TIME: 5000n, VALUE: 9.9 } }],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    });

    const appendedRows = [];
    const Writer = require('../../machbase/writer.js');
    const origOpen = Writer.prototype.open;
    const origAppend = Writer.prototype.append;
    Writer.prototype.open = async function() {
      this.appendColumns = [];
      this.stream = { append: async () => {}, close: async () => {} };
      return null;
    };
    Writer.prototype.append = async function(rows) {
      appendedRows.push(...rows);
      return null;
    };

    try {
      await runDataTableWorker({
        jobId: 'test-log',
        mapping: {
          source: { server: 'src', table: 'LOG' },
          target: { server: 'dst', table: 'LOG2' },
          execution: {
            query_limit: 100,
            poll_interval_ms: 1000,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'LOG',
        dataTable: '_LOG_DATA_0',
        reader: reader,
        writer: new Writer(),
        shutdownFlag,
      });

      assert.equal(appendedRows.length, 1);
      assert.equal(appendedRows[0].NAME, 'raw_name', 'LOG: data.NAME 그대로 사용');
    } finally {
      Writer.prototype.open = origOpen;
      Writer.prototype.append = origAppend;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('runDataTableWorker — STARTUP_INTEGRITY', () => {
  test('integrity.enabled=false → STARTUP_INTEGRITY 미실행, 즉시 STEADY 진입', async () => {
    const tmpDir = await makeTmpDir();

    const CheckpointStore = require('../../file/checkpoint.js');
    const store = new CheckpointStore(tmpDir);
    await store.save('test-int', '_TAG_DATA_0', {
      last_success_rid: 10n,
      source_server: 'src',
      source_table: 'TAG',
    }, { rows_read: 5, rows_written: 5, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = makeShutdownFlag(30);
    const readCalls = [];
    const integrityCheckCalls = [];

    const reader = makeTagSourceReader(new Map([[1, 'tag_a'], [2, 'tag_b']]), (startRid) => {
      readCalls.push(startRid);
      return { rows: [], err: null };
    });

    const IntegrityChecker = require('../../machbase/integrity_checker.js');
    const origBatchExists = IntegrityChecker.batchExists;
    IntegrityChecker.batchExists = async () => {
      integrityCheckCalls.push(true);
      return { existSet: new Set(), err: null };
    };

    const Writer = require('../../machbase/writer.js');
    const origOpen = Writer.prototype.open;
    Writer.prototype.open = async function() {
      this.appendColumns = [];
      this.stream = { append: async () => {}, close: async () => {} };
      return null;
    };

    try {
      await runDataTableWorker({
        jobId: 'test-int',
        mapping: {
          source: { server: 'src', table: 'TAG' },
          target: { server: 'dst', table: 'TAG2' },
          execution: {
            query_limit: 100,
            poll_interval_ms: 20,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        writer: new Writer(),
        shutdownFlag,
      });

      assert.equal(integrityCheckCalls.length, 0, 'integrity.enabled=false → IntegrityChecker 미호출');
      assert.equal(readCalls[0], 11n, 'STEADY는 checkpoint(10n)+1n=11n부터 시작해야 함');
    } finally {
      IntegrityChecker.batchExists = origBatchExists;
      Writer.prototype.open = origOpen;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('TAG + checkpoint존재 + integrity.enabled → STARTUP_INTEGRITY 수행, first_miss 발견 후 STEADY', async () => {
    const tmpDir = await makeTmpDir();

    const CheckpointStore = require('../../file/checkpoint.js');
    const store = new CheckpointStore(tmpDir);
    await store.save('test-int2', '_TAG_DATA_0', {
      last_success_rid: 100n,
      source_server: 'src',
      source_table: 'TAG',
    }, { rows_read: 5, rows_written: 5, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = { value: false };
    let steadyReadCalls = [];
    let integrityReadDone = false;

    const reader = makeTagSourceReader(new Map([[1, 'sensor_a']]), (startRid) => {
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
    });

    const IntegrityChecker = require('../../machbase/integrity_checker.js');
    const origBatchExists = IntegrityChecker.batchExists;
    IntegrityChecker.batchExists = async (_conn, _table, rows) => {
      const existSet = new Set();
      for (const r of rows) {
        if (r.time === 1000n) existSet.add(IntegrityChecker.existKey(r.canonical, r.time));
      }
      return { existSet, err: null };
    };

    const machbaseMod = require('../../machbase/machbase.js');
    const origConnect = machbaseMod.MachbaseClient.prototype.connect;
    const origClose = machbaseMod.MachbaseClient.prototype.close;
    machbaseMod.MachbaseClient.prototype.connect = async function() {};
    machbaseMod.MachbaseClient.prototype.close = async function() {};

    const appendedRows = [];
    const Writer = require('../../machbase/writer.js');
    const origOpen = Writer.prototype.open;
    const origAppend = Writer.prototype.append;
    Writer.prototype.open = async function() {
      this.appendColumns = [];
      this.stream = { append: async () => {}, close: async () => {} };
      return null;
    };
    Writer.prototype.append = async function(rows) {
      appendedRows.push(...rows);
      return null;
    };

    try {
      await runDataTableWorker({
        jobId: 'test-int2',
        mapping: {
          source: { server: 'src', table: 'TAG' },
          target: { server: 'dst', table: 'TAG2' },
          execution: {
            query_limit: 100,
            poll_interval_ms: 20,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: true },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        reader: reader,
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        writer: new Writer(),
        shutdownFlag,
      });

      const { cp } = await store.load('test-int2', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 101n, 'STARTUP_INTEGRITY: safe_cp_rid = first_miss(102n) - 1n = 101n');
      assert.equal(steadyReadCalls[0], 102n, 'STEADY는 firstMissRid(102n)부터 시작');
    } finally {
      IntegrityChecker.batchExists = origBatchExists;
      machbaseMod.MachbaseClient.prototype.connect = origConnect;
      machbaseMod.MachbaseClient.prototype.close = origClose;
      Writer.prototype.open = origOpen;
      Writer.prototype.append = origAppend;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('LOG 테이블 → checkpoint 있어도 STARTUP_INTEGRITY 미수행', async () => {
    const tmpDir = await makeTmpDir();

    const CheckpointStore = require('../../file/checkpoint.js');
    const store = new CheckpointStore(tmpDir);
    await store.save('test-log-int', '_LOG_DATA_0', {
      last_success_rid: 50n,
      source_server: 'src',
      source_table: 'LOG',
    }, { rows_read: 5, rows_written: 5, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = makeShutdownFlag(30);
    const integrityCheckCalls = [];

    const reader = makeLogSourceReader(() => ({ rows: [], err: null }));

    const IntegrityChecker = require('../../machbase/integrity_checker.js');
    const origBatchExists = IntegrityChecker.batchExists;
    IntegrityChecker.batchExists = async () => {
      integrityCheckCalls.push(true);
      return { existSet: new Set(), err: null };
    };

    const Writer = require('../../machbase/writer.js');
    const origOpen = Writer.prototype.open;
    Writer.prototype.open = async function() {
      this.appendColumns = [];
      this.stream = { append: async () => {}, close: async () => {} };
      return null;
    };

    try {
      await runDataTableWorker({
        jobId: 'test-log-int',
        mapping: {
          source: { server: 'src', table: 'LOG' },
          target: { server: 'dst', table: 'LOG2' },
          execution: {
            query_limit: 100,
            poll_interval_ms: 20,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: true },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'LOG',
        dataTable: '_LOG_DATA_0',
        reader: reader,
        writer: new Writer(),
        shutdownFlag,
      });

      assert.equal(integrityCheckCalls.length, 0, 'LOG 테이블 → IntegrityChecker 미호출');
    } finally {
      IntegrityChecker.batchExists = origBatchExists;
      Writer.prototype.open = origOpen;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
