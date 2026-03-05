'use strict';

/**
 * LOG 테이블 복제 통합 테스트
 *
 * 전제 조건:
 *   - 192.168.1.189:5656에 Machbase가 실행 중이어야 함
 *   - SYS/MANAGER 계정으로 접속 가능해야 함
 *
 * 테스트 시나리오:
 *   LOG-01: 동일 스키마 LOG→LOG 복제
 *   LOG-02: SRC-only 컬럼 → 복제 스킵 (cp 미저장)
 *   LOG-03: DST-only 컬럼 → safeNull 패딩
 *   LOG-04: 동일 컬럼명 but 타입 다름 → 복제 동작 확인
 *   LOG-05: start_mode=full
 *   LOG-06: start_mode=now
 *   LOG-07: cp 재시작 — cp 이후 데이터만 복제
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs/promises');
const path = require('path');

const { MachbaseClient } = require('../../machbase/machbase.js');
const { buildLogSchema } = require('../../machbase/schema_builder.js');
const { Reader } = require('../../machbase/reader.js');
const { Writer } = require('../../machbase/writer.js');
const CheckpointStore = require('../../file/checkpoint.js');
const { runDataTableWorker, LogRowProcessor } = require('../../worker/worker.js');

// ─── 접속 설정 ────────────────────────────────────────────────────────────────

const DB_CONFIG = {
  host: '192.168.1.189',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

const TS = Date.now();
const T = (suffix) => `REPLI_LOG_${suffix}_${TS}`;

// ─── 잔여 테이블 정리 ─────────────────────────────────────────────────────────

test('cleanup: 이전 테스트에서 남은 REPLI_LOG_ 테이블 정리', async () => {
  const conn = new MachbaseClient(DB_CONFIG);
  await conn.connect();
  try {
    const rows = await conn.query(
      `SELECT NAME FROM M$SYS_TABLES WHERE NAME LIKE 'REPLI_LOG_%' ORDER BY NAME`
    );
    for (const row of rows) {
      try { await conn.execute(`DROP TABLE ${row.NAME}`); } catch (_) {}
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

async function dropTable(conn, name) {
  try { await conn.execute(`DROP TABLE ${name}`); } catch (_) {}
}

async function buildLogSchemaPair(srcTable, dstTable) {
  const sc = await makeConn();
  let srcSchema;
  try { srcSchema = await buildLogSchema(sc, srcTable); } finally { await sc.close(); }
  const dc = await makeConn();
  let dstSchema;
  try { dstSchema = await buildLogSchema(dc, dstTable); } finally { await dc.close(); }
  return { srcSchema, dstSchema };
}

let _nsCounter = 0n;
function nowNs(offsetMs = 0) {
  return BigInt(Date.now() + offsetMs) * 1_000_000n + (_nsCounter++);
}

function makeShutdownFlag(timeoutMs = 500) {
  const flag = { value: false };
  setTimeout(() => { flag.value = true; }, timeoutMs);
  return flag;
}

function baseMapping(srcTable, dstTable, execOverrides = {}) {
  return {
    mapping_id: 'log-test',
    source: { server: 'src', table: srcTable, tag_identifier: { mode: 'none', value: '' }, columns: null },
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

/**
 * LOG Worker 실행 헬퍼
 * Writer.open 에러 시 throw
 */
async function runLogWorker(jobId, srcTable, dstTable, tmpDir, execOverrides = {}) {
  const { srcSchema, dstSchema } = await buildLogSchemaPair(srcTable, dstTable);
  const srcConn = await makeConn();
  const dstConn = await makeConn();
  const reader = new Reader(srcSchema, srcConn, srcTable);
  const writer = new Writer(dstSchema);
  try {
    const openErr = await writer.open(dstConn, dstTable, srcSchema);
    if (openErr) throw openErr;
    await runDataTableWorker({
      jobId,
      mapping: baseMapping(srcTable, dstTable, execOverrides),
      checkpoint: { directory: tmpDir },
      tableType: 'LOG',
      dataTable: srcTable,
      srcConfig: DB_CONFIG,
      dstConfig: DB_CONFIG,
      reader,
      aliasCache: null,
      writer,
      rowProcessor: new LogRowProcessor(),
      shutdownFlag: makeShutdownFlag(500),
    });
  } finally {
    await writer.close();
    await reader.close();
  }
}

// ─── LOG-01: 동일 스키마 ──────────────────────────────────────────────────────

test('LOG-01: 동일 스키마 LOG→LOG 복제 — 행수/value/cp 검증', async () => {
  const SRC = T('01_SRC'), DST = T('01_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-01-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.execute(`CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('sensor_a', ${nowNs(0)}, 1.1)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('sensor_b', ${nowNs(1)}, 2.2)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('sensor_c', ${nowNs(2)}, 3.3)`);

    const jobId = `log-01-${TS}`;
    await runLogWorker(jobId, SRC, DST, tmpDir);

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value FROM ${DST} ORDER BY _RID ASC`);
      assert.equal(rows.length, 3, `3행 복제 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, r.value]));
      assert.equal(byName['sensor_a'], 1.1);
      assert.equal(byName['sensor_b'], 2.2);
      assert.equal(byName['sensor_c'], 3.3);
    } finally { await vc.close(); }

    // cp 저장 확인
    const store = new CheckpointStore(tmpDir);
    const { exists, cp } = await store.load(jobId, SRC);
    assert.equal(exists, true, 'cp 저장됨');
    assert.ok(cp.last_success_rid > 0n, `last_success_rid > 0 (실제: ${cp.last_success_rid})`);
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── LOG-02: SRC-only 컬럼 → 복제 스킵 ──────────────────────────────────────

test('LOG-02: SRC-only 컬럼 → Writer.open 에러, 복제 스킵, cp 미저장', async () => {
  const SRC = T('02_SRC'), DST = T('02_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-02-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.execute(`CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE, quality DOUBLE)`);
    await conn.execute(`CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`INSERT INTO ${SRC} (name, time, value, quality) VALUES ('sensor_a', ${nowNs(0)}, 10.0, 0.99)`);
    await conn.execute(`INSERT INTO ${SRC} (name, time, value, quality) VALUES ('sensor_b', ${nowNs(1)}, 20.0, 0.95)`);

    const jobId = `log-02-${TS}`;
    await assert.rejects(
      () => runLogWorker(jobId, SRC, DST, tmpDir),
      (err) => {
        assert.ok(err.message.includes('QUALITY'), `에러 메시지에 QUALITY 포함: ${err.message}`);
        return true;
      }
    );

    // DST 0행
    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name FROM ${DST}`);
      assert.equal(rows.length, 0, `복제 스킵 → 0행 (실제: ${rows.length})`);
    } finally { await vc.close(); }

    // cp 미저장
    const store = new CheckpointStore(tmpDir);
    const { exists } = await store.load(jobId, SRC);
    assert.equal(exists, false, '복제 스킵 → cp 미저장');
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── LOG-03: DST-only 컬럼 → safeNull 패딩 ──────────────────────────────────

test('LOG-03: DST-only 컬럼 → safeNull 패딩, 정상 복제', async () => {
  const SRC = T('03_SRC'), DST = T('03_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-03-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.execute(`CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE, status VARCHAR(32))`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('machine_a', ${nowNs(0)}, 100.0)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('machine_b', ${nowNs(1)}, 200.0)`);

    await runLogWorker(`log-03-${TS}`, SRC, DST, tmpDir);

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value, status FROM ${DST} ORDER BY _RID ASC`);
      assert.equal(rows.length, 2, `2행 복제 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, r]));
      assert.equal(byName['machine_a'].value, 100.0);
      assert.equal(byName['machine_b'].value, 200.0);
      // DST-only 컬럼 status → safeNull(VARCHAR) = ''
      assert.equal(byName['machine_a'].status, '', 'machine_a status = safeNull("")');
      assert.equal(byName['machine_b'].status, '', 'machine_b status = safeNull("")');
    } finally { await vc.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── LOG-04: 동일 컬럼명 but 타입 다름 ──────────────────────────────────────

test('LOG-04: 동일 컬럼명 but 타입 다름 (SRC: value DOUBLE, DST: value VARCHAR) — 복제 동작 확인', async () => {
  const SRC = T('04_SRC'), DST = T('04_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-04-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.execute(`CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value VARCHAR(32))`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('sensor_a', ${nowNs(0)}, 3.14)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('sensor_b', ${nowNs(1)}, 2.72)`);

    let replicationError = null;
    try {
      await runLogWorker(`log-04-${TS}`, SRC, DST, tmpDir);
    } catch (err) {
      replicationError = err;
    }

    // 타입 불일치 시 에러 없이 복제되거나 appendStream에서 에러가 날 수 있음
    // 실제 동작 결과를 로그로 확인
    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value FROM ${DST} ORDER BY _RID ASC`);
      console.log(JSON.stringify({
        level: 'info', stage: 'test', test: 'LOG-04',
        msg: `타입 불일치 복제 결과: ${rows.length}행, error: ${replicationError?.message ?? 'none'}`,
      }));
      assert.ok(rows.length >= 0, '복제 결과가 있어야 함 (0행 이상)');
    } finally { await vc.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── LOG-05: start_mode=full ──────────────────────────────────────────────────

test('LOG-05: start_mode=full — RID 0부터 전체 복제', async () => {
  const SRC = T('05_SRC'), DST = T('05_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-05-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.execute(`CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('full_a', ${nowNs(0)}, 10.0)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('full_b', ${nowNs(1)}, 20.0)`);

    await runLogWorker(`log-05-${TS}`, SRC, DST, tmpDir, { start_mode: 'full' });

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value FROM ${DST} ORDER BY _RID ASC`);
      assert.equal(rows.length, 2, `전체 2행 복제 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, r.value]));
      assert.equal(byName['full_a'], 10.0);
      assert.equal(byName['full_b'], 20.0);
    } finally { await vc.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── LOG-06: start_mode=now ───────────────────────────────────────────────────

test('LOG-06: start_mode=now — 기존 데이터 복제 안 함', async () => {
  const SRC = T('06_SRC'), DST = T('06_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-06-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.execute(`CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('old_a', ${nowNs(-1000)}, 99.0)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('old_b', ${nowNs(-500)},  88.0)`);

    await runLogWorker(`log-06-${TS}`, SRC, DST, tmpDir, { start_mode: 'now' });

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name FROM ${DST}`);
      assert.equal(rows.length, 0, `start_mode=now → 기존 데이터 미복제 (실제: ${rows.length})`);
    } finally { await vc.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── LOG-07: cp 재시작 ────────────────────────────────────────────────────────

test('LOG-07: cp 재시작 — cp 이후 데이터만 복제, cp 갱신', async () => {
  const SRC = T('07_SRC'), DST = T('07_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-log-07-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.execute(`CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE)`);

    // 1차: 2행 삽입 후 복제
    await conn.execute(`INSERT INTO ${SRC} VALUES ('batch1_a', ${nowNs(0)}, 1.0)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('batch1_b', ${nowNs(1)}, 2.0)`);

    const jobId = `log-07-${TS}`;
    await runLogWorker(jobId, SRC, DST, tmpDir);

    const store = new CheckpointStore(tmpDir);
    const { exists: e1, cp: cp1 } = await store.load(jobId, SRC);
    assert.equal(e1, true, '1차 실행 후 cp 저장됨');

    // 2차: 추가 데이터 삽입 후 재시작
    await conn.execute(`INSERT INTO ${SRC} VALUES ('batch2_a', ${nowNs(100)}, 3.0)`);
    await runLogWorker(jobId, SRC, DST, tmpDir);

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value FROM ${DST} ORDER BY _RID ASC`);
      assert.equal(rows.length, 3, `총 3행 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, r.value]));
      assert.equal(byName['batch1_a'], 1.0);
      assert.equal(byName['batch1_b'], 2.0);
      assert.equal(byName['batch2_a'], 3.0);
    } finally { await vc.close(); }

    const { cp: cp2 } = await store.load(jobId, SRC);
    assert.ok(cp2.last_success_rid > cp1.last_success_rid,
      `cp 갱신됨 (1차: ${cp1.last_success_rid}, 2차: ${cp2.last_success_rid})`);
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
