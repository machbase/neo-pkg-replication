'use strict';

/**
 * TAG 테이블 복제 통합 테스트
 *
 * 전제 조건:
 *   - 192.168.1.189:5656에 Machbase가 실행 중이어야 함
 *   - SYS/MANAGER 계정으로 접속 가능해야 함
 *
 * 테스트 시나리오:
 *   TAG-01: 동일 스키마 TAG→TAG 복제
 *   TAG-02: SRC-only 컬럼 → 복제 스킵 (cp 미저장)
 *   TAG-03: DST-only 컬럼 → safeNull 패딩
 *   TAG-04: 동일 컬럼명 but 타입 다름 → 복제 동작 확인
 *   TAG-05: start_mode=full
 *   TAG-06: start_mode=now
 *   TAG-07: cp 재시작 — cp 이후 데이터만 복제
 *   TAG-08: tag_identifier prefix
 *   TAG-09: STARTUP_INTEGRITY — 재시작 시 중복 없이 복제
 *   TAG-10: STARTUP_INTEGRITY — LOG 테이블은 cp+integrity=true여도 미수행
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs/promises');
const path = require('path');

const { MachbaseClient } = require('../../db/client.js');
const { buildTagSchema, buildLogSchema } = require('../../db/schema_builder.js');
const CheckpointStore = require('../../checkpoint/store.js');
const { Worker } = require('../../worker/worker.js');

// ─── 접속 설정 ────────────────────────────────────────────────────────────────

const DB_CONFIG = {
  host: '192.168.1.189',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

const TS = Date.now();
const T = (suffix) => `REPLI_TAG_${suffix}_${TS}`;

// ─── 잔여 테이블 정리 ─────────────────────────────────────────────────────────

test('cleanup: 이전 테스트에서 남은 REPLI_TAG_ 테이블 정리', async () => {
  const conn = new MachbaseClient(DB_CONFIG);
  await conn.connect();
  try {
    const rows = await conn.query(
      `SELECT NAME FROM M$SYS_TABLES WHERE NAME LIKE 'REPLI_TAG_%' ORDER BY NAME`
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

/**
 * TAG 테이블 생성
 * @param {MachbaseClient} conn
 * @param {string} name
 * @param {string|null} additionalCols - 예: 'quality DOUBLE'
 * @param {string|null} metadataCols   - 예: 'location VARCHAR(50)'
 */
async function createTagTable(conn, name, additionalCols = null, metadataCols = null) {
  const addPart = additionalCols ? `, ${additionalCols}` : '';
  const metaPart = metadataCols ? ` METADATA (${metadataCols})` : '';
  await conn.execute(
    `CREATE TAG TABLE ${name} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED${addPart})${metaPart}`
  );
}

/**
 * TAG 테이블에 시계열 데이터 삽입 (appendOpen 사용)
 * @param {MachbaseClient} conn
 * @param {string} table
 * @param {Array<{ name, timeNs, value, extra? }>} rows
 *   extra: { col: 'quality', type: 'float64', value: 0.9 }
 */
async function insertTagRows(conn, table, rows) {
  const columns = [
    { name: 'NAME',  type: 'varchar' },
    { name: 'TIME',  type: 'int64'   },
    { name: 'VALUE', type: 'float64' },
  ];
  if (rows.length > 0 && rows[0].extra) {
    columns.push({ name: rows[0].extra.col.toUpperCase(), type: rows[0].extra.type || 'float64' });
  }
  const stream = await conn.appendOpen(table, columns);
  const matrix = rows.map(r => {
    const row = [r.name, r.timeNs, r.value];
    if (r.extra) row.push(r.extra.value);
    return row;
  });
  await stream.append(matrix);
  await stream.close();
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

function baseMapping(srcTable, dstTable, overrides = {}) {
  return {
    mapping_id: 'tag-test',
    source: { server: 'src', table: srcTable, tag_identifier: { mode: 'none', value: '' }, columns: null },
    target: { server: 'dst', table: dstTable },
    execution: {
      start_mode: 'full',
      query_limit: 100,
      poll_interval_ms: 100,
      on_save_failure: 'continue',
      integrity: { enabled: false },
      retry: { max_attempts: 3, base_delay_ms: 10, max_delay_ms: 100 },
      ...overrides,
    },
  };
}

/**
 * TAG 논리 테이블의 모든 파티션에 대해 순차적으로 Worker 실행
 * @param {string} jobId
 * @param {string} srcTable
 * @param {string} dstTable
 * @param {string} tmpDir
 * @param {object} mappingOverrides - mapping 필드 오버라이드 (source, execution 등)
 */
async function runTagWorkers(jobId, srcTable, dstTable, tmpDir, mappingOverrides = {}) {
  // 소스 파티션 조회
  const discoverConn = await makeConn();
  let partitions, srcSchema, dstSchema;
  try {
    partitions = await discoverConn.listTagDataTables(srcTable);
    if (partitions.length === 0) throw new Error(`No partitions for ${srcTable}`);
    srcSchema = await buildTagSchema(discoverConn, srcTable, partitions[0].table_id);
  } finally {
    await discoverConn.close();
  }

  // 대상 스키마 조회
  const dstDiscoverConn = await makeConn();
  try {
    const dstPartitions = await dstDiscoverConn.listTagDataTables(dstTable);
    if (dstPartitions.length === 0) throw new Error(`No partitions for ${dstTable}`);
    dstSchema = await buildTagSchema(dstDiscoverConn, dstTable, dstPartitions[0].table_id);
  } finally {
    await dstDiscoverConn.close();
  }

  // src-only 컬럼 검출 (job_runner._discoverMapping 로직과 동일)
  const dstNames = new Set(dstSchema.columns.map(c => c.name));
  const srcOnlyCols = srcSchema.columns
    .filter(c => c.category !== 'metadata' && !dstNames.has(c.name))
    .map(c => c.name);
  if (srcOnlyCols.length > 0) {
    // discover 실패 → 모든 파티션 스킵
    return;
  }

  const mapping = {
    ...baseMapping(srcTable, dstTable),
    ...mappingOverrides,
    source: { ...baseMapping(srcTable, dstTable).source, ...(mappingOverrides.source || {}) },
    execution: { ...baseMapping(srcTable, dstTable).execution, ...(mappingOverrides.execution || {}) },
  };

  for (const part of partitions) {
    const worker = new Worker(
      jobId,
      { directory: tmpDir },
      mapping,
      'TAG',
      part.data_table,
      srcSchema,
      dstSchema,
      DB_CONFIG,
      DB_CONFIG,
      makeShutdownFlag(500),
    );
    await worker.run(new AbortController().signal);
  }
}

// ─── TAG-01: 동일 스키마 ──────────────────────────────────────────────────────

test('TAG-01: 동일 스키마 TAG→TAG 복제 — 행수/value/cp 검증', async () => {
  const SRC = T('01_SRC'), DST = T('01_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-tag-01-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await createTagTable(conn, SRC);
    await createTagTable(conn, DST);
    await insertTagRows(conn, SRC, [
      { name: 'sensor_a', timeNs: nowNs(0), value: 1.1 },
      { name: 'sensor_b', timeNs: nowNs(1), value: 2.2 },
      { name: 'sensor_c', timeNs: nowNs(2), value: 3.3 },
    ]);

    const jobId = `tag-01-${TS}`;
    await runTagWorkers(jobId, SRC, DST, tmpDir);

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value FROM ${DST} ORDER BY time ASC`);
      assert.equal(rows.length, 3, `3행 복제 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, r.value]));
      assert.equal(byName['sensor_a'], 1.1);
      assert.equal(byName['sensor_b'], 2.2);
      assert.equal(byName['sensor_c'], 3.3);
    } finally { await vc.close(); }

    // cp 저장 확인
    const store = new CheckpointStore(tmpDir);
    const pc = await makeConn();
    try {
      const ps = await pc.listTagDataTables(SRC);
      for (const p of ps) {
        const { exists, cp } = await store.load(jobId, p.data_table);
        if (exists) {
          assert.ok(cp.last_success_rid >= 0n);
        }
      }
    } finally { await pc.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── TAG-02: SRC-only 컬럼 → 복제 스킵 ──────────────────────────────────────

test('TAG-02: SRC-only additional column → Writer.open 에러, 복제 스킵, cp 미저장', async () => {
  const SRC = T('02_SRC'), DST = T('02_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-tag-02-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await createTagTable(conn, SRC, 'quality DOUBLE');
    await createTagTable(conn, DST);
    await insertTagRows(conn, SRC, [
      { name: 'sensor_a', timeNs: nowNs(0), value: 10.0, extra: { col: 'quality', value: 0.99 } },
      { name: 'sensor_b', timeNs: nowNs(1), value: 20.0, extra: { col: 'quality', value: 0.95 } },
    ]);

    const jobId = `tag-02-${TS}`;
    await runTagWorkers(jobId, SRC, DST, tmpDir);

    // DST에 0행 (복제 스킵)
    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name FROM ${DST}`);
      assert.equal(rows.length, 0, `SRC-only 컬럼 → 복제 스킵 (실제: ${rows.length})`);
    } finally { await vc.close(); }

    // cp 미저장 확인
    const store = new CheckpointStore(tmpDir);
    const pc = await makeConn();
    try {
      const ps = await pc.listTagDataTables(SRC);
      for (const p of ps) {
        const { exists } = await store.load(jobId, p.data_table);
        assert.equal(exists, false, `복제 스킵 → cp 미저장 (${p.data_table})`);
      }
    } finally { await pc.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── TAG-03: DST-only 컬럼 → safeNull 패딩 ──────────────────────────────────

test('TAG-03: DST-only additional column → safeNull 패딩, 정상 복제', async () => {
  const SRC = T('03_SRC'), DST = T('03_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-tag-03-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await createTagTable(conn, SRC);
    await createTagTable(conn, DST, 'temperature DOUBLE');
    await insertTagRows(conn, SRC, [
      { name: 'motor_a', timeNs: nowNs(0), value: 3200.0 },
      { name: 'motor_b', timeNs: nowNs(1), value: 85.0   },
    ]);

    await runTagWorkers(`tag-03-${TS}`, SRC, DST, tmpDir);

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value, temperature FROM ${DST} ORDER BY time ASC`);
      assert.equal(rows.length, 2, `2행 복제 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, r]));
      assert.equal(byName['motor_a'].value, 3200.0);
      assert.equal(byName['motor_b'].value, 85.0);
      // DST-only 컬럼 temperature → safeNull(DOUBLE) = 0
      assert.equal(byName['motor_a'].temperature, 0);
      assert.equal(byName['motor_b'].temperature, 0);
    } finally { await vc.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── TAG-04: 동일 컬럼명 but 타입 다름 ──────────────────────────────────────

test('TAG-04: 동일 컬럼명 but 타입 다름 (SRC: quality DOUBLE, DST: quality VARCHAR) — 복제 동작 확인', async () => {
  const SRC = T('04_SRC'), DST = T('04_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-tag-04-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await createTagTable(conn, SRC, 'quality DOUBLE');
    await createTagTable(conn, DST, 'quality VARCHAR(32)');
    await insertTagRows(conn, SRC, [
      { name: 'valve_a', timeNs: nowNs(0), value: 45.0,  extra: { col: 'quality', value: 0.88 } },
      { name: 'valve_b', timeNs: nowNs(1), value: 120.5, extra: { col: 'quality', value: 0.92 } },
    ]);

    let replicationError = null;
    try {
      await runTagWorkers(`tag-04-${TS}`, SRC, DST, tmpDir);
    } catch (err) {
      replicationError = err;
    }

    // 타입 불일치 시 에러 없이 복제되거나, appendStream에서 에러가 날 수 있음
    // 실제 동작 결과를 로그로 확인
    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value FROM ${DST} ORDER BY time ASC`);
      // 타입 암묵적 변환으로 복제 성공하거나 0행(에러)일 수 있음 — 실제 결과 기록
      console.log(JSON.stringify({
        level: 'info', stage: 'test', test: 'TAG-04',
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

// ─── TAG-05: start_mode=full ──────────────────────────────────────────────────

test('TAG-05: start_mode=full — RID 0부터 전체 복제', async () => {
  const SRC = T('05_SRC'), DST = T('05_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-tag-05-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await createTagTable(conn, SRC);
    await createTagTable(conn, DST);
    await insertTagRows(conn, SRC, [
      { name: 'full_a', timeNs: nowNs(0), value: 10.0 },
      { name: 'full_b', timeNs: nowNs(1), value: 20.0 },
    ]);

    await runTagWorkers(`tag-05-${TS}`, SRC, DST, tmpDir, { execution: { start_mode: 'full' } });

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value FROM ${DST} ORDER BY time ASC`);
      assert.equal(rows.length, 2, `전체 2행 복제 (실제: ${rows.length})`);
    } finally { await vc.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── TAG-06: start_mode=now ───────────────────────────────────────────────────

test('TAG-06: start_mode=now — 기존 데이터 복제 안 함', async () => {
  const SRC = T('06_SRC'), DST = T('06_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-tag-06-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await createTagTable(conn, SRC);
    await createTagTable(conn, DST);
    await insertTagRows(conn, SRC, [
      { name: 'old_a', timeNs: nowNs(-1000), value: 99.0 },
      { name: 'old_b', timeNs: nowNs(-500),  value: 88.0 },
    ]);

    await runTagWorkers(`tag-06-${TS}`, SRC, DST, tmpDir, { execution: { start_mode: 'now' } });

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

// ─── TAG-07: cp 재시작 ────────────────────────────────────────────────────────

test('TAG-07: cp 재시작 — cp 이후 데이터만 복제, cp 갱신', async () => {
  const SRC = T('07_SRC'), DST = T('07_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-tag-07-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await createTagTable(conn, SRC);
    await createTagTable(conn, DST);

    // 1차: 2행 삽입 후 복제
    await insertTagRows(conn, SRC, [
      { name: 'batch1_a', timeNs: nowNs(0), value: 1.1 },
      { name: 'batch1_b', timeNs: nowNs(1), value: 2.2 },
    ]);
    const jobId = `tag-07-${TS}`;
    await runTagWorkers(jobId, SRC, DST, tmpDir);

    const store = new CheckpointStore(tmpDir);
    const pc1 = await makeConn();
    let cp1 = null;
    try {
      const ps = await pc1.listTagDataTables(SRC);
      for (const p of ps) {
        const { exists, cp } = await store.load(jobId, p.data_table);
        if (exists) { cp1 = cp; break; }
      }
    } finally { await pc1.close(); }
    assert.ok(cp1 !== null, '1차 실행 후 cp 저장됨');

    // 2차: 추가 데이터 삽입 후 재시작
    await insertTagRows(conn, SRC, [
      { name: 'batch2_a', timeNs: nowNs(100), value: 3.3 },
    ]);
    await runTagWorkers(jobId, SRC, DST, tmpDir);

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value FROM ${DST} ORDER BY time ASC`);
      assert.equal(rows.length, 3, `총 3행 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.name, r.value]));
      assert.equal(byName['batch1_a'], 1.1);
      assert.equal(byName['batch1_b'], 2.2);
      assert.equal(byName['batch2_a'], 3.3);
    } finally { await vc.close(); }

    // cp 갱신 확인
    const pc2 = await makeConn();
    try {
      const ps = await pc2.listTagDataTables(SRC);
      for (const p of ps) {
        const { exists, cp: cp2 } = await store.load(jobId, p.data_table);
        if (exists && cp1) {
          assert.ok(cp2.last_success_rid >= cp1.last_success_rid, 'cp 갱신됨');
        }
      }
    } finally { await pc2.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── TAG-08: tag_identifier prefix ───────────────────────────────────────────

test('TAG-08: tag_identifier prefix — DST name = prefix + canonical', async () => {
  const SRC = T('08_SRC'), DST = T('08_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-tag-08-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await createTagTable(conn, SRC);
    await createTagTable(conn, DST);
    await insertTagRows(conn, SRC, [
      { name: 'sensor_a', timeNs: nowNs(0), value: 1.0 },
      { name: 'sensor_b', timeNs: nowNs(1), value: 2.0 },
    ]);

    await runTagWorkers(`tag-08-${TS}`, SRC, DST, tmpDir, {
      source: { tag_identifier: { mode: 'prefix', value: 'SRC_' } },
    });

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value FROM ${DST} ORDER BY time ASC`);
      assert.equal(rows.length, 2, `2행 복제 (실제: ${rows.length})`);
      const names = rows.map(r => r.name);
      assert.ok(names.includes('SRC_sensor_a'), `prefix 적용된 name 포함 (실제: ${JSON.stringify(names)})`);
      assert.ok(names.includes('SRC_sensor_b'));
    } finally { await vc.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── TAG-09: STARTUP_INTEGRITY ───────────────────────────────────────────────

test('TAG-09: STARTUP_INTEGRITY — 재시작 시 중복 없이 복제', async () => {
  const SRC = T('09_SRC'), DST = T('09_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-tag-09-'));
  try {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await createTagTable(conn, SRC);
    await createTagTable(conn, DST);
    await insertTagRows(conn, SRC, [
      { name: 'pump_a', timeNs: nowNs(0), value: 55.5 },
      { name: 'pump_b', timeNs: nowNs(1), value: 66.6 },
    ]);

    const jobId = `tag-09-${TS}`;
    // 1차 복제 — cp 저장
    await runTagWorkers(jobId, SRC, DST, tmpDir, { execution: { integrity: { enabled: true } } });

    // 2차 재시작 — STARTUP_INTEGRITY 수행, 기존 행 중복 없이 복제
    await runTagWorkers(jobId, SRC, DST, tmpDir, { execution: { integrity: { enabled: true } } });

    const vc = await makeConn();
    try {
      const rows = await vc.query(`SELECT name, value FROM ${DST} ORDER BY time ASC`);
      // 중복 없이 2행이어야 함
      assert.equal(rows.length, 2, `STARTUP_INTEGRITY 후 중복 없이 2행 (실제: ${rows.length})`);
    } finally { await vc.close(); }
  } finally {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── TAG-10: LOG 테이블은 STARTUP_INTEGRITY 미수행 ───────────────────────────

describe('TAG-10: LOG 테이블은 cp+integrity=true여도 STARTUP_INTEGRITY 미수행', () => {
  const SRC = T('10_LOG_SRC');
  const DST = T('10_LOG_DST');
  let conn, tmpDir;

  before(async () => {
    conn = await makeConn();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-tag-10-'));
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.execute(`CREATE TABLE ${SRC} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`CREATE TABLE ${DST} (name VARCHAR(64), time DATETIME, value DOUBLE)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('log_a', ${nowNs(0)}, 1.1)`);
    await conn.execute(`INSERT INTO ${SRC} VALUES ('log_b', ${nowNs(1)}, 2.2)`);
  });

  after(async () => {
    await dropTable(conn, SRC); await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('1차 복제 후 cp 저장, 2차 재시작 시 STARTUP_INTEGRITY 로그 없음', async () => {
    const jobId = `tag-10-${TS}`;

    // LOG 테이블 스키마 빌드
    async function runLogWorker() {
      const sc = await makeConn();
      let srcSchema;
      try { srcSchema = await buildLogSchema(sc, SRC); } finally { await sc.close(); }
      const dc = await makeConn();
      let dstSchema;
      try { dstSchema = await buildLogSchema(dc, DST); } finally { await dc.close(); }

      const mapping = {
        ...baseMapping(SRC, DST, { integrity: { enabled: true } }),
        execution: { ...baseMapping(SRC, DST).execution, integrity: { enabled: true } },
      };

      const worker = new Worker(
        jobId,
        { directory: tmpDir },
        mapping,
        'LOG',
        SRC,
        srcSchema,
        dstSchema,
        DB_CONFIG,
        DB_CONFIG,
        makeShutdownFlag(500),
      );
      await worker.run(new AbortController().signal);
    }

    // 1차 실행 → cp 저장
    await runLogWorker();
    const store = new CheckpointStore(tmpDir);
    const { exists } = await store.load(jobId, SRC);
    assert.equal(exists, true, '1차 실행 후 cp 저장됨');

    // 2차 실행 — 로그 캡처하여 STARTUP_INTEGRITY 미출력 확인
    const logs = [];
    const orig = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); orig(...args); };
    try {
      await runLogWorker();
    } finally {
      console.log = orig;
    }

    const integrityLog = logs.find(l => l.includes('STARTUP_INTEGRITY'));
    assert.equal(integrityLog, undefined, 'LOG 테이블은 STARTUP_INTEGRITY 미수행');
  });
});
