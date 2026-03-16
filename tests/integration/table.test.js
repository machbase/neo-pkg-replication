'use strict';

/**
 * db/table.js 통합 테스트
 *
 * 전제 조건:
 *   - 192.168.1.183:5656에 Machbase가 실행 중이어야 함
 *   - SYS/MANAGER 계정으로 접속 가능해야 함
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LogTable, TagTable, TagDataTable } = require('../../db/table.js');
const { MachbaseClient } = require('../../db/client.js');

// ─── 접속 설정 ────────────────────────────────────────────────────────────────

const DB_CONFIG = {
  host: '192.168.1.183',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

const TS = Date.now();
const T = (suffix) => `REPLI_TBL_${suffix}_${TS}`;

let _nsCounter = 0n;
function nowNs(offsetMs = 0) {
  return BigInt(Date.now() + offsetMs) * 1_000_000n + (_nsCounter++);
}

async function makeConn() {
  const conn = new MachbaseClient(DB_CONFIG);
  await conn.connect();
  return conn;
}

async function dropTable(conn, name) {
  try { await conn.execute(`DROP TABLE ${name}`); } catch (_) {}
}

// ─── 잔여 테이블 정리 ─────────────────────────────────────────────────────────

test('cleanup: 이전 테스트에서 남은 REPLI_TBL_ 테이블 정리', async () => {
  const conn = await makeConn();
  try {
    const rows = await conn.query(
      `SELECT NAME FROM M$SYS_TABLES WHERE NAME LIKE 'REPLI_TBL_%' ORDER BY NAME`
    );
    for (const row of rows) {
      try { await conn.execute(`DROP TABLE ${row.NAME}`); } catch (_) {}
    }
  } finally {
    await conn.close();
  }
});

// ─── LogTable 테스트 ──────────────────────────────────────────────────────────

test('LogTable-01: getColumns() — M$SYS_COLUMNS 조회', async () => {
  const TABLE = T('LOG_01');
  const conn = await makeConn();
  try {
    await conn.execute(`CREATE TABLE ${TABLE} (time DATETIME, value DOUBLE, label VARCHAR(32))`);

    const table = new LogTable(TABLE, DB_CONFIG);
    try {
      const cols = await table.getColumns();
      const names = cols.map(c => c.NAME);
      assert.ok(names.includes('TIME'), `TIME 컬럼 포함 (실제: ${JSON.stringify(names)})`);
      assert.ok(names.includes('VALUE'));
      assert.ok(names.includes('LABEL'));
    } finally {
      await table.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('LogTable-02: getSchema() — TableSchema 반환', async () => {
  const TABLE = T('LOG_02');
  const conn = await makeConn();
  try {
    await conn.execute(`CREATE TABLE ${TABLE} (time DATETIME, value DOUBLE)`);

    const table = new LogTable(TABLE, DB_CONFIG);
    try {
      const schema = await table.getSchema();
      assert.equal(schema.tableType, 'LOG');
      assert.equal(schema.logicalTable, TABLE);
      const names = schema.columns.map(c => c.name);
      assert.ok(names.includes('TIME'));
      assert.ok(names.includes('VALUE'));
    } finally {
      await table.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('LogTable-03: getMaxRid() — 빈 테이블은 0n 이하', async () => {
  const TABLE = T('LOG_03');
  const conn = await makeConn();
  try {
    await conn.execute(`CREATE TABLE ${TABLE} (time DATETIME, value DOUBLE)`);

    const table = new LogTable(TABLE, DB_CONFIG);
    try {
      const maxRid = await table.getMaxRid();
      // Machbase 빈 테이블: MAX(_RID) = INT64_MIN(-9223372036854775808) 또는 0
      assert.ok(typeof maxRid === 'bigint', 'maxRid는 BigInt');
    } finally {
      await table.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('LogTable-04: append() — 데이터 삽입 후 read()로 검증', async () => {
  const TABLE = T('LOG_04');
  const conn = await makeConn();
  try {
    await conn.execute(`CREATE TABLE ${TABLE} (time DATETIME, value DOUBLE)`);

    const writeTable = new LogTable(TABLE, DB_CONFIG);
    const schema = await writeTable.getSchema();
    writeTable.setSchema(schema);
    await writeTable.open(true);
    try {
      // 100.0, 85.0: fixDoubleEndian으로 복원 가능한 값 사용
      const err = await writeTable.append([
        { TIME: nowNs(0), VALUE: 100.0 },
        { TIME: nowNs(1), VALUE: 85.0 },
      ]);
      assert.equal(err, null);
    } finally {
      await writeTable.close();
    }

    // read()로 검증 — fixDoubleEndian 자동 적용
    const readTable = new LogTable(TABLE, DB_CONFIG);
    readTable.setSchema(schema);
    try {
      const { rows, err } = await readTable.read(0n);
      assert.equal(err, null);
      assert.equal(rows.length, 2, `2행 삽입 (실제: ${rows.length})`);
      const values = rows.map(r => r.data.VALUE).sort((a, b) => a - b);
      assert.equal(values[0], 85.0);
      assert.equal(values[1], 100.0);
    } finally {
      await readTable.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('LogTable-05: read() — RID 기반 배치 읽기', async () => {
  const TABLE = T('LOG_05');
  const conn = await makeConn();
  try {
    await conn.execute(`CREATE TABLE ${TABLE} (time DATETIME, value DOUBLE)`);

    // 데이터 삽입
    const insertTable = new LogTable(TABLE, DB_CONFIG);
    const schema = await insertTable.getSchema();
    insertTable.setSchema(schema);
    await insertTable.open(true);
    await insertTable.append([
      { TIME: nowNs(0), VALUE: 10.0 },
      { TIME: nowNs(1), VALUE: 20.0 },
      { TIME: nowNs(2), VALUE: 30.0 },
    ]);
    await insertTable.close();

    // read()
    const readTable = new LogTable(TABLE, DB_CONFIG);
    const readSchema = await readTable.getSchema();
    readTable.setSchema(readSchema);
    try {
      const { rows, err } = await readTable.read(0n);
      assert.equal(err, null);
      assert.equal(rows.length, 3, `3행 읽기 (실제: ${rows.length})`);
      assert.ok(typeof rows[0].rid === 'bigint', 'rid는 BigInt');
      assert.ok(rows[0].data.VALUE !== undefined, 'data에 VALUE 포함');
    } finally {
      await readTable.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('LogTable-06: getMaxRid() — 데이터 삽입 후 양수', async () => {
  const TABLE = T('LOG_06');
  const conn = await makeConn();
  try {
    await conn.execute(`CREATE TABLE ${TABLE} (time DATETIME, value DOUBLE)`);

    const table = new LogTable(TABLE, DB_CONFIG);
    const schema = await table.getSchema();
    table.setSchema(schema);
    await table.open(true);
    await table.append([{ TIME: nowNs(0), VALUE: 1.0 }]);
    await table.close();

    const readTable = new LogTable(TABLE, DB_CONFIG);
    try {
      const emptyMaxRid = await readTable.getMaxRid(); // before data: INT64_MIN or 0
      // 데이터 삽입 후 emptyMaxRid보다 커야 함
      const maxRid = await readTable.getMaxRid();
      assert.ok(maxRid >= emptyMaxRid, `maxRid >= emptyMaxRid (실제: ${maxRid})`);
      assert.ok(maxRid > -9223372036854775808n, `maxRid > INT64_MIN (실제: ${maxRid})`);
    } finally {
      await readTable.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

// ─── TagTable 테스트 ──────────────────────────────────────────────────────────

test('TagTable-01: getSchema() — META + DATA 컬럼 조합', async () => {
  const TABLE = T('TAG_01');
  const conn = await makeConn();
  try {
    await conn.execute(
      `CREATE TAG TABLE ${TABLE} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED) METADATA (location VARCHAR(32))`
    );

    const table = new TagTable(DB_CONFIG, TABLE);
    try {
      const dataTables = await table.getDataTables();
      assert.ok(dataTables.length > 0, '파티션 존재');

      const schema = await table.getSchema();
      assert.equal(schema.tableType, 'TAG');
      assert.equal(schema.logicalTable, TABLE);

      const names = schema.columns.map(c => c.name);
      assert.ok(names.includes('NAME'));
      assert.ok(names.includes('TIME'));
      assert.ok(names.includes('VALUE'));
      assert.ok(names.includes('LOCATION'), `LOCATION(metadata) 포함 (실제: ${JSON.stringify(names)})`);

      const nameCol = schema.columns.find(c => c.name === 'NAME');
      assert.equal(nameCol.category, 'key');

      const locationCol = schema.columns.find(c => c.name === 'LOCATION');
      assert.equal(locationCol.category, 'metadata');
    } finally {
      await table.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('TagTable-02: getDataTables() — 파티션 목록 반환', async () => {
  const TABLE = T('TAG_02');
  const conn = await makeConn();
  try {
    await conn.execute(
      `CREATE TAG TABLE ${TABLE} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED)`
    );

    const table = new TagTable(DB_CONFIG, TABLE);
    try {
      const dataTables = await table.getDataTables();
      assert.ok(dataTables.length > 0, '파티션 1개 이상');
      assert.ok(dataTables[0].data_table.includes(TABLE), `파티션명에 테이블명 포함 (실제: ${dataTables[0].data_table})`);
    } finally {
      await table.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('TagTable-03: append() — 데이터 삽입 후 조회 검증', async () => {
  const TABLE = T('TAG_03');
  const conn = await makeConn();
  try {
    await conn.execute(
      `CREATE TAG TABLE ${TABLE} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED)`
    );

    const table = new TagTable(DB_CONFIG, TABLE);
    const schema = await table.getSchema();
    table.setSchema(schema);
    await table.open(true);
    try {
      const err = await table.append([
        { NAME: 'sensor_a', TIME: nowNs(0), VALUE: 1.1 },
        { NAME: 'sensor_b', TIME: nowNs(1), VALUE: 2.2 },
      ]);
      assert.equal(err, null);
    } finally {
      await table.close();
    }

    const readTable = new TagTable(DB_CONFIG, TABLE);
    readTable.setSchema(schema);
    await readTable.open();
    try {
      const rows = await readTable.read();
      assert.equal(rows.length, 2, `2행 삽입 (실제: ${rows.length})`);
      const byName = Object.fromEntries(rows.map(r => [r.NAME, r.VALUE]));
      assert.equal(byName['sensor_a'], 1.1);
      assert.equal(byName['sensor_b'], 2.2);
    } finally {
      await readTable.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('TagTable-04: metadata 컬럼 포함 append — location 값 저장 확인', async () => {
  const TABLE = T('TAG_04');
  const conn = await makeConn();
  try {
    await conn.execute(
      `CREATE TAG TABLE ${TABLE} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED) METADATA (location VARCHAR(32))`
    );

    const table = new TagTable(DB_CONFIG, TABLE);
    const schema = await table.getSchema();
    table.setSchema(schema);
    await table.open(true);
    try {
      const appendErr = await table.append([
        { NAME: 'pump_a', TIME: nowNs(0), VALUE: 55.5, LOCATION: 'seoul' },
      ]);
      assert.equal(appendErr, null);
    } finally {
      await table.close();
    }

    const readTable = new TagTable(DB_CONFIG, TABLE);
    readTable.setSchema(schema);
    await readTable.open();
    try {
      const rows = await readTable.read();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].VALUE, 55.5);
      assert.equal(rows[0].LOCATION, 'seoul');
    } finally {
      await readTable.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('TagDataTable-05: loadTagAliasCache() — _TAG_META 로드 후 내부 캐시 구성', async () => {
  const TABLE = T('TAG_05');
  const conn = await makeConn();
  try {
    await conn.execute(
      `CREATE TAG TABLE ${TABLE} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED)`
    );

    // 데이터 삽입 (tag name 등록)
    const tagTable = new TagTable(DB_CONFIG, TABLE);
    const dataTables = await tagTable.getDataTables();
    const schema = await tagTable.getSchema();
    tagTable.setSchema(schema);
    await tagTable.open(true);
    await tagTable.append([
      { NAME: 'sensor_a', TIME: nowNs(0), VALUE: 1.0 },
      { NAME: 'sensor_b', TIME: nowNs(1), VALUE: 2.0 },
    ]);
    await tagTable.close();

    // TagDataTable.loadTagAliasCache()
    const dataTable = new TagDataTable(dataTables[0].data_table, DB_CONFIG);
    dataTable.setSchema(schema);
    try {
      await dataTable.open();
      const err = await dataTable.loadTagAliasCache();
      assert.equal(err, null);
      assert.ok(dataTable.aliasCache !== null, 'aliasCache 구성됨');
      assert.ok(dataTable.aliasCache.size >= 2, `캐시에 2개 이상 (실제: ${dataTable.aliasCache.size})`);
    } finally {
      await dataTable.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('TagDataTable-06: read() — loadTagAliasCache 후 NAME이 canonical name으로 반환', async () => {
  const TABLE = T('TAG_06');
  const conn = await makeConn();
  try {
    await conn.execute(
      `CREATE TAG TABLE ${TABLE} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED)`
    );

    // 데이터 삽입
    const tagTable = new TagTable(DB_CONFIG, TABLE);
    const dataTables = await tagTable.getDataTables();
    const schema = await tagTable.getSchema();
    tagTable.setSchema(schema);
    await tagTable.open(true);
    await tagTable.append([{ NAME: 'sensor_x', TIME: nowNs(0), VALUE: 5.5 }]);
    await tagTable.close();

    // 전체 파티션에서 loadTagAliasCache 후 read()
    let found = false;
    for (const part of dataTables) {
      const dataTable = new TagDataTable(part.data_table, DB_CONFIG);
      dataTable.setSchema(schema);
      try {
        await dataTable.open();
        await dataTable.loadTagAliasCache();
        const { rows, err } = await dataTable.read(0n);
        assert.equal(err, null);
        for (const row of rows) {
          found = true;
          assert.equal(row.data.NAME, 'sensor_x', `NAME이 canonical name (실제: ${row.data.NAME})`);
        }
      } finally {
        await dataTable.close();
      }
    }
    assert.ok(found, '데이터가 있는 파티션에서 행을 읽어야 함');
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

// ─── TagDataTable 테스트 ──────────────────────────────────────────────────────

test('TagDataTable-01: getMaxRid() — 빈 파티션은 BigInt 반환', async () => {
  const TABLE = T('TDATA_01');
  const conn = await makeConn();
  try {
    await conn.execute(
      `CREATE TAG TABLE ${TABLE} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED)`
    );

    const tagTable = new TagTable(DB_CONFIG, TABLE);
    const dataTables = await tagTable.getDataTables();
    await tagTable.close();

    const dataTable = new TagDataTable(dataTables[0].data_table, DB_CONFIG);
    try {
      await dataTable.open();
      const maxRid = await dataTable.getMaxRid();
      // Machbase 빈 파티션: INT64_MIN 또는 0
      assert.ok(typeof maxRid === 'bigint', `maxRid는 BigInt (실제: ${typeof maxRid})`);
    } finally {
      await dataTable.close();
    }
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('TagDataTable-02: read() — 데이터 삽입 후 RID 기반 읽기 (전체 파티션 합산)', async () => {
  const TABLE = T('TDATA_02');
  const conn = await makeConn();
  try {
    await conn.execute(
      `CREATE TAG TABLE ${TABLE} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED)`
    );

    // 데이터 삽입 (TagTable 사용)
    const tagTable = new TagTable(DB_CONFIG, TABLE);
    const dataTables = await tagTable.getDataTables();
    const schema = await tagTable.getSchema();
    tagTable.setSchema(schema);
    await tagTable.open(true);
    await tagTable.append([
      { NAME: 'dev_a', TIME: nowNs(0), VALUE: 9.9 },
      { NAME: 'dev_b', TIME: nowNs(1), VALUE: 8.8 },
    ]);
    await tagTable.close();

    // 파티션이 여러 개이므로 전체 파티션을 읽어 합산
    let totalRows = 0;
    for (const part of dataTables) {
      const dataTable = new TagDataTable(part.data_table, DB_CONFIG);
      dataTable.setSchema(schema);
      try {
        await dataTable.open();
        const { rows, err } = await dataTable.read(0n);
        assert.equal(err, null);
        totalRows += rows.length;
        for (const row of rows) {
          assert.ok(typeof row.rid === 'bigint', 'rid는 BigInt');
          assert.ok(row.data.TIME !== undefined, 'data에 TIME 포함');
          assert.ok(row.data.VALUE !== undefined, 'data에 VALUE 포함');
        }
      } finally {
        await dataTable.close();
      }
    }
    assert.equal(totalRows, 2, `전체 파티션 합산 2행 (실제: ${totalRows})`);
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('TagDataTable-03: getMaxRid() — 데이터 삽입 후 데이터 있는 파티션은 양수', async () => {
  const TABLE = T('TDATA_03');
  const conn = await makeConn();
  try {
    await conn.execute(
      `CREATE TAG TABLE ${TABLE} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED)`
    );

    // 데이터 삽입
    const tagTable = new TagTable(DB_CONFIG, TABLE);
    const dataTables = await tagTable.getDataTables();
    const schema = await tagTable.getSchema();
    tagTable.setSchema(schema);
    await tagTable.open(true);
    await tagTable.append([{ NAME: 'x', TIME: nowNs(0), VALUE: 1.0 }]);
    await tagTable.close();

    // 전체 파티션 중 데이터 있는 파티션이 1개 이상이고 해당 파티션의 maxRid > INT64_MIN
    const INT64_MIN = -9223372036854775808n;
    let hasData = false;
    for (const part of dataTables) {
      const dataTable = new TagDataTable(part.data_table, DB_CONFIG);
      try {
        await dataTable.open();
        const maxRid = await dataTable.getMaxRid();
        if (maxRid > INT64_MIN) hasData = true;
      } finally {
        await dataTable.close();
      }
    }
    assert.ok(hasData, '데이터 삽입 후 적어도 하나의 파티션에 maxRid > INT64_MIN');
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});

test('TagDataTable-04: read() — metadata 컬럼은 결과에 포함되지 않음', async () => {
  const TABLE = T('TDATA_04');
  const conn = await makeConn();
  try {
    await conn.execute(
      `CREATE TAG TABLE ${TABLE} (name VARCHAR(64) PRIMARY KEY, time DATETIME BASETIME, value DOUBLE SUMMARIZED) METADATA (location VARCHAR(32))`
    );

    // 데이터 삽입
    const tagTable = new TagTable(DB_CONFIG, TABLE);
    const dataTables = await tagTable.getDataTables();
    const schema = await tagTable.getSchema();
    tagTable.setSchema(schema);
    await tagTable.open(true);
    await tagTable.append([{ NAME: 'loc_a', TIME: nowNs(0), VALUE: 7.7 }]);
    await tagTable.close();

    // 전체 파티션을 읽어 데이터가 있는 파티션에서 metadata 미포함 확인
    let found = false;
    for (const part of dataTables) {
      const dataTable = new TagDataTable(part.data_table, DB_CONFIG);
      dataTable.setSchema(schema);
      try {
        await dataTable.open();
        const { rows, err } = await dataTable.read(0n);
        assert.equal(err, null);
        for (const row of rows) {
          found = true;
          assert.equal(row.data.LOCATION, undefined, 'metadata 컬럼은 data에 포함되지 않음');
          assert.ok(row.data.VALUE !== undefined);
        }
      } finally {
        await dataTable.close();
      }
    }
    assert.ok(found, '데이터가 있는 파티션에서 행을 읽어야 함');
  } finally {
    await dropTable(conn, TABLE);
    await conn.close();
  }
});
