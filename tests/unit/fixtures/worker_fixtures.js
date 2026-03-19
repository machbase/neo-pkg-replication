'use strict';

const path = require('path');
const fs = require('fs/promises');
const os = require('os');

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

// FLAG 상수 (M$SYS_COLUMNS.FLAG)
const FLAG_BASETIME   = 0x1000000;
const FLAG_SUMMARIZED = 0x2000000;
const FLAG_PRIMARY    = 0x8000000;

/** TAG 스키마 mock */
function makeTagSchema() {
  return {
    tableType: 'TAG',
    logicalTable: 'TAG',
    columns: [
      { name: 'NAME',  columnType: { type: 'varchar', safeNull: '' },  id: 0, flag: FLAG_PRIMARY,              length: 80 },
      { name: 'TIME',  columnType: { type: 'int64',   safeNull: 0n },  id: 2, flag: FLAG_BASETIME,             length: 0  },
      { name: 'VALUE', columnType: { type: 'float64', safeNull: 0.0 }, id: 3, flag: FLAG_SUMMARIZED,           length: 0  },
    ],
  };
}

/** LOG 스키마 mock */
function makeLogSchema() {
  return {
    tableType: 'LOG',
    logicalTable: 'LOG',
    columns: [
      { name: 'NAME',  columnType: { type: 'varchar', safeNull: '' },  id: 0, flag: 0, length: 80 },
      { name: 'TIME',  columnType: { type: 'int64',   safeNull: 0n },  id: 1, flag: 0, length: 0  },
      { name: 'VALUE', columnType: { type: 'float64', safeNull: 0.0 }, id: 2, flag: 0, length: 0  },
    ],
  };
}

/** AbortController signal (not aborted) */
function makeSignal() {
  return new AbortController().signal;
}

/**
 * Worker 단위 테스트용 prototype mock 설정
 * TagDataTable / TagTable / LogTable / CheckpointStore prototype을 mock하고 복원 함수를 반환
 */
function setupWorkerPrototypeMocks({ readFn, appendFn } = {}) {
  const tableMod = require('../../../src/db/table.js');
  const clientMod = require('../../../src/db/client.js');
  const CheckpointStore = require('../../../src/db/checkpoint.js');

  // MachbaseClient connect/close mock (STARTUP_INTEGRITY intConn 포함)
  const origConnect = clientMod.MachbaseClient.prototype.connect;
  const origClose = clientMod.MachbaseClient.prototype.close;
  clientMod.MachbaseClient.prototype.connect = async function() {};
  clientMod.MachbaseClient.prototype.close = async function() {};

  const origTagDataOpen = tableMod.TagDataTable.prototype.open;
  const origTagDataClose = tableMod.TagDataTable.prototype.close;
  const origTagDataLoadCache = tableMod.TagDataTable.prototype.loadTagMetaCache;
  const origTagDataGetMaxRid = tableMod.TagDataTable.prototype.getMaxRid;
  const origTagDataRead = tableMod.TagDataTable.prototype.read;

  const origTagOpen = tableMod.TagTable.prototype.open;
  const origTagClose = tableMod.TagTable.prototype.close;
  const origTagAppend = tableMod.TagTable.prototype.append;

  const origLogOpen = tableMod.LogTable.prototype.open;
  const origLogClose = tableMod.LogTable.prototype.close;
  const origLogRead = tableMod.LogTable.prototype.read;
  const origLogAppend = tableMod.LogTable.prototype.append;

  // CheckpointStore mock — 파일 I/O 없이 메모리로 동작
  const origCpLoad = CheckpointStore.prototype.load;
  const origCpSave = CheckpointStore.prototype.save;
  const cpStore = {};  // key → { lastSuccessRid: bigint }
  CheckpointStore.prototype.load = async function(jobId, dataTable) {
    const key = `${jobId}_${dataTable}`;
    const saved = cpStore[key];
    if (saved) return { cp: { lastSuccessRid: saved.lastSuccessRid }, exists: true, err: null };
    return { cp: null, exists: false, err: null };
  };
  CheckpointStore.prototype.save = async function(jobId, dataTable, cp) {
    const key = `${jobId}_${dataTable}`;
    cpStore[key] = { lastSuccessRid: cp.lastSuccessRid };
    return null;
  };

  /** 테스트에서 초기 체크포인트 값을 주입하는 헬퍼 */
  function seedCheckpoint(jobId, dataTable, lastSuccessRid) {
    const key = `${jobId}_${dataTable}`;
    cpStore[key] = { lastSuccessRid };
  }

  /** 테스트에서 mock cpStore에서 체크포인트를 읽는 헬퍼 */
  function getCheckpoint(jobId, dataTable) {
    const key = `${jobId}_${dataTable}`;
    const saved = cpStore[key];
    if (saved) return { cp: { lastSuccessRid: saved.lastSuccessRid }, exists: true, err: null };
    return { cp: null, exists: false, err: null };
  }

  tableMod.TagDataTable.prototype.open = async function() {};
  tableMod.TagDataTable.prototype.close = async function() { return null; };
  tableMod.TagDataTable.prototype.loadTagMetaCache = async function() { return null; };
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
    CheckpointStore.prototype.load = origCpLoad;
    CheckpointStore.prototype.save = origCpSave;
    clientMod.MachbaseClient.prototype.connect = origConnect;
    clientMod.MachbaseClient.prototype.close = origClose;
    tableMod.TagDataTable.prototype.open = origTagDataOpen;
    tableMod.TagDataTable.prototype.close = origTagDataClose;
    tableMod.TagDataTable.prototype.loadTagMetaCache = origTagDataLoadCache;
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

  return { restore, seedCheckpoint, getCheckpoint };
}

/** TAG Worker 생성 헬퍼 */
function makeTagWorker(jobId, _tmpDir, overrides, shutdownFlag) {
  const { Worker } = require('../../../src/worker/worker.js');
  const schema = makeTagSchema();
  return new Worker(
    {
      id: jobId,
      source: { server: 'src', table: 'TAG', tagIdentifier: { mode: 'none', value: '' }, columns: null },
      target: { server: 'dst', table: 'TAG2' },
      queryLimit: 100,
      pollIntervalMs: 20,
      startMode: 'full',
      onSaveFailure: 'continue',
      integrity: { enabled: false },
      ...overrides,
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
function makeLogWorker(jobId, _tmpDir, overrides, shutdownFlag) {
  const { Worker } = require('../../../src/worker/worker.js');
  const schema = makeLogSchema();
  return new Worker(
    {
      id: jobId,
      source: { server: 'src', table: 'LOG', tagIdentifier: { mode: 'none', value: '' }, columns: null },
      target: { server: 'dst', table: 'LOG2' },
      queryLimit: 100,
      pollIntervalMs: 20,
      startMode: 'full',
      onSaveFailure: 'continue',
      integrity: { enabled: false },
      ...overrides,
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

module.exports = {
  makeShutdownFlag,
  makeTmpDir,
  makeTagSchema,
  makeLogSchema,
  makeSignal,
  setupWorkerPrototypeMocks,
  makeTagWorker,
  makeLogWorker,
};
