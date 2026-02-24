'use strict';

const { test, describe, before, beforeEach } = require('node:test');
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

/** 지정된 tagId→name 매핑을 반환하는 목업 TagMetaProvider */
function makeMockTagMeta(mapping = {}) {
  return {
    async loadAll() {},
    async resolveTagCanonical(conn, tagId, tagIdentifier) {
      const name = mapping[String(tagId)];
      if (name === undefined) return { canonical: null, status: 'drop_not_found' };
      const canonical = tagIdentifier?.type === 'prefix'
        ? (tagIdentifier.value || '') + name
        : name;
      return { canonical, status: 'ok' };
    },
  };
}

/** rows 배열을 순서대로 반환하는 목업 sourceConn */
function makeMockSourceConn(batches) {
  let callIdx = 0;
  return {
    async query(sql) {
      // getMaxRid 쿼리
      if (sql.includes('MAX(_RID)')) return [{ max_rid: 0 }];
      // META 쿼리
      if (sql.includes('_META')) return [];
      return [];
    },
    // readAfterRid 를 직접 테스트하기 어려우므로 SourceReader를 mock할 수 없음
    // → SourceReader를 직접 호출하는 대신 별도 mock 전략을 사용
    _batches: batches,
    _callIdx: 0,
  };
}

/** appendOpen, append, close를 지원하는 목업 targetConn */
function makeMockTargetConn(existsMap = {}) {
  return {
    async query(sql, params) {
      // IntegrityChecker: SELECT 1 FROM table WHERE name=? AND time=?
      if (sql.includes('WHERE name') && sql.includes('AND time')) {
        const key = `${params[0]}_${params[1]}`;
        return existsMap[key] ? [{ 1: 1 }] : [];
      }
      // TargetWriter: M$SYS_COLUMNS 쿼리
      if (sql.includes('M$SYS_COLUMNS')) {
        return [
          { NAME: 'name', TYPE: 5 },  // varchar
          { NAME: 'time', TYPE: 12 }, // int64
          { NAME: 'value', TYPE: 20 }, // double
        ];
      }
      return [];
    },
    conn: {
      async appendOpen(table, columns) {
        return {
          _written: [],
          async append(rows) { this._written.push(...rows); },
          async close() {},
        };
      },
    },
  };
}

// ─── 테스트 헬퍼: Worker를 mock으로 실행 ─────────────────────────────────────
// worker.js가 SourceReader, TagMetaProvider를 직접 require하므로
// 테스트에서는 실제 DB 연결 없이 실행 가능한 시나리오만 검증

describe('runDataTableWorker — RESOLVE_START', () => {
  test('체크포인트 없음 + start_mode=full → startRid=0n 으로 시작 후 빈 배치 대기 후 shutdown', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = makeShutdownFlag(50); // 50ms 후 shutdown

    const readCalls = [];
    const appendedRows = [];

    // SourceReader를 mock하기 위해 require 캐시를 이용한 원숭이 패치
    const SourceReader = require('../../machbase/source_reader.js');
    const origRead = SourceReader.readAfterRid;
    const origMax = SourceReader.getMaxRid;
    SourceReader.readAfterRid = async (conn, dataTable, startRid, limit) => {
      readCalls.push({ startRid, limit });
      return { rows: [], err: null }; // 빈 배치 반환
    };
    SourceReader.getMaxRid = async () => ({ maxRid: 0n, err: null });

    const TargetWriter = require('../../machbase/target_writer.js');
    const origOpen = TargetWriter.prototype.open;
    TargetWriter.prototype.open = async function() { this.writeColumns = []; this.targetColumnNames = []; this.sourceColumnSet = new Set(); this.stream = { append: async (m) => appendedRows.push(...m), close: async () => {} }; return null; };

    try {
      await runDataTableWorker({
        jobId: 'test-job',
        mapping: {
          source: { server: 'src', table: 'TAG' },
          target: { server: 'dst', table: 'TAG2' },
          execution: {
            batch_size_records: 100,
            poll_interval_ms: 20,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      assert.ok(readCalls.length >= 1, '최소 1회 이상 readAfterRid 호출되어야 함');
      assert.equal(readCalls[0].startRid, 0n, 'start_mode=full → startRid=0n');
      assert.equal(appendedRows.length, 0, '빈 배치 → append 없음');
    } finally {
      SourceReader.readAfterRid = origRead;
      SourceReader.getMaxRid = origMax;
      TargetWriter.prototype.open = origOpen;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('체크포인트 있음 → last_success_rid에서 재개', async () => {
    const tmpDir = await makeTmpDir();
    const CheckpointStore = require('../../file/checkpoint.js');
    const store = new CheckpointStore(tmpDir);

    // 사전 체크포인트 저장
    await store.save('test-job', '_TAG_DATA_0', {
      last_success_rid: 1234n,
      source_server: 'src',
      source_table: 'TAG',
    }, { rows_read: 10, rows_written: 10, dropped_no_meta: 0, skipped_exists: 0 });

    const shutdownFlag = makeShutdownFlag(30);
    const readCalls = [];

    const SourceReader = require('../../machbase/source_reader.js');
    const origRead = SourceReader.readAfterRid;
    SourceReader.readAfterRid = async (conn, dt, startRid) => {
      readCalls.push(startRid);
      return { rows: [], err: null };
    };

    const TargetWriter = require('../../machbase/target_writer.js');
    const origOpen = TargetWriter.prototype.open;
    TargetWriter.prototype.open = async function() {
      this.writeColumns = []; this.targetColumnNames = []; this.sourceColumnSet = new Set();
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
            batch_size_records: 100,
            poll_interval_ms: 20,
            start_mode: 'full', // 무시되어야 함
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      assert.ok(readCalls.length >= 1);
      assert.equal(readCalls[0], 1234n, '체크포인트 last_success_rid=1234n 에서 재개해야 함');
    } finally {
      SourceReader.readAfterRid = origRead;
      TargetWriter.prototype.open = origOpen;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('start_mode=now → getMaxRid 실패 시 mapping skip (return)', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };

    const SourceReader = require('../../machbase/source_reader.js');
    const origMax = SourceReader.getMaxRid;
    SourceReader.getMaxRid = async () => ({ maxRid: 0n, err: new Error('DB down') });

    const TargetWriter = require('../../machbase/target_writer.js');
    const origOpen = TargetWriter.prototype.open;
    TargetWriter.prototype.open = async function() {
      this.writeColumns = []; this.targetColumnNames = []; this.sourceColumnSet = new Set();
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
            batch_size_records: 100,
            poll_interval_ms: 1000,
            start_mode: 'now',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });
      // shutdown 없이 정상 return되어야 함 (skip)
      assert.equal(shutdownFlag.value, false, 'shutdownFlag는 변경되지 않아야 함');
    } finally {
      SourceReader.getMaxRid = origMax;
      TargetWriter.prototype.open = origOpen;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('runDataTableWorker — STEADY_REPLICATION', () => {
  test('TAG 배치 처리 → checkpoint가 maxRid+1로 갱신됨', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;

    const SourceReader = require('../../machbase/source_reader.js');
    const origRead = SourceReader.readAfterRid;
    SourceReader.readAfterRid = async (conn, dt, startRid) => {
      batchCall++;
      if (batchCall === 1) {
        // 첫 번째 배치: 3개 row
        return {
          rows: [
            { rid: 10n, tagId: 1, time: 1000n, value: 1.1 },
            { rid: 11n, tagId: 2, time: 2000n, value: 2.2 },
            { rid: 12n, tagId: 1, time: 3000n, value: 3.3 },
          ],
          err: null,
        };
      }
      // 이후 shutdown
      shutdownFlag.value = true;
      return { rows: [], err: null };
    };

    const TagMetaProvider = require('../../machbase/tag_meta_provider.js');
    const origLoadAll = TagMetaProvider.prototype.loadAll;
    const origResolve = TagMetaProvider.prototype.resolveTagCanonical;
    TagMetaProvider.prototype.loadAll = async function() { this.map = new Map([[1, 'tag_a'], [2, 'tag_b']]); this.logicalTable = 'TAG'; };
    TagMetaProvider.prototype.resolveTagCanonical = async function(conn, tagId) {
      const name = this.map.get(Number(tagId));
      if (!name) return { canonical: null, status: 'drop_not_found' };
      return { canonical: name, status: 'ok' };
    };

    const appendedRows = [];
    const TargetWriter = require('../../machbase/target_writer.js');
    const origOpen = TargetWriter.prototype.open;
    const origAppend = TargetWriter.prototype.append;
    TargetWriter.prototype.open = async function() {
      this.writeColumns = [];
      this.targetColumnNames = ['name', 'time', 'value'];
      this.sourceColumnSet = new Set(['name', 'time', 'value']);
      this.stream = {
        append: async (matrix) => { appendedRows.push(...matrix); },
        close: async () => {},
      };
      return null;
    };
    TargetWriter.prototype.append = async function(rows) {
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
            batch_size_records: 100,
            poll_interval_ms: 1000,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      // checkpoint가 13n (maxRid=12n + 1)으로 저장되어야 함
      const CheckpointStore = require('../../file/checkpoint.js');
      const store = new CheckpointStore(tmpDir);
      const { cp } = await store.load('test-job-2', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 13n, 'checkpoint = maxRid(12n) + 1n = 13n');
      assert.equal(appendedRows.length, 3, '3개 row가 append되어야 함');
    } finally {
      SourceReader.readAfterRid = origRead;
      TagMetaProvider.prototype.loadAll = origLoadAll;
      TagMetaProvider.prototype.resolveTagCanonical = origResolve;
      TargetWriter.prototype.open = origOpen;
      TargetWriter.prototype.append = origAppend;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('drop_not_found → checkpoint = maxRidInBatch+1 (all-drop 케이스)', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;

    const SourceReader = require('../../machbase/source_reader.js');
    const origRead = SourceReader.readAfterRid;
    SourceReader.readAfterRid = async () => {
      batchCall++;
      if (batchCall === 1) {
        return {
          rows: [
            { rid: 5n, tagId: 999, time: 1000n, value: 0.0 }, // unknown tagId
          ],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    };

    const TagMetaProvider = require('../../machbase/tag_meta_provider.js');
    const origLoadAll = TagMetaProvider.prototype.loadAll;
    const origResolve = TagMetaProvider.prototype.resolveTagCanonical;
    TagMetaProvider.prototype.loadAll = async function() { this.map = new Map(); this.logicalTable = 'TAG'; };
    TagMetaProvider.prototype.resolveTagCanonical = async function() {
      return { canonical: null, status: 'drop_not_found' };
    };

    const appendedRows = [];
    const TargetWriter = require('../../machbase/target_writer.js');
    const origOpen = TargetWriter.prototype.open;
    const origAppend = TargetWriter.prototype.append;
    TargetWriter.prototype.open = async function() {
      this.writeColumns = [];
      this.targetColumnNames = ['name', 'time', 'value'];
      this.sourceColumnSet = new Set(['name', 'time', 'value']);
      this.stream = { append: async () => {}, close: async () => {} };
      return null;
    };
    TargetWriter.prototype.append = async function(rows) {
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
            batch_size_records: 100,
            poll_interval_ms: 1000,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      const CheckpointStore = require('../../file/checkpoint.js');
      const store = new CheckpointStore(tmpDir);
      const { cp } = await store.load('test-alldrop', '_TAG_DATA_0');
      assert.equal(cp.last_success_rid, 6n, 'all-drop: checkpoint = maxRidInBatch(5n) + 1n = 6n');
      assert.equal(appendedRows.length, 0, 'drop → append 없음');
    } finally {
      SourceReader.readAfterRid = origRead;
      TagMetaProvider.prototype.loadAll = origLoadAll;
      TagMetaProvider.prototype.resolveTagCanonical = origResolve;
      TargetWriter.prototype.open = origOpen;
      TargetWriter.prototype.append = origAppend;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('LOG 테이블 → tag_id 변환 없이 그대로 append', async () => {
    const tmpDir = await makeTmpDir();
    const shutdownFlag = { value: false };
    let batchCall = 0;

    const SourceReader = require('../../machbase/source_reader.js');
    const origRead = SourceReader.readAfterRid;
    SourceReader.readAfterRid = async () => {
      batchCall++;
      if (batchCall === 1) {
        return {
          rows: [{ rid: 20n, tagId: 'raw_name', time: 5000n, value: 9.9 }],
          err: null,
        };
      }
      shutdownFlag.value = true;
      return { rows: [], err: null };
    };

    const appendedRows = [];
    const TargetWriter = require('../../machbase/target_writer.js');
    const origOpen = TargetWriter.prototype.open;
    const origAppend = TargetWriter.prototype.append;
    TargetWriter.prototype.open = async function() {
      this.writeColumns = [];
      this.targetColumnNames = ['name', 'time', 'value'];
      this.sourceColumnSet = new Set(['name', 'time', 'value']);
      this.stream = { append: async () => {}, close: async () => {} };
      return null;
    };
    TargetWriter.prototype.append = async function(rows) {
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
            batch_size_records: 100,
            poll_interval_ms: 1000,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'LOG',
        dataTable: '_LOG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      assert.equal(appendedRows.length, 1);
      assert.equal(appendedRows[0].NAME, 'raw_name', 'LOG: tagId → NAME 그대로 사용');
    } finally {
      SourceReader.readAfterRid = origRead;
      TargetWriter.prototype.open = origOpen;
      TargetWriter.prototype.append = origAppend;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('runDataTableWorker — STARTUP_INTEGRITY', () => {
  test('integrity.enabled=false → STARTUP_INTEGRITY 미실행, 즉시 STEADY 진입', async () => {
    const tmpDir = await makeTmpDir();

    // 사전 checkpoint 저장
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

    const SourceReader = require('../../machbase/source_reader.js');
    const origRead = SourceReader.readAfterRid;
    SourceReader.readAfterRid = async (conn, dt, startRid) => {
      readCalls.push(startRid);
      return { rows: [], err: null };
    };

    const IntegrityChecker = require('../../machbase/integrity_checker.js');
    const origExists = IntegrityChecker.existsByTagAndTime;
    IntegrityChecker.existsByTagAndTime = async () => {
      integrityCheckCalls.push(true);
      return { exists: true, err: null };
    };

    const TagMetaProvider = require('../../machbase/tag_meta_provider.js');
    const origLoadAll = TagMetaProvider.prototype.loadAll;
    TagMetaProvider.prototype.loadAll = async function() { this.map = new Map(); this.logicalTable = 'TAG'; };

    const TargetWriter = require('../../machbase/target_writer.js');
    const origOpen = TargetWriter.prototype.open;
    TargetWriter.prototype.open = async function() {
      this.writeColumns = []; this.targetColumnNames = []; this.sourceColumnSet = new Set();
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
            batch_size_records: 100,
            poll_interval_ms: 20,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: false }, // ← 비활성화
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      assert.equal(integrityCheckCalls.length, 0, 'integrity.enabled=false → IntegrityChecker 미호출');
      // STEADY에서 체크포인트(10n)부터 읽기 시작
      assert.equal(readCalls[0], 10n, 'STEADY는 checkpoint(10n)부터 시작해야 함');
    } finally {
      SourceReader.readAfterRid = origRead;
      IntegrityChecker.existsByTagAndTime = origExists;
      TagMetaProvider.prototype.loadAll = origLoadAll;
      TargetWriter.prototype.open = origOpen;
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

    const SourceReader = require('../../machbase/source_reader.js');
    const origRead = SourceReader.readAfterRid;
    SourceReader.readAfterRid = async (conn, dt, startRid) => {
      if (!integrityReadDone) {
        // STARTUP_INTEGRITY read: 100n부터 rows 반환
        integrityReadDone = true;
        return {
          rows: [
            { rid: 100n, tagId: 1, time: 1000n, value: 1.0 }, // 대상에 존재
            { rid: 101n, tagId: 1, time: 2000n, value: 2.0 }, // 대상에 미존재 (first miss)
          ],
          err: null,
        };
      }
      // STEADY read
      steadyReadCalls.push(startRid);
      shutdownFlag.value = true;
      return { rows: [], err: null };
    };

    const TagMetaProvider = require('../../machbase/tag_meta_provider.js');
    const origLoadAll = TagMetaProvider.prototype.loadAll;
    const origResolve = TagMetaProvider.prototype.resolveTagCanonical;
    TagMetaProvider.prototype.loadAll = async function() { this.map = new Map([[1, 'sensor_a']]); this.logicalTable = 'TAG'; };
    TagMetaProvider.prototype.resolveTagCanonical = async function(conn, tagId) {
      const name = this.map.get(Number(tagId));
      if (!name) return { canonical: null, status: 'drop_not_found' };
      return { canonical: name, status: 'ok' };
    };

    const IntegrityChecker = require('../../machbase/integrity_checker.js');
    const origBatchExists = IntegrityChecker.batchExists;
    const origExistKey = IntegrityChecker.existKey;
    // rid=100 (time=1000n) → exists, rid=101 (time=2000n) → not exists
    IntegrityChecker.batchExists = async (conn, table, rows) => {
      const existSet = new Set();
      for (const r of rows) {
        if (r.time === 1000n) existSet.add(IntegrityChecker.existKey(r.canonical, r.time));
      }
      return { existSet, err: null };
    };

    // MachbaseClient mock: connect/close는 no-op
    const machbaseMod = require('../../machbase/machbase.js');
    const origConnect = machbaseMod.MachbaseClient.prototype.connect;
    const origClose = machbaseMod.MachbaseClient.prototype.close;
    machbaseMod.MachbaseClient.prototype.connect = async function() {};
    machbaseMod.MachbaseClient.prototype.close = async function() {};

    const appendedRows = [];
    const TargetWriter = require('../../machbase/target_writer.js');
    const origOpen = TargetWriter.prototype.open;
    const origAppend = TargetWriter.prototype.append;
    TargetWriter.prototype.open = async function() {
      this.writeColumns = [];
      this.targetColumnNames = ['name', 'time', 'value'];
      this.sourceColumnSet = new Set(['name', 'time', 'value']);
      this.stream = { append: async () => {}, close: async () => {} };
      return null;
    };
    TargetWriter.prototype.append = async function(rows) {
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
            batch_size_records: 100,
            poll_interval_ms: 20,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: true },
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: '_TAG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        dstConfig: { host: 'mock', port: 5656, user: 'mock', password: 'mock' },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      // safe_cp = firstMissRid - 1n = 101n - 1n = 100n
      const { cp } = await store.load('test-int2', '_TAG_DATA_0');
      // 마지막 저장된 checkpoint: STARTUP_INTEGRITY가 safe_cp=100n 저장 후
      // STEADY가 101n부터 시작해서 빈 배치 → shutdown (checkpoint 저장 안 됨)
      // 따라서 최종 checkpoint = safe_cp = 100n
      assert.equal(cp.last_success_rid, 100n, 'STARTUP_INTEGRITY: safe_cp_rid = first_miss(101n) - 1n = 100n');
      // STEADY는 firstMissRid(101n)부터 시작해야 함
      assert.equal(steadyReadCalls[0], 101n, 'STEADY는 firstMissRid(101n)부터 시작');
    } finally {
      SourceReader.readAfterRid = origRead;
      TagMetaProvider.prototype.loadAll = origLoadAll;
      TagMetaProvider.prototype.resolveTagCanonical = origResolve;
      IntegrityChecker.batchExists = origBatchExists;
      machbaseMod.MachbaseClient.prototype.connect = origConnect;
      machbaseMod.MachbaseClient.prototype.close = origClose;
      TargetWriter.prototype.open = origOpen;
      TargetWriter.prototype.append = origAppend;
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

    const SourceReader = require('../../machbase/source_reader.js');
    const origRead = SourceReader.readAfterRid;
    SourceReader.readAfterRid = async () => ({ rows: [], err: null });

    const IntegrityChecker = require('../../machbase/integrity_checker.js');
    const origExists = IntegrityChecker.existsByTagAndTime;
    IntegrityChecker.existsByTagAndTime = async () => {
      integrityCheckCalls.push(true);
      return { exists: true, err: null };
    };

    const TargetWriter = require('../../machbase/target_writer.js');
    const origOpen = TargetWriter.prototype.open;
    TargetWriter.prototype.open = async function() {
      this.writeColumns = []; this.targetColumnNames = []; this.sourceColumnSet = new Set();
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
            batch_size_records: 100,
            poll_interval_ms: 20,
            start_mode: 'full',
            on_save_failure: 'continue',
            integrity: { enabled: true }, // enabled이지만 LOG라서 미수행
          },
        },
        checkpoint: { directory: tmpDir },
        tableType: 'LOG', // ← LOG 테이블
        dataTable: '_LOG_DATA_0',
        sourceConn: { query: async () => [] },
        targetConn: { query: async () => [] },
        targetWriter: new TargetWriter(),
        shutdownFlag,
      });

      assert.equal(integrityCheckCalls.length, 0, 'LOG 테이블 → IntegrityChecker 미호출');
    } finally {
      SourceReader.readAfterRid = origRead;
      IntegrityChecker.existsByTagAndTime = origExists;
      TargetWriter.prototype.open = origOpen;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
