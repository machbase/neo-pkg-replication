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
  const tableMod = require('../../../src/db/table.js');
  const clientMod = require('../../../src/db/client.js');

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
function makeTagWorker(jobId, _tmpDir, overrides, shutdownFlag) {
  const { Worker } = require('../../../src/worker/worker.js');
  const schema = makeTagSchema();
  return new Worker(
    {
      id: jobId,
      source: { server: 'src', table: 'TAG', tag_identifier: { mode: 'none', value: '' }, columns: null },
      target: { server: 'dst', table: 'TAG2' },
      query_limit: 100,
      poll_interval_ms: 20,
      start_mode: 'full',
      on_save_failure: 'continue',
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
      source: { server: 'src', table: 'LOG', tag_identifier: { mode: 'none', value: '' }, columns: null },
      target: { server: 'dst', table: 'LOG2' },
      query_limit: 100,
      poll_interval_ms: 20,
      start_mode: 'full',
      on_save_failure: 'continue',
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
