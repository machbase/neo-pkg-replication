'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { Job, JobScheduler } = require('../../src/job.js');
const { makeTagSchema, makeSignal } = require('./fixtures/worker_fixtures.js');

// ─── Job — _discoverMapping ───────────────────────────────────────────────────

describe('Job — _discoverMapping', () => {
  test('discover 실패(connect 오류) → null 반환, 재시작 루프에서 workers=[]', async () => {
    const shutdownFlag = { value: false };
    const jobConfig = {
      id: 'job-disc-fail',
      source: { server: 'src', table: 'TAG' },
      target: { server: 'dst', table: 'TAG2' },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };
    const servers = [
      { name: 'src', host: '127.0.0.1', port: 1, user: 'x', password: 'x' },
      { name: 'dst', host: '127.0.0.1', port: 1, user: 'x', password: 'x' },
    ];

    const job = new Job(jobConfig, servers, shutdownFlag);
    const logCtx = { job_id: 'job-disc-fail' };

    const result = await job._discoverMapping(jobConfig, logCtx);
    assert.equal(result, null, 'connect 실패 → _discoverMapping null 반환');
  });

  test('discover 성공 → { tableType, dataTables, srcSchema, dstSchema } 반환', async () => {
    const shutdownFlag = { value: false };
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-disc-ok',
      source: { server: 'src', table: 'TAG' },
      target: { server: 'dst', table: 'TAG' },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };

    const mockSchema = makeTagSchema();

    const job = new Job(jobConfig, servers, shutdownFlag);
    job._discoverMapping = async () => ({
      tableType: 'TAG',
      dataTables: ['_TAG_DATA_0'],
      srcSchema: mockSchema,
      dstSchema: mockSchema,
    });

    const logCtx = { job_id: 'job-disc-ok' };
    const result = await job._discoverMapping(jobConfig, logCtx);

    assert.ok(result !== null, '_discoverMapping null이 아니어야 함');
    assert.equal(result.tableType, 'TAG');
    assert.deepEqual(result.dataTables, ['_TAG_DATA_0']);
    assert.ok(result.srcSchema);
    assert.ok(result.dstSchema);
  });

  test('source.columns에 존재하지 않는 컬럼 → null 반환', async () => {
    const shutdownFlag = { value: false };
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-disc-badcol',
      source: { server: 'src', table: 'TAG', columns: ['TIME', 'NONEXISTENT'] },
      target: { server: 'dst', table: 'TAG' },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };

    const mockSchema = makeTagSchema();
    const tableMod = require('../../src/db/table.js');
    const clientMod = require('../../src/db/client.js');

    // connect/close mock
    const origConnect = clientMod.MachbaseClient.prototype.connect;
    const origClose = clientMod.MachbaseClient.prototype.close;
    clientMod.MachbaseClient.prototype.connect = async function() {};
    clientMod.MachbaseClient.prototype.close = async function() {};

    // TagTable mock
    const origTagConnect = tableMod.TagTable.prototype.client;
    const origGetDataTables = tableMod.TagTable.prototype.getDataTables;
    const origGetSchema = tableMod.TagTable.prototype.getSchema;
    tableMod.TagTable.prototype.getDataTables = async function() { return [{ data_table: '_TAG_DATA_0' }]; };
    tableMod.TagTable.prototype.getSchema = async function() { return mockSchema; };

    // selectTableType mock
    const origSelectTableType = clientMod.MachbaseClient.prototype.selectTableType;
    clientMod.MachbaseClient.prototype.selectTableType = async function() { return { type: 'TAG' }; };

    try {
      const job = new Job(jobConfig, servers, shutdownFlag);
      const result = await job._discoverMapping({ job_id: 'job-disc-badcol' });
      assert.equal(result, null, 'source.columns에 미존재 컬럼 → null 반환');
    } finally {
      clientMod.MachbaseClient.prototype.connect = origConnect;
      clientMod.MachbaseClient.prototype.close = origClose;
      clientMod.MachbaseClient.prototype.selectTableType = origSelectTableType;
      tableMod.TagTable.prototype.getDataTables = origGetDataTables;
      tableMod.TagTable.prototype.getSchema = origGetSchema;
    }
  });

  test('TAG: source.columns에 NAME 누락 → null 반환', async () => {
    const shutdownFlag = { value: false };
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-tag-missing-name',
      source: { server: 'src', table: 'TAG', columns: ['TIME', 'VALUE'] },
      target: { server: 'dst', table: 'TAG2', autoCreate: false },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };

    const mockSchema = makeTagSchema();
    const tableMod = require('../../src/db/table.js');
    const clientMod = require('../../src/db/client.js');

    const origConnect = clientMod.MachbaseClient.prototype.connect;
    const origClose = clientMod.MachbaseClient.prototype.close;
    const origSelectTableType = clientMod.MachbaseClient.prototype.selectTableType;
    const origGetDataTables = tableMod.TagTable.prototype.getDataTables;
    const origGetSchema = tableMod.TagTable.prototype.getSchema;

    clientMod.MachbaseClient.prototype.connect = async function() {};
    clientMod.MachbaseClient.prototype.close = async function() {};
    clientMod.MachbaseClient.prototype.selectTableType = async function() { return { type: 'TAG' }; };
    tableMod.TagTable.prototype.getDataTables = async function() { return [{ data_table: '_TAG_DATA_0' }]; };
    tableMod.TagTable.prototype.getSchema = async function() { return mockSchema; };

    try {
      const job = new Job(jobConfig, servers, shutdownFlag);
      const result = await job._discoverMapping({ job_id: 'job-tag-missing-name' });
      assert.equal(result, null, 'TAG source.columns에 NAME 누락 → null 반환');
    } finally {
      clientMod.MachbaseClient.prototype.connect = origConnect;
      clientMod.MachbaseClient.prototype.close = origClose;
      clientMod.MachbaseClient.prototype.selectTableType = origSelectTableType;
      tableMod.TagTable.prototype.getDataTables = origGetDataTables;
      tableMod.TagTable.prototype.getSchema = origGetSchema;
    }
  });

  test('TAG: source.columns에 TIME 누락 → null 반환', async () => {
    const shutdownFlag = { value: false };
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-tag-missing-time',
      source: { server: 'src', table: 'TAG', columns: ['NAME', 'VALUE'] },
      target: { server: 'dst', table: 'TAG2', autoCreate: false },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };

    const mockSchema = makeTagSchema();
    const tableMod = require('../../src/db/table.js');
    const clientMod = require('../../src/db/client.js');

    const origConnect = clientMod.MachbaseClient.prototype.connect;
    const origClose = clientMod.MachbaseClient.prototype.close;
    const origSelectTableType = clientMod.MachbaseClient.prototype.selectTableType;
    const origGetDataTables = tableMod.TagTable.prototype.getDataTables;
    const origGetSchema = tableMod.TagTable.prototype.getSchema;

    clientMod.MachbaseClient.prototype.connect = async function() {};
    clientMod.MachbaseClient.prototype.close = async function() {};
    clientMod.MachbaseClient.prototype.selectTableType = async function() { return { type: 'TAG' }; };
    tableMod.TagTable.prototype.getDataTables = async function() { return [{ data_table: '_TAG_DATA_0' }]; };
    tableMod.TagTable.prototype.getSchema = async function() { return mockSchema; };

    try {
      const job = new Job(jobConfig, servers, shutdownFlag);
      const result = await job._discoverMapping({ job_id: 'job-tag-missing-time' });
      assert.equal(result, null, 'TAG source.columns에 TIME 누락 → null 반환');
    } finally {
      clientMod.MachbaseClient.prototype.connect = origConnect;
      clientMod.MachbaseClient.prototype.close = origClose;
      clientMod.MachbaseClient.prototype.selectTableType = origSelectTableType;
      tableMod.TagTable.prototype.getDataTables = origGetDataTables;
      tableMod.TagTable.prototype.getSchema = origGetSchema;
    }
  });

  test('src에만 있는 컬럼(non-metadata) → null 반환', async () => {
    const shutdownFlag = { value: false };
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-disc-srccol',
      source: { server: 'src', table: 'TAG', columns: null },
      target: { server: 'dst', table: 'TAG' },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };

    const srcSchema = {
      tableType: 'TAG', logicalTable: 'TAG',
      columns: [
        { name: 'NAME',  columnType: { type: 'varchar' }, id: 0, flag: 0x8000000, length: 80 },
        { name: 'TIME',  columnType: { type: 'int64' },   id: 1, flag: 0x1000000, length: 0  },
        { name: 'VALUE', columnType: { type: 'float64' }, id: 2, flag: 0x2000000, length: 0  },
        { name: 'EXTRA', columnType: { type: 'varchar' }, id: 3, flag: 0,         length: 80 }, // src-only
      ],
    };
    const dstSchema = {
      tableType: 'TAG', logicalTable: 'TAG',
      columns: [
        { name: 'NAME',  columnType: { type: 'varchar' }, id: 0, flag: 0x8000000, length: 80 },
        { name: 'TIME',  columnType: { type: 'int64' },   id: 1, flag: 0x1000000, length: 0  },
        { name: 'VALUE', columnType: { type: 'float64' }, id: 2, flag: 0x2000000, length: 0  },
      ],
    };

    const tableMod = require('../../src/db/table.js');
    const clientMod = require('../../src/db/client.js');

    const origConnect = clientMod.MachbaseClient.prototype.connect;
    const origClose = clientMod.MachbaseClient.prototype.close;
    const origSelectTableType = clientMod.MachbaseClient.prototype.selectTableType;
    const origGetDataTables = tableMod.TagTable.prototype.getDataTables;
    const origGetSchema = tableMod.TagTable.prototype.getSchema;

    clientMod.MachbaseClient.prototype.connect = async function() {};
    clientMod.MachbaseClient.prototype.close = async function() {};
    clientMod.MachbaseClient.prototype.selectTableType = async function() { return { type: 'TAG' }; };

    let schemaCallCount = 0;
    tableMod.TagTable.prototype.getDataTables = async function() { return [{ data_table: '_TAG_DATA_0' }]; };
    tableMod.TagTable.prototype.getSchema = async function() {
      schemaCallCount++;
      return schemaCallCount === 1 ? srcSchema : dstSchema;
    };

    try {
      const job = new Job(jobConfig, servers, shutdownFlag);
      const result = await job._discoverMapping({ job_id: 'job-disc-srccol' });
      assert.equal(result, null, 'src-only 컬럼(EXTRA) 존재 → null 반환');
    } finally {
      clientMod.MachbaseClient.prototype.connect = origConnect;
      clientMod.MachbaseClient.prototype.close = origClose;
      clientMod.MachbaseClient.prototype.selectTableType = origSelectTableType;
      tableMod.TagTable.prototype.getDataTables = origGetDataTables;
      tableMod.TagTable.prototype.getSchema = origGetSchema;
    }
  });
});

// ─── Job — AbortController 전파 ──────────────────────────────────────────────

describe('Job — AbortController 전파', () => {
  function setupWorkerMocks({ onWorkerRun } = {}) {
    const workerMod = require('../../src/worker/worker.js');
    const tableMod = require('../../src/db/table.js');
    const clientMod = require('../../src/db/client.js');

    const origWorkerRun = workerMod.Worker.prototype.run;
    const origTagDataOpen = tableMod.TagDataTable.prototype.open;
    const origTagDataClose = tableMod.TagDataTable.prototype.close;
    const origTagOpen = tableMod.TagTable.prototype.open;
    const origTagClose = tableMod.TagTable.prototype.close;
    const origConnect = clientMod.MachbaseClient.prototype.connect;
    const origClose = clientMod.MachbaseClient.prototype.close;
    const origSelectTagMeta = clientMod.MachbaseClient.prototype.selectTagMeta;

    tableMod.TagDataTable.prototype.open = async function() {};
    tableMod.TagDataTable.prototype.close = async function() { return null; };
    tableMod.TagTable.prototype.open = async function() { return null; };
    tableMod.TagTable.prototype.close = async function() { return null; };
    clientMod.MachbaseClient.prototype.connect = async function() {};
    clientMod.MachbaseClient.prototype.close = async function() {};
    clientMod.MachbaseClient.prototype.selectTagMeta = async function() { return []; };

    if (onWorkerRun) workerMod.Worker.prototype.run = onWorkerRun;

    const jobRunnerKey = require.resolve('../../src/job.js');
    const origJobRunnerCache = require.cache[jobRunnerKey];
    delete require.cache[jobRunnerKey];
    const { Job: JobClass } = require('../../src/job.js');

    function restore() {
      workerMod.Worker.prototype.run = origWorkerRun;
      tableMod.TagDataTable.prototype.open = origTagDataOpen;
      tableMod.TagDataTable.prototype.close = origTagDataClose;
      tableMod.TagTable.prototype.open = origTagOpen;
      tableMod.TagTable.prototype.close = origTagClose;
      clientMod.MachbaseClient.prototype.connect = origConnect;
      clientMod.MachbaseClient.prototype.close = origClose;
      clientMod.MachbaseClient.prototype.selectTagMeta = origSelectTagMeta;
      if (origJobRunnerCache) {
        require.cache[jobRunnerKey] = origJobRunnerCache;
      } else {
        delete require.cache[jobRunnerKey];
      }
    }

    return { JobClass, restore };
  }

  test('signal.aborted=true이면 Worker.run()이 open 호출 없이 즉시 반환됨', async () => {
    const tableMod = require('../../src/db/table.js');
    let openCalled = false;
    const origOpen = tableMod.TagDataTable.prototype.open;
    tableMod.TagDataTable.prototype.open = async function() { openCalled = true; };

    try {
      const mockSchema = makeTagSchema();
      const shutdownFlag = { value: false };
      const { Worker: WorkerClass } = require('../../src/worker/worker.js');
      const worker = new WorkerClass(
        {
          id: 'job-signal-test',
          source: { server: 'src', table: 'TAG', tagIdentifier: { mode: 'none', value: '' }, columns: null },
          target: { server: 'dst', table: 'TAG' },
          startMode: 'full', pollIntervalMs: 20, queryLimit: 100,
        },
        'TAG', '_TAG_DATA_0', mockSchema, mockSchema,
        { host: 'mock', port: 1 }, { host: 'mock', port: 1 }, shutdownFlag,
      );

      const ac = new AbortController();
      ac.abort();
      await worker.run(ac.signal);

      assert.equal(openCalled, false, 'signal.aborted=true이면 open이 호출되지 않아야 함');
    } finally {
      tableMod.TagDataTable.prototype.open = origOpen;
    }
  });

  test('Worker_0 에러 → AbortController abort → Worker_1의 effectiveShutdownFlag.value=true', async () => {
    let worker1AbortDetected;
    const worker1AbortPromise = new Promise(resolve => { worker1AbortDetected = resolve; });
    let worker1ShutdownFlagValue = false;

    const { JobClass, restore } = setupWorkerMocks({
      onWorkerRun: async function(signal) {
        if (this.dataTable === '_TAG_DATA_0') {
          await new Promise(resolve => setImmediate(resolve));
          throw new Error('worker_0 intentional error');
        } else if (this.dataTable === '_TAG_DATA_1') {
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
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-abort-test',
      source: { server: 'src', table: 'TAG', tagIdentifier: { mode: 'none', value: '' }, columns: null },
      target: { server: 'dst', table: 'TAG' },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };
    const mockSchema = makeTagSchema();

    try {
      const job = new JobClass(jobConfig, servers, shutdownFlag);

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

      await Promise.all([job.run(), worker1AbortPromise]);

      assert.equal(worker1ShutdownFlagValue, true,
        'Worker_0 에러 후 Worker_1의 signal.aborted가 true여야 함 (AbortController 전파 검증)');
      assert.ok(discoverCount >= 2, `재시작이 발생해야 함 (discover 호출 횟수: ${discoverCount})`);
    } finally {
      restore();
    }
  });
});

// ─── Job — run() 재시작 동작 ──────────────────────────────────────────────────

describe('Job — run() 재시작 동작', () => {
  test('Worker 에러 → abort → 재시작 후 shutdown → 정상 종료', async () => {
    const shutdownFlag = { value: false };
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-restart',
      source: { server: 'src', table: 'TAG' },
      target: { server: 'dst', table: 'TAG' },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };

    const mockSchema = makeTagSchema();

    const { Worker: WorkerClass } = require('../../src/worker/worker.js');
    const origWorkerRun = WorkerClass.prototype.run;
    let workerRunCount = 0;
    WorkerClass.prototype.run = async function(_signal) {
      workerRunCount++;
      if (workerRunCount === 1) {
        throw new Error('first worker error');
      }
      shutdownFlag.value = true;
    };

    try {
      const job = new Job(jobConfig, servers, shutdownFlag);

      job._discoverMapping = async () => ({
        tableType: 'TAG',
        dataTables: ['_TAG_DATA_0'],
        srcSchema: mockSchema,
        dstSchema: mockSchema,
      });
      job._syncTagMeta = async () => true;

      await job.run();

      assert.ok(workerRunCount >= 2, `Worker는 최소 2회 실행되어야 함 (실제: ${workerRunCount}회) — 에러 후 재시작 확인`);
      assert.equal(shutdownFlag.value, true, 'shutdown 후 job.run()이 종료되어야 함');
    } finally {
      WorkerClass.prototype.run = origWorkerRun;
    }
  });
});

// ─── Job — autoCreate ────────────────────────────────────────────────────────

describe('Job — _discoverMapping autoCreate', () => {
  test('TAG: autoCreate=true + dst 파티션 없음 → createTagTable 호출 후 정상 반환', async () => {
    const shutdownFlag = { value: false };
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-autocreate-tag',
      source: { server: 'src', table: 'TAG', columns: null },
      target: { server: 'dst', table: 'TAG_COPY', autoCreate: true },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };

    const mockSchema = makeTagSchema();
    const tableMod = require('../../src/db/table.js');
    const clientMod = require('../../src/db/client.js');

    const origConnect = clientMod.MachbaseClient.prototype.connect;
    const origClose = clientMod.MachbaseClient.prototype.close;
    const origSelectTableType = clientMod.MachbaseClient.prototype.selectTableType;
    const origGetDataTables = tableMod.TagTable.prototype.getDataTables;
    const origGetSchema = tableMod.TagTable.prototype.getSchema;

    clientMod.MachbaseClient.prototype.connect = async function() {};
    clientMod.MachbaseClient.prototype.close = async function() {};
    clientMod.MachbaseClient.prototype.selectTableType = async function() { return { type: 'TAG' }; };

    let createTagTableCalled = false;
    clientMod.MachbaseClient.prototype.createTagTable = async function(name, schema) {
      createTagTableCalled = true;
      assert.equal(name, 'TAG_COPY');
      assert.ok(schema);
    };

    let dstDataTablesCallCount = 0;
    let schemaCallCount = 0;
    tableMod.TagTable.prototype.getDataTables = async function() {
      // src returns data; dst returns empty first, then data after create
      if (this.logicalTable === 'TAG') return [{ data_table: '_TAG_DATA_0' }];
      dstDataTablesCallCount++;
      if (dstDataTablesCallCount === 1) return [];
      return [{ data_table: '_TAG_COPY_DATA_0' }];
    };
    tableMod.TagTable.prototype.getSchema = async function() {
      schemaCallCount++;
      return mockSchema;
    };

    try {
      const job = new Job(jobConfig, servers, shutdownFlag);
      const result = await job._discoverMapping({ job_id: 'job-autocreate-tag' });
      assert.ok(createTagTableCalled, 'createTagTable이 호출되어야 함');
      assert.ok(result !== null, '결과가 null이 아니어야 함');
      assert.equal(result.tableType, 'TAG');
    } finally {
      clientMod.MachbaseClient.prototype.connect = origConnect;
      clientMod.MachbaseClient.prototype.close = origClose;
      clientMod.MachbaseClient.prototype.selectTableType = origSelectTableType;
      tableMod.TagTable.prototype.getDataTables = origGetDataTables;
      tableMod.TagTable.prototype.getSchema = origGetSchema;
      delete clientMod.MachbaseClient.prototype.createTagTable;
    }
  });

  test('TAG: autoCreate=false + dst 파티션 없음 → null 반환', async () => {
    const shutdownFlag = { value: false };
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-no-autocreate-tag',
      source: { server: 'src', table: 'TAG', columns: null },
      target: { server: 'dst', table: 'TAG_COPY', autoCreate: false },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };

    const mockSchema = makeTagSchema();
    const tableMod = require('../../src/db/table.js');
    const clientMod = require('../../src/db/client.js');

    const origConnect = clientMod.MachbaseClient.prototype.connect;
    const origClose = clientMod.MachbaseClient.prototype.close;
    const origSelectTableType = clientMod.MachbaseClient.prototype.selectTableType;
    const origGetDataTables = tableMod.TagTable.prototype.getDataTables;
    const origGetSchema = tableMod.TagTable.prototype.getSchema;

    clientMod.MachbaseClient.prototype.connect = async function() {};
    clientMod.MachbaseClient.prototype.close = async function() {};
    clientMod.MachbaseClient.prototype.selectTableType = async function() { return { type: 'TAG' }; };

    tableMod.TagTable.prototype.getDataTables = async function() {
      if (this.logicalTable === 'TAG') return [{ data_table: '_TAG_DATA_0' }];
      return []; // dst has no partitions
    };
    tableMod.TagTable.prototype.getSchema = async function() { return mockSchema; };

    try {
      const job = new Job(jobConfig, servers, shutdownFlag);
      const result = await job._discoverMapping({ job_id: 'job-no-autocreate-tag' });
      assert.equal(result, null, 'autoCreate=false + dst 파티션 없음 → null 반환');
    } finally {
      clientMod.MachbaseClient.prototype.connect = origConnect;
      clientMod.MachbaseClient.prototype.close = origClose;
      clientMod.MachbaseClient.prototype.selectTableType = origSelectTableType;
      tableMod.TagTable.prototype.getDataTables = origGetDataTables;
      tableMod.TagTable.prototype.getSchema = origGetSchema;
    }
  });

  test('LOG: autoCreate=true + dst 테이블 없음 → createLogTable 호출 후 정상 반환', async () => {
    const shutdownFlag = { value: false };
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-autocreate-log',
      source: { server: 'src', table: 'LOG_SRC', columns: null },
      target: { server: 'dst', table: 'LOG_DST', autoCreate: true },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };

    const tableMod = require('../../src/db/table.js');
    const clientMod = require('../../src/db/client.js');
    const { ColumnType, Column, TableSchema } = require('../../src/db/types.js');

    const logSchema = new TableSchema('LOG', 'LOG_SRC', [
      new Column('TIME', ColumnType.DATETIME, 1, 'data'),
      new Column('VALUE', ColumnType.DOUBLE, 2, 'data'),
    ]);

    const origConnect = clientMod.MachbaseClient.prototype.connect;
    const origClose = clientMod.MachbaseClient.prototype.close;
    const origSelectTableType = clientMod.MachbaseClient.prototype.selectTableType;
    const origLogGetSchema = tableMod.LogTable.prototype.getSchema;

    clientMod.MachbaseClient.prototype.connect = async function() {};
    clientMod.MachbaseClient.prototype.close = async function() {};

    let selectTableTypeCallCount = 0;
    clientMod.MachbaseClient.prototype.selectTableType = async function(tableName) {
      selectTableTypeCallCount++;
      // first call: src type check → LOG; second call: dst type check → UNSUPPORTED
      if (tableName === 'LOG_SRC') return { type: 'LOG' };
      return { type: 'UNSUPPORTED' };
    };

    let createLogTableCalled = false;
    clientMod.MachbaseClient.prototype.createLogTable = async function(name, schema) {
      createLogTableCalled = true;
      assert.equal(name, 'LOG_DST');
      assert.ok(schema);
    };

    tableMod.LogTable.prototype.getSchema = async function() { return logSchema; };

    try {
      const job = new Job(jobConfig, servers, shutdownFlag);
      const result = await job._discoverMapping({ job_id: 'job-autocreate-log' });
      assert.ok(createLogTableCalled, 'createLogTable이 호출되어야 함');
      assert.ok(result !== null, '결과가 null이 아니어야 함');
      assert.equal(result.tableType, 'LOG');
    } finally {
      clientMod.MachbaseClient.prototype.connect = origConnect;
      clientMod.MachbaseClient.prototype.close = origClose;
      clientMod.MachbaseClient.prototype.selectTableType = origSelectTableType;
      tableMod.LogTable.prototype.getSchema = origLogGetSchema;
      delete clientMod.MachbaseClient.prototype.createLogTable;
    }
  });

  test('LOG: autoCreate=false + dst 테이블 없음 → null 반환', async () => {
    const shutdownFlag = { value: false };
    const servers = [
      { name: 'src', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
      { name: 'dst', host: 'mock', port: 5656, user: 'sys', password: 'manager' },
    ];
    const jobConfig = {
      id: 'job-no-autocreate-log',
      source: { server: 'src', table: 'LOG_SRC', columns: null },
      target: { server: 'dst', table: 'LOG_DST', autoCreate: false },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };

    const tableMod = require('../../src/db/table.js');
    const clientMod = require('../../src/db/client.js');
    const { ColumnType, Column, TableSchema } = require('../../src/db/types.js');

    const logSchema = new TableSchema('LOG', 'LOG_SRC', [
      new Column('TIME', ColumnType.DATETIME, 1, 'data'),
    ]);

    const origConnect = clientMod.MachbaseClient.prototype.connect;
    const origClose = clientMod.MachbaseClient.prototype.close;
    const origSelectTableType = clientMod.MachbaseClient.prototype.selectTableType;
    const origLogGetSchema = tableMod.LogTable.prototype.getSchema;

    clientMod.MachbaseClient.prototype.connect = async function() {};
    clientMod.MachbaseClient.prototype.close = async function() {};
    clientMod.MachbaseClient.prototype.selectTableType = async function(tableName) {
      if (tableName === 'LOG_SRC') return { type: 'LOG' };
      return { type: 'UNSUPPORTED' };
    };
    tableMod.LogTable.prototype.getSchema = async function() { return logSchema; };

    try {
      const job = new Job(jobConfig, servers, shutdownFlag);
      const result = await job._discoverMapping({ job_id: 'job-no-autocreate-log' });
      assert.equal(result, null, 'autoCreate=false + dst 테이블 없음 → null 반환');
    } finally {
      clientMod.MachbaseClient.prototype.connect = origConnect;
      clientMod.MachbaseClient.prototype.close = origClose;
      clientMod.MachbaseClient.prototype.selectTableType = origSelectTableType;
      tableMod.LogTable.prototype.getSchema = origLogGetSchema;
    }
  });
});

// ─── JobScheduler ─────────────────────────────────────────────────────────────

describe('JobScheduler', () => {
  test('register → getEntry 반환, status=stopped', () => {
    const scheduler = new JobScheduler([]);
    const jobConfig = { id: 'sched-1', source: {}, target: {} };
    scheduler.register(jobConfig);
    const entry = scheduler.getEntry('sched-1');
    assert.ok(entry, 'entry가 존재해야 함');
    assert.equal(entry.status, 'stopped');
    assert.equal(entry.jobConfig.id, 'sched-1');
  });

  test('unregister → stopped job 제거', () => {
    const scheduler = new JobScheduler([]);
    scheduler.register({ id: 'sched-unreg' });
    scheduler.unregister('sched-unreg');
    assert.equal(scheduler.getEntry('sched-unreg'), undefined);
  });

  test('update → stopped job의 jobConfig 교체', () => {
    const scheduler = new JobScheduler([]);
    scheduler.register({ id: 'sched-upd', value: 1 });
    scheduler.update({ id: 'sched-upd', value: 2 });
    assert.equal(scheduler.getEntry('sched-upd').jobConfig.value, 2);
  });

  test('listEntries → 전체 entry 배열 반환', () => {
    const scheduler = new JobScheduler([]);
    scheduler.register({ id: 'a' });
    scheduler.register({ id: 'b' });
    const entries = scheduler.listEntries();
    assert.equal(entries.length, 2);
  });

  test('start → status=running, stop → status=stopped', async () => {
    const scheduler = new JobScheduler([
      { name: 'src', host: 'mock', port: 1, user: 'x', password: 'x' },
    ]);
    const jobConfig = {
      id: 'sched-run',
      source: { server: 'src', table: 'TAG' },
      target: { server: 'src', table: 'TAG2' },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    };
    scheduler.register(jobConfig);

    const { Job: JobClass } = require('../../src/job.js');
    const origDiscover = JobClass.prototype._discoverMapping;
    JobClass.prototype._discoverMapping = async function() {
      this.shutdownFlag.value = true;
      return null;
    };

    try {
      scheduler.start('sched-run');
      const entry = scheduler.getEntry('sched-run');
      assert.equal(entry.status, 'running');
      await entry.promise;
      assert.equal(entry.status, 'stopped');
    } finally {
      JobClass.prototype._discoverMapping = origDiscover;
    }
  });

  test('stopAll → 모든 running job 중지', async () => {
    const scheduler = new JobScheduler([
      { name: 'src', host: 'mock', port: 1, user: 'x', password: 'x' },
    ]);
    const makeJob = (id) => ({
      id,
      source: { server: 'src', table: 'TAG' },
      target: { server: 'src', table: 'TAG2' },
      startMode: 'full', pollIntervalMs: 20, queryLimit: 100, integrity: { enabled: false },
    });

    scheduler.register(makeJob('stop-all-1'));
    scheduler.register(makeJob('stop-all-2'));

    const { Job: JobClass } = require('../../src/job.js');
    const origDiscover = JobClass.prototype._discoverMapping;
    JobClass.prototype._discoverMapping = async function() {
      await new Promise(resolve => {
        const check = () => { if (this.shutdownFlag.value) resolve(); else setTimeout(check, 10); };
        check();
      });
      return null;
    };

    try {
      scheduler.start('stop-all-1');
      scheduler.start('stop-all-2');
      await scheduler.stopAll();

      assert.equal(scheduler.getEntry('stop-all-1').status, 'stopped');
      assert.equal(scheduler.getEntry('stop-all-2').status, 'stopped');
    } finally {
      JobClass.prototype._discoverMapping = origDiscover;
    }
  });
});
