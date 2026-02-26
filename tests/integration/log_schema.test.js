'use strict';

/**
 * LOG 테이블 스키마 변형 통합 테스트
 *
 * 전제 조건:
 *   - 192.168.1.189:5656에 Machbase가 실행 중이어야 함
 *   - SYS/MANAGER 계정으로 접속 가능해야 함
 *
 * 테스트 시나리오:
 *   IT-LOG-SAME:      동일 스키마 LOG→LOG 복제
 *   IT-LOG-SRC-EXTRA:  소스에 추가 컬럼 (quality) — 대상에서 무시 검증
 *   IT-LOG-DST-EXTRA:  대상에 추가 컬럼 (status) — null 패딩 검증
 *   IT-LOG-DIFF-SCHEMA: 소스/대상 서로 다른 추가 컬럼
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs/promises');
const path = require('path');

const { MachbaseClient } = require('../../machbase/machbase.js');
const TableInfo = require('../../machbase/table_info.js');
const Reader = require('../../machbase/reader.js');
const Writer = require('../../machbase/writer.js');
const { runDataTableWorker } = require('../../worker/worker.js');

const DB_CONFIG = { host: '192.168.1.189', port: 5656, user: 'SYS', password: 'MANAGER' };
const TS = Date.now();
const T = (suffix) => `REPLI_LOGS_${suffix}_${TS}`;

// ─── 잔여 테스트 테이블 정리 ──────────────────────────────────────────────────

test('cleanup: 이전 테스트에서 남은 REPLI_LOGS_ 테이블 정리', async () => {
  const conn = new MachbaseClient(DB_CONFIG);
  await conn.connect();
  try {
    const rows = await conn.query(
      `SELECT NAME FROM M$SYS_TABLES WHERE NAME LIKE 'REPLI_LOGS_%' ORDER BY NAME`
    );
    for (const row of rows) {
      try {
        await conn.execute(`DROP TABLE ${row.NAME}`);
        console.log(`cleanup: dropped ${row.NAME}`);
      } catch (_) {}
    }
  } finally {
    await conn.close();
  }
});

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

async function makeConn() {
  const conn = new MachbaseClient(DB_CONFIG);
  await conn.connect();
  return conn;
}

async function execute(conn, sql) {
  await conn.execute(sql);
}

async function dropTable(conn, name) {
  try { await execute(conn, `DROP TABLE ${name}`); } catch (_) {}
}

let _nsCounter = 0n;
function nowNs(offsetMs = 0) {
  return BigInt(Date.now() + offsetMs) * 1_000_000n + (_nsCounter++);
}

function makeShutdownFlag(timeoutMs = 8000) {
  const flag = { value: false };
  setTimeout(() => { flag.value = true; }, timeoutMs);
  return flag;
}

function baseMapping(srcTable, dstTable, execOverrides = {}) {
  return {
    mapping_id: 'log-schema-test',
    source: { server: 'src', table: srcTable, tag_identifier: { mode: 'none', value: '' } },
    target: { server: 'dst', table: dstTable },
    execution: {
      start_mode: 'full',
      query_limit: 100,
      poll_interval_ms: 100,
      on_save_failure: 'continue',
      integrity: { enabled: false },
      retry: { max_attempts: 3, base_delay_ms: 10, max_delay_ms: 100 },
      ...execOverrides,
    },
  };
}

async function runWorker(srcTable, dstTable, tmpDir, jobId) {
  // TableInfo 빌드
  const tiConn1 = await makeConn();
  let srcTableInfo;
  try {
    srcTableInfo = await TableInfo.buildLog(tiConn1, srcTable);
  } finally {
    await tiConn1.close();
  }
  const tiConn2 = await makeConn();
  let dstTableInfo;
  try {
    dstTableInfo = await TableInfo.buildLog(tiConn2, dstTable);
  } finally {
    await tiConn2.close();
  }

  const srcConn = await makeConn();
  const dstConn = await makeConn();
  const reader = new Reader(srcTableInfo, srcConn, srcTable);
  const writer = new Writer(dstTableInfo);
  const openErr = await writer.open(dstConn, dstTable, srcTableInfo);
  if (openErr) throw openErr;
  try {
    await runDataTableWorker({
      jobId,
      mapping: baseMapping(srcTable, dstTable),
      checkpoint: { directory: tmpDir },
      tableType: 'LOG',
      dataTable: srcTable,
      srcConfig: DB_CONFIG,
      dstConfig: DB_CONFIG,
      reader: reader,
      writer: writer,
      shutdownFlag: makeShutdownFlag(8000),
    });
  } finally {
    await writer.close();
    await reader.close();
  }
}

// ─── IT-LOG-SAME: 동일 스키마 LOG→LOG 복제 ──────────────────────────────────

describe('IT-LOG-SAME: 동일 스키마 LOG→LOG 복제', () => {
  const SRC = T('SAME_SRC');
  const DST = T('SAME_DST');
  let conn, tmpDir;

  before(async () => {
    conn = await makeConn();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-same-'));
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await execute(conn, `CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await execute(conn, `CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await execute(conn, `INSERT INTO ${SRC} VALUES ('sensor_a', ${nowNs(0)}, 1.1)`);
    await execute(conn, `INSERT INTO ${SRC} VALUES ('sensor_b', ${nowNs(1)}, 2.2)`);
    await execute(conn, `INSERT INTO ${SRC} VALUES ('sensor_c', ${nowNs(2)}, 3.3)`);
  });

  after(async () => {
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('3행이 동일하게 복제됨', async () => {
    await runWorker(SRC, DST, tmpDir, `it-log-same-${TS}`);

    const verifyConn = await makeConn();
    try {
      const rows = await verifyConn.query(`SELECT name, value FROM ${DST} ORDER BY _RID ASC`);
      assert.equal(rows.length, 3, `3행 복제 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, r.value]));
      assert.equal(byName['sensor_a'], 1.1, 'sensor_a value 일치');
      assert.equal(byName['sensor_b'], 2.2, 'sensor_b value 일치');
      assert.equal(byName['sensor_c'], 3.3, 'sensor_c value 일치');
    } finally {
      await verifyConn.close();
    }
  });
});

// ─── IT-LOG-SRC-EXTRA: 소스에 추가 컬럼 (quality) ───────────────────────────

describe('IT-LOG-SRC-EXTRA: 소스에 추가 컬럼 (quality) — 대상 무시 검증', () => {
  const SRC = T('SRCEXT_SRC');
  const DST = T('SRCEXT_DST');
  let conn, tmpDir;

  before(async () => {
    conn = await makeConn();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-srcext-'));
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await execute(conn, `CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE, quality DOUBLE)`);
    await execute(conn, `CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await execute(conn, `INSERT INTO ${SRC} (name, time, value, quality) VALUES ('sensor_a', ${nowNs(0)}, 10.0, 0.95)`);
    await execute(conn, `INSERT INTO ${SRC} (name, time, value, quality) VALUES ('sensor_b', ${nowNs(1)}, 20.0, 0.87)`);
    await execute(conn, `INSERT INTO ${SRC} (name, time, value, quality) VALUES ('sensor_c', ${nowNs(2)}, 30.0, 0.99)`);
  });

  after(async () => {
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('소스 quality 컬럼은 무시되고 3행이 대상에 복제됨', async () => {
    await runWorker(SRC, DST, tmpDir, `it-log-srcext-${TS}`);

    const verifyConn = await makeConn();
    try {
      const rows = await verifyConn.query(`SELECT name, value FROM ${DST} ORDER BY _RID ASC`);
      assert.equal(rows.length, 3, `3행 복제 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, r.value]));
      assert.equal(byName['sensor_a'], 10.0, 'sensor_a value 일치');
      assert.equal(byName['sensor_b'], 20.0, 'sensor_b value 일치');
      assert.equal(byName['sensor_c'], 30.0, 'sensor_c value 일치');
    } finally {
      await verifyConn.close();
    }
  });
});

// ─── IT-LOG-DST-EXTRA: 대상에 추가 컬럼 (status) ────────────────────────────

describe('IT-LOG-DST-EXTRA: 대상에 추가 컬럼 (status) — null 패딩 검증', () => {
  const SRC = T('DSTEXT_SRC');
  const DST = T('DSTEXT_DST');
  let conn, tmpDir;

  before(async () => {
    conn = await makeConn();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-dstext-'));
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await execute(conn, `CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await execute(conn, `CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE, status VARCHAR(32))`);
    await execute(conn, `INSERT INTO ${SRC} VALUES ('machine_a', ${nowNs(0)}, 100.0)`);
    await execute(conn, `INSERT INTO ${SRC} VALUES ('machine_b', ${nowNs(1)}, 200.0)`);
  });

  after(async () => {
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('2행 복제, 대상 status 컬럼은 null', async () => {
    await runWorker(SRC, DST, tmpDir, `it-log-dstext-${TS}`);

    const verifyConn = await makeConn();
    try {
      const rows = await verifyConn.query(`SELECT name, value, status FROM ${DST} ORDER BY _RID ASC`);
      assert.equal(rows.length, 2, `2행 복제 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, { value: r.value, status: r.status }]));
      assert.equal(byName['machine_a'].value, 100.0, 'machine_a value 일치');
      assert.equal(byName['machine_b'].value, 200.0, 'machine_b value 일치');
      assert.equal(byName['machine_a'].status, '', 'machine_a status는 빈 문자열');
      assert.equal(byName['machine_b'].status, '', 'machine_b status는 빈 문자열');
    } finally {
      await verifyConn.close();
    }
  });
});

// ─── IT-LOG-DIFF-SCHEMA: 소스/대상 서로 다른 추가 컬럼 + 타입도 다름 ─────────

describe('IT-LOG-DIFF-SCHEMA: 소스/대상 서로 다른 추가 컬럼 + 타입 불일치', () => {
  const SRC = T('DIFF_SRC');
  const DST = T('DIFF_DST');
  let conn, tmpDir;

  before(async () => {
    conn = await makeConn();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-diff-'));
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    // SRC: 추가 컬럼 quality DOUBLE
    await execute(conn, `CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE, quality DOUBLE)`);
    // DST: 추가 컬럼 status VARCHAR(32) — 컬럼명도 다르고 타입도 다름
    await execute(conn, `CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE, status VARCHAR(32))`);
    await execute(conn, `INSERT INTO ${SRC} (name, time, value, quality) VALUES ('pump_a', ${nowNs(0)}, 55.5, 0.9)`);
    await execute(conn, `INSERT INTO ${SRC} (name, time, value, quality) VALUES ('pump_b', ${nowNs(1)}, 66.6, 0.8)`);
  });

  after(async () => {
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('소스 quality(DOUBLE) 무시, 대상 status(VARCHAR)는 빈 문자열로 null 패딩', async () => {
    await runWorker(SRC, DST, tmpDir, `it-log-diff-${TS}`);

    const verifyConn = await makeConn();
    try {
      const rows = await verifyConn.query(`SELECT name, value, status FROM ${DST} ORDER BY _RID ASC`);
      assert.equal(rows.length, 2, `2행 복제 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, { value: r.value, status: r.status }]));
      assert.equal(byName['pump_a'].value, 55.5, 'pump_a value 일치');
      assert.equal(byName['pump_b'].value, 66.6, 'pump_b value 일치');
      assert.equal(byName['pump_a'].status, '', 'pump_a status는 빈 문자열');
      assert.equal(byName['pump_b'].status, '', 'pump_b status는 빈 문자열');
    } finally {
      await verifyConn.close();
    }
  });
});
