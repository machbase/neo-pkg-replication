'use strict';

/**
 * TAG 테이블 통합 테스트
 *
 * 전제 조건:
 *   - 192.168.1.189:5656에 Machbase가 실행 중이어야 함
 *   - SYS/MANAGER 계정으로 접속 가능해야 함
 *
 * Machbase TAG 테이블 컬럼 종류:
 *   - Additional column: CREATE TAG TABLE ... (name, time, value, quality DOUBLE)
 *       DATA 파티션에 함께 저장되는 시계열 측정값
 *   - Metadata column: CREATE TAG TABLE ... (...) METADATA (location VARCHAR(50), ...)
 *       _TAG_META 테이블에 저장되는 센서별 정적 설명 정보
 *       참고: https://docs.machbase.com/dbms/table-types/tag-tables/tag-metadata/
 *
 * 테스트 시나리오:
 *   IT-TAG-01: 동일 스키마 TAG → TAG 복제 (additional/metadata 없음)
 *   IT-TAG-02: SRC에 additional column 존재, DST에는 없음 → NAME/TIME/VALUE만 복제
 *   IT-TAG-03: DST에 additional column 존재, SRC에는 없음 → null 패딩 버그
 *   IT-TAG-04: additional column이 양쪽에 있으나 컬럼명+타입 모두 다름 → null 패딩 버그
 *   IT-TAG-05: SRC에 metadata column 존재, DST에는 없음 → NAME/TIME/VALUE만 복제
 *   IT-TAG-06: DST에 metadata column 존재, SRC에는 없음 → null 패딩 버그
 *   IT-TAG-07: metadata column이 양쪽에 있으나 타입 불일치 → null 패딩 버그
 *
 * 주의: 각 test()는 try/finally로 테이블을 생성/삭제하여 동시에 최대 2개의
 *       테스트용 TAG 테이블만 존재하도록 보장함 (TAG cache exhausted 방지).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs/promises');
const path = require('path');

const { MachbaseClient } = require('../../machbase/machbase.js');
const TableInfo = require('../../machbase/table_info.js');
const Reader = require('../../machbase/reader.js');
const Writer = require('../../machbase/writer.js');
const CheckpointStore = require('../../file/checkpoint.js');
const { runDataTableWorker } = require('../../worker/worker.js');

// ─── 접속 설정 ────────────────────────────────────────────────────────────────

const DB_CONFIG = {
  host: '192.168.1.189',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

const TS = Date.now();
const T = (suffix) => `REPLI_TAG_${suffix}_${TS}`;

// ─── 잔여 테스트 테이블 정리 ──────────────────────────────────────────────────

test('cleanup: 이전 테스트에서 남은 REPLI_TAG_ 테이블 정리', async () => {
  const conn = new MachbaseClient(DB_CONFIG);
  await conn.connect();
  try {
    const rows = await conn.query(
      `SELECT NAME FROM M$SYS_TABLES WHERE NAME LIKE 'REPLI_TAG_%' ORDER BY NAME`
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

/**
 * TAG 테이블 생성
 * @param {MachbaseClient} conn
 * @param {string} name - 논리 테이블명
 * @param {string|null} additionalCols - additional column 정의 (예: 'quality DOUBLE')
 * @param {string|null} metadataCols   - metadata column 정의 (예: 'location VARCHAR(50)')
 */
async function createTagTable(conn, name, additionalCols, metadataCols) {
  const addPart = additionalCols ? ', ' + additionalCols : '';
  const metaPart = metadataCols ? ` METADATA (${metadataCols})` : '';
  await execute(conn,
    `CREATE TAG TABLE ${name} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED${addPart})${metaPart}`
  );
}

/**
 * TAG 테이블에 시계열 데이터 삽입 (appendOpen 사용 — execute INSERT는 DOUBLE 값 손상)
 * @param {MachbaseClient} conn
 * @param {string} table - 논리 테이블명
 * @param {Array<{ name, timeNs, value, extra? }>} rows
 *   extra: { col: 'quality', value: 0.9 } — additional column 값
 */
async function insertTagRows(conn, table, rows) {
  const columns = [
    { name: 'NAME',  type: 'varchar' },
    { name: 'TIME',  type: 'int64'   },
    { name: 'VALUE', type: 'float64' },
  ];
  if (rows.length > 0 && rows[0].extra) {
    columns.push({ name: rows[0].extra.col.toUpperCase(), type: 'float64' });
  }
  const stream = await conn.appendOpen(table, columns);
  const matrix = rows.map(row => {
    const r = [row.name, row.timeNs, row.value];
    if (row.extra) r.push(row.extra.value);
    return r;
  });
  await stream.append(matrix);
  await stream.close();
}

/**
 * TAG 테이블에 metadata 삽입
 * INSERT INTO table METADATA VALUES ('tag_name', meta1, meta2, ...)
 */
async function insertTagMetadata(conn, table, rows) {
  for (const row of rows) {
    if (row.meta && row.meta.length > 0) {
      const metaVals = row.meta.map(v =>
        typeof v === 'string' ? `'${v}'` : v
      ).join(', ');
      await execute(conn,
        `INSERT INTO ${table} METADATA VALUES ('${row.name}', ${metaVals})`
      );
    } else {
      await execute(conn,
        `INSERT INTO ${table} METADATA (name) VALUES ('${row.name}')`
      );
    }
  }
}

async function selectAll(conn, table) {
  return conn.query(`SELECT name, time, value FROM ${table} ORDER BY time ASC`);
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

async function getTagPartitions(conn, logicalTable) {
  return conn.listTagDataTables(logicalTable);
}

function baseMapping(srcTable, dstTable, execOverrides = {}) {
  return {
    mapping_id: 'tag-test',
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

/**
 * TAG 논리 테이블의 모든 파티션에 대해 순차적으로 Worker 실행
 */
async function runTagWorkerForAllPartitions(jobId, srcTable, dstTable, tmpDir, execOverrides = {}) {
  const partConn = await makeConn();
  let partitions;
  let srcTableInfo;
  let dstTableInfo;
  try {
    partitions = await getTagPartitions(partConn, srcTable);
    if (partitions.length === 0) {
      throw new Error(`No partitions found for TAG table ${srcTable}`);
    }
    // 소스 TableInfo 생성 (첫 번째 파티션 기준)
    srcTableInfo = await TableInfo.buildTag(partConn, srcTable, partitions[0].table_id);
  } finally {
    await partConn.close();
  }

  // 대상 TableInfo 생성
  const dstConn0 = await makeConn();
  try {
    const dstPartitions = await getTagPartitions(dstConn0, dstTable);
    if (dstPartitions.length === 0) {
      throw new Error(`No partitions found for TAG table ${dstTable}`);
    }
    dstTableInfo = await TableInfo.buildTag(dstConn0, dstTable, dstPartitions[0].table_id);
  } finally {
    await dstConn0.close();
  }

  for (const part of partitions) {
    const srcConn = await makeConn();
    const dstConn = await makeConn();
    const reader = new Reader(srcTableInfo, srcConn, part.data_table);
    const writer = new Writer(dstTableInfo);
    const openErr = await writer.open(dstConn, dstTable, srcTableInfo);
    assert.equal(openErr, null, `Writer.open for ${part.data_table} should succeed`);

    try {
      await runDataTableWorker({
        jobId,
        mapping: baseMapping(srcTable, dstTable, execOverrides),
        checkpoint: { directory: tmpDir },
        tableType: 'TAG',
        dataTable: part.data_table,
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
}

// ─── IT-TAG-01: 동일 스키마 TAG → TAG 복제 ──────────────────────────────────

test('IT-TAG-01: 동일 스키마 TAG → TAG 복제 — 소스 TAG 3행이 대상에 그대로 복제됨', async () => {
  const SRC = T('01_SRC');
  const DST = T('01_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-tag-01-'));
  try {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await createTagTable(conn, SRC);
    await createTagTable(conn, DST);
    await insertTagRows(conn, SRC, [
      { name: 'sensor_a', timeNs: nowNs(0), value: 1.1 },
      { name: 'sensor_b', timeNs: nowNs(1), value: 2.2 },
      { name: 'sensor_c', timeNs: nowNs(2), value: 3.3 },
    ]);

    const jobId = `it-tag-01-${TS}`;
    await runTagWorkerForAllPartitions(jobId, SRC, DST, tmpDir);

    const verifyConn = await makeConn();
    try {
      const dstRows = await selectAll(verifyConn, DST);
      assert.equal(dstRows.length, 3, `3행 복제되어야 함 (실제: ${dstRows.length})`);
      const byName = Object.fromEntries(dstRows.map(r => [r.name, r.value]));
      assert.equal(byName['sensor_a'], 1.1, 'sensor_a value 일치');
      assert.equal(byName['sensor_b'], 2.2, 'sensor_b value 일치');
      assert.equal(byName['sensor_c'], 3.3, 'sensor_c value 일치');
    } finally {
      await verifyConn.close();
    }

    const partConn = await makeConn();
    try {
      const partitions = await getTagPartitions(partConn, SRC);
      const store = new CheckpointStore(tmpDir);
      for (const part of partitions) {
        const { cp, exists } = await store.load(jobId, part.data_table);
        if (exists) {
          assert.ok(cp.last_success_rid >= 0n, `cp.last_success_rid >= 0 for ${part.data_table}`);
        }
      }
    } finally {
      await partConn.close();
    }
  } finally {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── IT-TAG-02: SRC에 additional column 존재, DST에는 없음 ──────────────────

test('IT-TAG-02: SRC에 additional column (quality) 존재, DST에는 없음 — SRC additional column 무시, 2행 정상 복제됨', async () => {
  const SRC = T('02_SRC');
  const DST = T('02_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-tag-02-'));
  try {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await createTagTable(conn, SRC, 'quality DOUBLE');
    await createTagTable(conn, DST);
    await insertTagRows(conn, SRC, [
      { name: 'temp_sensor',  timeNs: nowNs(0), value: 25.5, extra: { col: 'quality', value: 0.99 } },
      { name: 'press_sensor', timeNs: nowNs(1), value: 101.3, extra: { col: 'quality', value: 0.95 } },
    ]);

    const jobId = `it-tag-02-${TS}`;
    await runTagWorkerForAllPartitions(jobId, SRC, DST, tmpDir);

    const verifyConn = await makeConn();
    try {
      const dstRows = await selectAll(verifyConn, DST);
      assert.equal(dstRows.length, 2, `2행 복제되어야 함 (실제: ${dstRows.length})`);
      const byName = Object.fromEntries(dstRows.map(r => [r.name, r.value]));
      assert.equal(byName['temp_sensor'],  25.5, 'temp_sensor value 일치');
      assert.equal(byName['press_sensor'], 101.3, 'press_sensor value 일치');
    } finally {
      await verifyConn.close();
    }
  } finally {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── IT-TAG-03: DST에 additional column 존재, SRC에는 없음 ──────────────────

test('IT-TAG-03: DST에 additional column (temperature DOUBLE) 존재, SRC에는 없음 — DOUBLE 기본값 패딩, 2행 정상 복제됨', async () => {
  const SRC = T('03_SRC');
  const DST = T('03_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-tag-03-'));
  try {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await createTagTable(conn, SRC);
    await createTagTable(conn, DST, 'temperature DOUBLE');
    await insertTagRows(conn, SRC, [
      { name: 'motor_rpm',  timeNs: nowNs(0), value: 3200.0 },
      { name: 'motor_temp', timeNs: nowNs(1), value: 85.0   },
    ]);

    const jobId = `it-tag-03-${TS}`;
    await runTagWorkerForAllPartitions(jobId, SRC, DST, tmpDir);

    const verifyConn = await makeConn();
    try {
      const dstRows = await verifyConn.query(
        `SELECT name, time, value, temperature FROM ${DST} ORDER BY time ASC`
      );
      assert.equal(dstRows.length, 2, `2행 복제되어야 함 (실제: ${dstRows.length})`);
      const byName = Object.fromEntries(dstRows.map(r => [r.name, r.value]));
      assert.equal(byName['motor_rpm'],  3200.0, 'motor_rpm value 일치');
      assert.equal(byName['motor_temp'], 85.0,   'motor_temp value 일치');
      const tempByName = Object.fromEntries(dstRows.map(r => [r.name, r.temperature]));
      assert.equal(tempByName['motor_rpm'],  0, 'motor_rpm temperature = 0 (safeNull)');
      assert.equal(tempByName['motor_temp'], 0, 'motor_temp temperature = 0 (safeNull)');
    } finally {
      await verifyConn.close();
    }
  } finally {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── IT-TAG-04: additional column이 양쪽에 있으나 컬럼명+타입 모두 다름 ─────

test('IT-TAG-04: additional column 양쪽 다름 (quality DOUBLE vs status VARCHAR) — VARCHAR 기본값 패딩, 2행 정상 복제됨', async () => {
  const SRC = T('04_SRC');
  const DST = T('04_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-tag-04-'));
  try {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await createTagTable(conn, SRC, 'quality DOUBLE');
    await createTagTable(conn, DST, 'status VARCHAR(32)');
    await insertTagRows(conn, SRC, [
      { name: 'valve_pos', timeNs: nowNs(0), value: 45.0,  extra: { col: 'quality', value: 0.88 } },
      { name: 'flow_rate', timeNs: nowNs(1), value: 120.5, extra: { col: 'quality', value: 0.92 } },
    ]);

    const jobId = `it-tag-04-${TS}`;
    await runTagWorkerForAllPartitions(jobId, SRC, DST, tmpDir);

    const verifyConn = await makeConn();
    try {
      const dstRows = await verifyConn.query(
        `SELECT name, time, value, status FROM ${DST} ORDER BY time ASC`
      );
      assert.equal(dstRows.length, 2, `2행 복제되어야 함 (실제: ${dstRows.length})`);
      const byName = Object.fromEntries(dstRows.map(r => [r.name, r.value]));
      assert.equal(byName['valve_pos'],  45.0,  'valve_pos value 일치');
      assert.equal(byName['flow_rate'], 120.5,  'flow_rate value 일치');
      const statusByName = Object.fromEntries(dstRows.map(r => [r.name, r.status]));
      assert.equal(statusByName['valve_pos'],  '', 'valve_pos status = "" (safeNull)');
      assert.equal(statusByName['flow_rate'],  '', 'flow_rate status = "" (safeNull)');
    } finally {
      await verifyConn.close();
    }
  } finally {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── IT-TAG-05: SRC에 metadata column 존재, DST에는 없음 ────────────────────

test('IT-TAG-05: SRC에 metadata column (location) 존재, DST에는 없음 — SRC metadata column은 복제에 영향 없음, 2행 정상 복제됨', async () => {
  const SRC = T('05_SRC');
  const DST = T('05_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-tag-05-'));
  try {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await createTagTable(conn, SRC, null, 'location VARCHAR(50)');
    await createTagTable(conn, DST);

    // metadata 먼저 등록 후 시계열 데이터 삽입
    await insertTagMetadata(conn, SRC, [
      { name: 'building_temp', meta: ['Building A'] },
      { name: 'outdoor_temp',  meta: ['Rooftop']    },
    ]);
    await insertTagRows(conn, SRC, [
      { name: 'building_temp', timeNs: nowNs(0), value: 22.5 },
      { name: 'outdoor_temp',  timeNs: nowNs(1), value: 18.3 },
    ]);

    const jobId = `it-tag-05-${TS}`;
    await runTagWorkerForAllPartitions(jobId, SRC, DST, tmpDir);

    const verifyConn = await makeConn();
    try {
      const dstRows = await selectAll(verifyConn, DST);
      assert.equal(dstRows.length, 2, `2행 복제되어야 함 (실제: ${dstRows.length})`);
      const byName = Object.fromEntries(dstRows.map(r => [r.name, r.value]));
      assert.equal(byName['building_temp'], 22.5, 'building_temp value 일치');
      assert.equal(byName['outdoor_temp'],  18.3, 'outdoor_temp value 일치');
    } finally {
      await verifyConn.close();
    }
  } finally {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── IT-TAG-06: DST에 metadata column 존재, SRC에는 없음 ────────────────────

test('IT-TAG-06: DST에 metadata column (sensor_type VARCHAR) 존재, SRC에는 없음 — VARCHAR 기본값 패딩, 2행 정상 복제됨', async () => {
  const SRC = T('06_SRC');
  const DST = T('06_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-tag-06-'));
  try {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await createTagTable(conn, SRC);
    await createTagTable(conn, DST, null, 'sensor_type VARCHAR(20)');

    await insertTagRows(conn, SRC, [
      { name: 'vibration_1', timeNs: nowNs(0), value: 0.42 },
      { name: 'vibration_2', timeNs: nowNs(1), value: 0.37 },
    ]);

    const jobId = `it-tag-06-${TS}`;
    await runTagWorkerForAllPartitions(jobId, SRC, DST, tmpDir);

    const verifyConn = await makeConn();
    try {
      const dstRows = await selectAll(verifyConn, DST);
      assert.equal(dstRows.length, 2, `2행 복제되어야 함 (실제: ${dstRows.length})`);
      const byName = Object.fromEntries(dstRows.map(r => [r.name, r.value]));
      assert.equal(byName['vibration_1'], 0.42, 'vibration_1 value 일치');
      assert.equal(byName['vibration_2'], 0.37, 'vibration_2 value 일치');
    } finally {
      await verifyConn.close();
    }
  } finally {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── IT-TAG-07: metadata column이 양쪽에 있으나 타입 불일치 ─────────────────

test('IT-TAG-07: metadata column 양쪽에 있으나 타입 불일치 (VARCHAR vs INTEGER) — metadata 타입 불일치는 appendStream에 영향 없음, 2행 정상 복제됨', async () => {
  const SRC = T('07_SRC');
  const DST = T('07_DST');
  const conn = await makeConn();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-tag-07-'));
  try {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await createTagTable(conn, SRC, null, 'location VARCHAR(50)');
    await createTagTable(conn, DST, null, 'location INTEGER');

    await insertTagMetadata(conn, SRC, [
      { name: 'pump_a', meta: ['Zone-1'] },
      { name: 'pump_b', meta: ['Zone-2'] },
    ]);
    await insertTagRows(conn, SRC, [
      { name: 'pump_a', timeNs: nowNs(0), value: 55.5 },
      { name: 'pump_b', timeNs: nowNs(1), value: 66.6 },
    ]);

    const jobId = `it-tag-07-${TS}`;
    await runTagWorkerForAllPartitions(jobId, SRC, DST, tmpDir);

    const verifyConn = await makeConn();
    try {
      const dstRows = await selectAll(verifyConn, DST);
      assert.equal(dstRows.length, 2, `2행 복제되어야 함 (실제: ${dstRows.length})`);
      const byName = Object.fromEntries(dstRows.map(r => [r.name, r.value]));
      assert.equal(byName['pump_a'], 55.5, 'pump_a value 일치');
      assert.equal(byName['pump_b'], 66.6, 'pump_b value 일치');
    } finally {
      await verifyConn.close();
    }
  } finally {
    await dropTable(conn, DST);
    await dropTable(conn, SRC);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
