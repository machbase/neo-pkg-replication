'use strict';

/**
 * LOG 테이블 통합 테스트
 *
 * 전제 조건:
 *   - 192.168.1.189:5656에 Machbase가 실행 중이어야 함
 *   - SYS/MANAGER 계정으로 접속 가능해야 함
 *
 * 테스트 시나리오:
 *   IT-LOG-01: LOG 테이블 생성 확인 + Reader 읽기
 *   IT-LOG-02: LOG → LOG 복제 (runDataTableWorker, tableType='LOG')
 *   IT-LOG-03: start_mode=full — cp 없을 때 RID 0부터 전체 복제
 *   IT-LOG-04: start_mode=now  — 기존 데이터 복제 안 함
 *   IT-LOG-05: cp 존재 재시작 — STARTUP_INTEGRITY 미수행, 이후 데이터만 복제
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
const CheckpointStore = require('../../file/checkpoint.js');
const { runDataTableWorker } = require('../../worker/worker.js');

// ─── 접속 설정 ────────────────────────────────────────────────────────────────

const DB_CONFIG = {
  host: '192.168.1.189',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

// 테스트별 고유 테이블명 (타임스탬프 포함)
const TS = Date.now();
const T = (suffix) => `REPLI_LOG_${suffix}_${TS}`;

// ─── 잔여 테스트 테이블 정리 ──────────────────────────────────────────────────

test('cleanup: 이전 테스트에서 남은 REPLI_LOG_ 테이블 정리', async () => {
  const conn = new MachbaseClient(DB_CONFIG);
  await conn.connect();
  try {
    const rows = await conn.query(
      `SELECT NAME FROM M$SYS_TABLES WHERE NAME LIKE 'REPLI_LOG_%' ORDER BY NAME`
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

async function createLogTable(conn, name) {
  await execute(conn,
    `CREATE TABLE ${name} (name VARCHAR(64), time DATETIME, value DOUBLE)`
  );
}

async function dropTable(conn, name) {
  try { await execute(conn, `DROP TABLE ${name}`); } catch (_) {}
}

async function insertLogRows(conn, table, rows) {
  for (const r of rows) {
    await execute(conn,
      `INSERT INTO ${table} (name, time, value) VALUES ('${r.name}', ${r.timeNs}, ${r.value})`
    );
  }
}

async function selectAll(conn, table) {
  return conn.query(`SELECT _RID, name, time, value FROM ${table} ORDER BY _RID ASC`);
}

let _nsCounter = 0n;
function nowNs(offsetMs = 0) {
  // 동일 ms 내 중복 방지: 호출마다 1ns씩 증가
  return BigInt(Date.now() + offsetMs) * 1_000_000n + (_nsCounter++);
}

function makeShutdownFlag(timeoutMs = 5000) {
  const flag = { value: false };
  setTimeout(() => { flag.value = true; }, timeoutMs);
  return flag;
}

function baseMapping(srcTable, dstTable, execOverrides = {}) {
  return {
    mapping_id: 'log-test',
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
 * LOG 테이블에 대한 srcTableInfo/dstTableInfo를 빌드하는 헬퍼
 */
async function buildLogTableInfoPair(srcTable, dstTable) {
  const srcConn = await makeConn();
  let srcTableInfo;
  try {
    srcTableInfo = await TableInfo.buildLog(srcConn, srcTable);
  } finally {
    await srcConn.close();
  }
  const dstConn = await makeConn();
  let dstTableInfo;
  try {
    dstTableInfo = await TableInfo.buildLog(dstConn, dstTable);
  } finally {
    await dstConn.close();
  }
  return { srcTableInfo, dstTableInfo };
}

// ─── IT-LOG-01: LOG 테이블 생성 확인 + Reader 읽기 ─────────────────────

describe('IT-LOG-01: LOG 테이블 생성 및 Reader 읽기', () => {
  const SRC = T('01_SRC');
  let conn;

  before(async () => {
    conn = await makeConn();
    await dropTable(conn, SRC);
    await createLogTable(conn, SRC);
    await insertLogRows(conn, SRC, [
      { name: 'sensor_a', timeNs: nowNs(0), value: 1.1 },
      { name: 'sensor_b', timeNs: nowNs(1), value: 2.2 },
      { name: 'sensor_c', timeNs: nowNs(2), value: 3.3 },
    ]);
  });

  after(async () => {
    await dropTable(conn, SRC);
    await conn.close();
  });

  test('M$SYS_TABLES에 TYPE=0(LOG)으로 등록됨', async () => {
    const rows = await conn.query(
      `SELECT NAME, TYPE FROM M$SYS_TABLES WHERE NAME = ?`, [SRC]
    );
    assert.equal(rows.length, 1, '테이블이 존재해야 함');
    assert.equal(rows[0].TYPE, 0, 'LOG 테이블 TYPE 코드는 0');
  });

  test('conn.getTableType → LOG 반환', async () => {
    const { type } = await conn.getTableType(SRC);
    assert.equal(type, 'LOG');
  });

  test('Reader.readAfterRid로 삽입한 3행 읽기', async () => {
    const srcTableInfo = await TableInfo.buildLog(conn, SRC);
    const reader = new Reader(srcTableInfo, conn, SRC);
    const { rows, err } = await reader.readAfterRid(0n, 100);
    assert.equal(err, null, 'readAfterRid 오류 없어야 함');
    assert.equal(rows.length, 3, '3행이 읽혀야 함');

    const names = rows.map(r => r.tagId);
    assert.ok(names.includes('sensor_a'));
    assert.ok(names.includes('sensor_b'));
    assert.ok(names.includes('sensor_c'));

    // row 구조 확인 (새로운 형식: { rid, tagId, data: { TIME, VALUE } })
    const r = rows[0];
    assert.equal(typeof r.rid, 'bigint', 'rid는 BigInt');
    assert.ok(r.tagId !== undefined, 'tagId 필드 존재');
    assert.ok(r.data !== undefined, 'data 필드 존재');
    assert.ok(r.data.TIME !== undefined, 'data.TIME 필드 존재');
    assert.ok(r.data.VALUE !== undefined, 'data.VALUE 필드 존재');
  });

  test('reader.getMaxRid → 삽입한 최대 RID 반환', async () => {
    const srcTableInfo = await TableInfo.buildLog(conn, SRC);
    const reader = new Reader(srcTableInfo, conn, SRC);
    const { maxRid, err } = await reader.getMaxRid();
    assert.equal(err, null);
    assert.ok(maxRid >= 2n, `3행 삽입 후 maxRid >= 2 (실제: ${maxRid})`);
  });
});

// ─── IT-LOG-02: LOG → LOG 복제 ───────────────────────────────────────────────

describe('IT-LOG-02: LOG → LOG 복제 (runDataTableWorker)', () => {
  const SRC = T('02_SRC');
  const DST = T('02_DST');
  let conn;
  let tmpDir;

  before(async () => {
    conn = await makeConn();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-log-02-'));
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await createLogTable(conn, SRC);
    await createLogTable(conn, DST);
    await insertLogRows(conn, SRC, [
      { name: 'machine_temp', timeNs: nowNs(0), value: 72.5 },
      { name: 'machine_rpm',  timeNs: nowNs(1), value: 3200.0 },
      { name: 'machine_vibr', timeNs: nowNs(2), value: 0.42 },
    ]);
  });

  after(async () => {
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('소스 LOG 3행이 대상에 그대로 복제되고 cp가 저장됨', async () => {
    const jobId = `it-log-02-${TS}`;
    const { srcTableInfo, dstTableInfo } = await buildLogTableInfoPair(SRC, DST);
    const srcConn = await makeConn();
    const dstConn = await makeConn();
    const reader = new Reader(srcTableInfo, srcConn, SRC);
    const writer = new Writer(dstTableInfo);
    const openErr = await writer.open(dstConn, DST, srcTableInfo);
    assert.equal(openErr, null, 'Writer.open 성공');

    try {
      await runDataTableWorker({
        jobId,
        mapping: baseMapping(SRC, DST),
        checkpoint: { directory: tmpDir },
        tableType: 'LOG',
        dataTable: SRC,
        srcConfig: DB_CONFIG,
        dstConfig: DB_CONFIG,
        reader: reader,
        writer: writer,
        shutdownFlag: makeShutdownFlag(5000),
      });
    } finally {
      await writer.close();
      await reader.close();
    }

    // 대상 테이블 검증
    const verifyConn = await makeConn();
    try {
      const dstRows = await selectAll(verifyConn, DST);
      assert.equal(dstRows.length, 3, `3행 복제되어야 함 (실제: ${dstRows.length})`);
      const byName = Object.fromEntries(dstRows.map(r => [r.name, r.value]));
      assert.equal(byName['machine_temp'], 72.5, 'machine_temp value 일치');
      assert.equal(byName['machine_rpm'],  3200.0, 'machine_rpm value 일치');
      assert.equal(byName['machine_vibr'], 0.42, 'machine_vibr value 일치');
    } finally {
      await verifyConn.close();
    }

    // 체크포인트 검증
    const store = new CheckpointStore(tmpDir);
    const { cp, exists } = await store.load(jobId, SRC);
    assert.equal(exists, true, 'cp 저장됨');
    assert.ok(cp.last_success_rid > 0n, `last_success_rid > 0 (실제: ${cp.last_success_rid})`);
  });

  test('LOG 테이블은 integrity.enabled=true여도 STARTUP_INTEGRITY 미수행', async () => {
    // IT-LOG-02의 1번 테스트로 cp가 이미 저장된 상태에서 재실행
    // batchExists가 호출된다면 intConn 생성 시 로그가 출력되므로 로그 캡처로 확인
    const jobId = `it-log-02-${TS}`; // 동일 jobId → cp 존재

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(' '));
      origLog(...args);
    };

    const { srcTableInfo: srcTI2, dstTableInfo: dstTI2 } = await buildLogTableInfoPair(SRC, DST);
    const srcConn = await makeConn();
    const dstConn = await makeConn();
    const reader = new Reader(srcTI2, srcConn, SRC);
    const writer = new Writer(dstTI2);
    await writer.open(dstConn, DST, srcTI2);

    try {
      await runDataTableWorker({
        jobId,
        mapping: baseMapping(SRC, DST, { integrity: { enabled: true } }),
        checkpoint: { directory: tmpDir },
        tableType: 'LOG',
        dataTable: SRC,
        srcConfig: DB_CONFIG,
        dstConfig: DB_CONFIG,
        reader: reader,
        writer: writer,
        shutdownFlag: makeShutdownFlag(3000),
      });
    } finally {
      console.log = origLog;
      await writer.close();
      await reader.close();
    }

    const integrityLog = logs.find(l => l.includes('STARTUP_INTEGRITY'));
    assert.ok(integrityLog === undefined,
      'LOG 테이블은 STARTUP_INTEGRITY 로그가 없어야 함');
  });
});

// ─── IT-LOG-03: start_mode=full ──────────────────────────────────────────────

describe('IT-LOG-03: start_mode=full — RID 0부터 전체 복제', () => {
  const SRC = T('03_SRC');
  const DST = T('03_DST');
  let conn;
  let tmpDir;

  before(async () => {
    conn = await makeConn();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-log-03-'));
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await createLogTable(conn, SRC);
    await createLogTable(conn, DST);
    await insertLogRows(conn, SRC, [
      { name: 'full_a', timeNs: nowNs(0), value: 10.0 },
      { name: 'full_b', timeNs: nowNs(1), value: 20.0 },
    ]);
  });

  after(async () => {
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('cp 없음 + start_mode=full → RID 0부터 전체 2행 복제', async () => {
    const jobId = `it-log-03-${TS}`;
    const { srcTableInfo, dstTableInfo } = await buildLogTableInfoPair(SRC, DST);
    const srcConn = await makeConn();
    const dstConn = await makeConn();
    const reader = new Reader(srcTableInfo, srcConn, SRC);
    const writer = new Writer(dstTableInfo);
    await writer.open(dstConn, DST, srcTableInfo);

    try {
      await runDataTableWorker({
        jobId,
        mapping: baseMapping(SRC, DST, { start_mode: 'full' }),
        checkpoint: { directory: tmpDir },
        tableType: 'LOG',
        dataTable: SRC,
        srcConfig: DB_CONFIG,
        dstConfig: DB_CONFIG,
        reader: reader,
        writer: writer,
        shutdownFlag: makeShutdownFlag(5000),
      });
    } finally {
      await writer.close();
      await reader.close();
    }

    const verifyConn = await makeConn();
    try {
      const dstRows = await selectAll(verifyConn, DST);
      assert.equal(dstRows.length, 2, `2행 복제되어야 함 (실제: ${dstRows.length})`);
      const byName = Object.fromEntries(dstRows.map(r => [r.name, r.value]));
      assert.equal(byName['full_a'], 10.0, 'full_a value 일치');
      assert.equal(byName['full_b'], 20.0, 'full_b value 일치');
    } finally {
      await verifyConn.close();
    }
  });
});

// ─── IT-LOG-04: start_mode=now ───────────────────────────────────────────────

describe('IT-LOG-04: start_mode=now — 기존 데이터 복제 안 함', () => {
  const SRC = T('04_SRC');
  const DST = T('04_DST');
  let conn;
  let tmpDir;

  before(async () => {
    conn = await makeConn();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-log-04-'));
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await createLogTable(conn, SRC);
    await createLogTable(conn, DST);
    // "과거" 데이터 삽입
    await insertLogRows(conn, SRC, [
      { name: 'old_data', timeNs: nowNs(-1000), value: 99.0 },
      { name: 'old_data2', timeNs: nowNs(-500), value: 88.0 },
    ]);
  });

  after(async () => {
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('cp 없음 + start_mode=now → 기존 2행 복제 안 함, cp 저장됨', async () => {
    const jobId = `it-log-04-${TS}`;
    const { srcTableInfo, dstTableInfo } = await buildLogTableInfoPair(SRC, DST);
    const srcConn = await makeConn();
    const dstConn = await makeConn();
    const reader = new Reader(srcTableInfo, srcConn, SRC);
    const writer = new Writer(dstTableInfo);
    await writer.open(dstConn, DST, srcTableInfo);

    try {
      await runDataTableWorker({
        jobId,
        mapping: baseMapping(SRC, DST, { start_mode: 'now' }),
        checkpoint: { directory: tmpDir },
        tableType: 'LOG',
        dataTable: SRC,
        srcConfig: DB_CONFIG,
        dstConfig: DB_CONFIG,
        reader: reader,
        writer: writer,
        shutdownFlag: makeShutdownFlag(5000),
      });
    } finally {
      await writer.close();
      await reader.close();
    }

    const verifyConn = await makeConn();
    try {
      const dstRows = await selectAll(verifyConn, DST);
      const names = dstRows.map(r => r.name);
      assert.ok(!names.includes('old_data'),
        `start_mode=now → old_data는 복제되면 안 됨 (실제 names: ${JSON.stringify(names)})`);
      assert.ok(!names.includes('old_data2'),
        `start_mode=now → old_data2는 복제되면 안 됨`);
    } finally {
      await verifyConn.close();
    }

    // start_mode=now에서 이후 새 데이터가 없으면 cp는 저장되지 않음 (정상 동작)
    const store = new CheckpointStore(tmpDir);
    const { exists } = await store.load(jobId, SRC);
    assert.equal(exists, false, 'start_mode=now + 새 데이터 없음 → cp 미저장이 정상');
  });
});

// ─── IT-LOG-05: cp 존재 재시작 ───────────────────────────────────────────────

describe('IT-LOG-05: cp 존재 재시작 — cp 이후 데이터만 복제', () => {
  const SRC = T('05_SRC');
  const DST = T('05_DST');
  let conn;
  let tmpDir;

  before(async () => {
    conn = await makeConn();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repli-it-log-05-'));
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await createLogTable(conn, SRC);
    await createLogTable(conn, DST);
  });

  after(async () => {
    await dropTable(conn, SRC);
    await dropTable(conn, DST);
    await conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('1차 복제 후 재시작 → cp 이후 데이터만 추가 복제됨', async () => {
    const jobId = `it-log-05-${TS}`;
    const store = new CheckpointStore(tmpDir);

    // 1차: 2행 삽입 후 복제
    await insertLogRows(conn, SRC, [
      { name: 'batch1_a', timeNs: nowNs(0), value: 1.0 },
      { name: 'batch1_b', timeNs: nowNs(1), value: 2.0 },
    ]);

    {
      const { srcTableInfo, dstTableInfo } = await buildLogTableInfoPair(SRC, DST);
      const srcConn = await makeConn();
      const dstConn = await makeConn();
      const reader = new Reader(srcTableInfo, srcConn, SRC);
      const writer = new Writer(dstTableInfo);
      await writer.open(dstConn, DST, srcTableInfo);
      try {
        await runDataTableWorker({
          jobId,
          mapping: baseMapping(SRC, DST),
          checkpoint: { directory: tmpDir },
          tableType: 'LOG',
          dataTable: SRC,
          srcConfig: DB_CONFIG,
          dstConfig: DB_CONFIG,
          reader: reader,
          writer: writer,
          shutdownFlag: makeShutdownFlag(3000),
        });
      } finally {
        await writer.close();
        await reader.close();
      }
    }

    const { exists: cp1Exists, cp: cp1 } = await store.load(jobId, SRC);
    assert.equal(cp1Exists, true, '1차 실행 후 cp 저장됨');

    // 2차: 추가 데이터 삽입 후 재시작
    await insertLogRows(conn, SRC, [
      { name: 'batch2_a', timeNs: nowNs(100), value: 3.0 },
    ]);

    {
      const { srcTableInfo: srcTI2, dstTableInfo: dstTI2 } = await buildLogTableInfoPair(SRC, DST);
      const srcConn = await makeConn();
      const dstConn = await makeConn();
      const reader = new Reader(srcTI2, srcConn, SRC);
      const writer = new Writer(dstTI2);
      await writer.open(dstConn, DST, srcTI2);
      try {
        await runDataTableWorker({
          jobId,
          mapping: baseMapping(SRC, DST),
          checkpoint: { directory: tmpDir },
          tableType: 'LOG',
          dataTable: SRC,
          srcConfig: DB_CONFIG,
          dstConfig: DB_CONFIG,
          reader: reader,
          writer: writer,
          shutdownFlag: makeShutdownFlag(3000),
        });
      } finally {
        await writer.close();
        await reader.close();
      }
    }

    // 대상에 총 3행 있어야 함
    const verifyConn = await makeConn();
    try {
      const dstRows = await selectAll(verifyConn, DST);
      assert.equal(dstRows.length, 3, `총 3행이 대상에 있어야 함 (실제: ${dstRows.length})`);
      const byName = Object.fromEntries(dstRows.map(r => [r.name, r.value]));
      assert.equal(byName['batch1_a'], 1.0, 'batch1_a value 일치');
      assert.equal(byName['batch1_b'], 2.0, 'batch1_b value 일치');
      assert.equal(byName['batch2_a'], 3.0, '재시작 후 batch2_a value 일치');
    } finally {
      await verifyConn.close();
    }

    // cp가 갱신되었는지 확인
    const { cp: cp2 } = await store.load(jobId, SRC);
    assert.ok(cp2.last_success_rid > cp1.last_success_rid,
      `cp가 갱신되어야 함 (1차: ${cp1.last_success_rid}, 2차: ${cp2.last_success_rid})`);
  });
});
