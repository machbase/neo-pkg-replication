'use strict';

/**
 * @fileoverview Replicator 통합 테스트
 *
 * 기본값은 로컬 DB(127.0.0.1:5656)이며 fixtures.js 환경변수 override를 지원한다.
 * 사용법: jsh cgi-bin/tests/replication.test.js
 */

const fs = require('fs');
const process = require('process');
const path = require('path');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));
const ROOT = path.resolve(TESTS_DIR, '..');

const { suite, test, assert, run } = require(TESTS_DIR + '/test.js');
const { MachbaseClient, ColumnType, Column, TableSchema } = require(ROOT + '/src/db/client.js');
const { TagTable, LogTable } = require(ROOT + '/src/db/table.js');
const { Replicator } = require(ROOT + '/src/replication/replicator.js');
const { SRC, DST, SRC_TABLE, DST_TABLE } = require(TESTS_DIR + '/fixtures.js');

const TEMP_SUFFIX = String(Date.now());
const SRC_LOG_TABLE = `RPL_SRC_${TEMP_SUFFIX}`;
const DST_LOG_TABLE = `RPL_DST_${TEMP_SUFFIX}`;
const LOG_JOB_ID = `rpl_log_${TEMP_SUFFIX}`;
const LOG_NOW_JOB_ID = `rpl_log_now_${TEMP_SUFFIX}`;

/**
 * 테스트용 ReplicatorConfig 기본값을 생성한다.
 * @param {object} [overrides={}] - 덮어쓸 필드
 * @returns {object}
 */
function makeConfig(overrides = {}) {
  const config = {
    source: {
      ...SRC,
      table: SRC_TABLE,
      columns: ['NAME', 'TIME', 'VALUE'],
      meta: [],
      rep_target_cond: { op: 'ALL', value: [] },
      transform: null,
    },
    target: {
      ...DST,
      table: DST_TABLE,
      columns: ['NAME', 'TIME', 'VALUE'],
      meta: [],
    },
    startMode: 'full',
    queryLimit: 100,
    pollIntervalMs: 100,
    onSaveFailure: 'continue',
    shutdownTimeoutMs: 5000,
    retry: null,
  };
  const next = { ...config, ...overrides };
  if (overrides.source) next.source = { ...config.source, ...overrides.source };
  if (overrides.target) next.target = { ...config.target, ...overrides.target };
  return next;
}

/**
 * DST_TABLE이 존재하면 DROP하여 초기화한다.
 */
function dropTable(config, tableName) {
  const client = new MachbaseClient(config);
  try {
    client.connect();
    const t = client.selectTableTypeQualified(tableName);
    if (t.type !== 'UNSUPPORTED') {
      client.execute(`DROP TABLE ${tableName}`);
    }
  } finally {
    client.close();
  }
}

function dropDstTable() {
  dropTable(DST, DST_TABLE);
}

/**
 * DST_TABLE을 source schema 기준으로 다시 생성한다.
 */
async function recreateDstTable() {
  const srcTable = new TagTable(SRC, SRC_TABLE);
  const dstClient = new MachbaseClient(DST);
  try {
    await srcTable.open();
    const schema = await srcTable.getSchema();
    dstClient.connect();
    const existing = dstClient.selectTableTypeQualified(DST_TABLE);
    if (existing.type !== 'UNSUPPORTED') {
      dstClient.execute(`DROP TABLE ${DST_TABLE}`);
    }
    dstClient.createTagTable(DST_TABLE, schema);
  } finally {
    try { await srcTable.close(); } catch (_) {}
    dstClient.close();
  }
}

function makeLogSchema(logicalTable) {
  return new TableSchema('LOG', logicalTable, [
    new Column('TIME', ColumnType.DATETIME, 0, 0, 0),
    new Column('VALUE', ColumnType.DOUBLE, 1, 0, 0),
  ]);
}

async function seedLogSourceAndTarget() {
  const srcSchema = makeLogSchema(SRC_LOG_TABLE);
  const dstSchema = makeLogSchema(DST_LOG_TABLE);
  const srcClient = new MachbaseClient(SRC);
  const dstClient = new MachbaseClient(DST);
  const srcLog = new LogTable(SRC_LOG_TABLE, SRC);
  const rows = [
    { TIME: '2026-04-17T02:00:00Z', VALUE: 10.5 },
    { TIME: '2026-04-17T02:00:01Z', VALUE: 20.5 },
    { TIME: '2026-04-17T02:00:02Z', VALUE: 30.5 },
    { TIME: '2026-04-17T02:00:03Z', VALUE: 40.5 },
    { TIME: '2026-04-17T02:00:04Z', VALUE: 50.5 },
  ];

  dropTable(SRC, SRC_LOG_TABLE);
  dropTable(DST, DST_LOG_TABLE);

  try {
    srcClient.connect();
    srcClient.createLogTable(SRC_LOG_TABLE, srcSchema);
  } finally {
    srcClient.close();
  }

  try {
    dstClient.connect();
    dstClient.createLogTable(DST_LOG_TABLE, dstSchema);
  } finally {
    dstClient.close();
  }

  try {
    await srcLog.open();
    srcLog.setSchema(await srcLog.getSchema());
    const err = await srcLog.append(rows);
    assert.ok(err === null || err === undefined, `source seed append failed: ${err}`);
  } finally {
    await srcLog.close();
  }
}

/**
 * replicator id에 해당하는 checkpoint 디렉토리와 파일을 삭제한다.
 * checkpoint 경로: /work/data/{replicatorId}/{dataTable}.json
 * @param {string} replicatorId
 */
function dropCheckpoints(replicatorId) {
  const dir = ROOT + '/../data/' + replicatorId;
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    try { fs.unlinkSync(dir + '/' + f); } catch (_) {}
  }
  try { fs.rmdirSync(dir); } catch (_) {}
}

/**
 * makeConfig() 기준으로 Replicator가 자동 생성하는 id를 도출한다.
 * @param {object} [overrides={}]
 * @returns {string}
 */
function deriveId(overrides = {}) {
  const cfg = makeConfig(overrides);
  if (cfg.id) return cfg.id;
  const targetTable = cfg.target.table || cfg.source.table;
  return `${cfg.source.table}_${targetTable}`;
}

suite('Replicator - discover', () => {

  test('TAG 테이블 discover 성공', async () => {
    await recreateDstTable();
    const r = new Replicator(makeConfig());
    const discovered = await r.discover();
    assert.ok(discovered, 'discover should succeed');
    assert.equal(discovered.tableType, 'TAG');
    assert.ok(discovered.dataTables.length > 0);
    assert.ok(discovered.srcSchema);
    assert.ok(discovered.dstSchema);
  });

  test('존재하지 않는 source 테이블 - discover null 반환', async () => {
    await recreateDstTable();
    const r = new Replicator(makeConfig({
      source: { ...SRC, table: 'NO_SUCH_TABLE_XYZ' },
    }));
    const discovered = await r.discover();
    assert.equal(discovered, null);
  });

  test('대상 테이블 없음 - discover null 반환', async () => {
    dropDstTable();
    const r = new Replicator(makeConfig());
    const discovered = await r.discover();
    assert.equal(discovered, null);
  });

});

suite('Replicator - replication', () => {

  test('정적 LOG source 복제 후 dst 테이블에 데이터 존재', async () => {
    await seedLogSourceAndTarget();
    dropCheckpoints(LOG_JOB_ID);

    const shutdownFlag = { value: false };
    const config = makeConfig({
      id: LOG_JOB_ID,
      source: {
        ...SRC,
        table: SRC_LOG_TABLE,
        columns: ['TIME', 'VALUE'],
        meta: [],
        rep_target_cond: { op: 'ALL', value: [] },
        transform: null,
      },
      target: {
        ...DST,
        table: DST_LOG_TABLE,
        columns: ['TIME', 'VALUE'],
        meta: [],
      },
      startMode: 'full',
      queryLimit: 10,
      pollIntervalMs: 200,
    });
    const replicator = new Replicator(config, shutdownFlag);

    const startPromise = replicator.start();
    setTimeout(() => { shutdownFlag.value = true; }, 1000);
    await startPromise;

    const dstClient = new MachbaseClient(DST);
    try {
      dstClient.connect();
      const t = dstClient.selectTableType(DST_LOG_TABLE);
      assert.equal(t.type, 'LOG', 'dst table should be LOG');
      const rows = dstClient.query(`SELECT COUNT(*) AS CNT FROM ${DST_LOG_TABLE}`);
      assert.equal(Number(rows[0].CNT), 5, 'dst row count mismatch');
    } finally {
      dstClient.close();
    }
  });

  test('startMode=now - 기존 LOG dst 테이블로 정상 시작', async () => {
    await seedLogSourceAndTarget();
    dropCheckpoints(LOG_NOW_JOB_ID);

    const shutdownFlag = { value: false };
    const config = makeConfig({
      id: LOG_NOW_JOB_ID,
      source: {
        ...SRC,
        table: SRC_LOG_TABLE,
        columns: ['TIME', 'VALUE'],
        meta: [],
        rep_target_cond: { op: 'ALL', value: [] },
        transform: null,
      },
      target: {
        ...DST,
        table: DST_LOG_TABLE,
        columns: ['TIME', 'VALUE'],
        meta: [],
      },
      startMode: 'now',
      queryLimit: 10,
      pollIntervalMs: 200,
    });
    const replicator = new Replicator(config, shutdownFlag);

    // discover 후 바로 shutdown
    const startPromise = replicator.start();
    setTimeout(() => { shutdownFlag.value = true; }, 1000);
    await startPromise;

    const dstClient = new MachbaseClient(DST);
    try {
      dstClient.connect();
      const t = dstClient.selectTableType(DST_LOG_TABLE);
      assert.equal(t.type, 'LOG');
    } finally {
      dstClient.close();
    }
  });

});

suite('Replicator - cleanup', () => {

  test('dst table / checkpoint cleanup', () => {
    dropDstTable();
    dropTable(SRC, SRC_LOG_TABLE);
    dropTable(DST, DST_LOG_TABLE);
    dropCheckpoints(deriveId());
    dropCheckpoints(deriveId({ startMode: 'now' }));
    dropCheckpoints(LOG_JOB_ID);
    dropCheckpoints(LOG_NOW_JOB_ID);
    assert.ok(true);
  });

});

run();
