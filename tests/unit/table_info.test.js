'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const TableInfo = require('../../machbase/table_info.js');
const { ColumnType } = require('../../machbase/machbase.js');

// ─── mock conn 헬퍼 ─────────────────────────────────────────────────────────

function mockConn(queryMap) {
  return {
    query: async (sql, params) => {
      for (const [pattern, handler] of Object.entries(queryMap)) {
        if (sql.includes(pattern)) return handler(sql, params);
      }
      return [];
    },
  };
}

// ─── buildTag ────────────────────────────────────────────────────────────────

describe('TableInfo.buildTag', () => {
  test('META + DATA 컬럼 분류: dataColumns, metadataColumns, writeColumns', async () => {
    const conn = mockConn({
      // Step 1: META 컬럼 조회
      'M$SYS_COLUMNS c, M$SYS_TABLES t': (sql, params) => {
        if (params && params[0] === '_TAG_META') {
          return [
            // _ID는 c.ID > 0 조건으로 조회되지 않을 수 있지만, _prefix 필터에 걸림
            { NAME: '_ID', TYPE: 112, ID: 0 },
            { NAME: 'NAME', TYPE: 5, ID: 1 },      // 첫 번째 user 컬럼 → skip
            { NAME: 'LOCATION', TYPE: 5, ID: 2 },   // metadata column
            { NAME: 'UNIT', TYPE: 5, ID: 3 },        // metadata column
          ];
        }
        return [];
      },
      // Step 2: DATA 파티션 컬럼 조회
      'c.TABLE_ID = ?': (sql, params) => {
        if (params && params[0] === 100) {
          return [
            { NAME: '_ROWID', TYPE: 112, ID: 0 },   // _ prefix → 제외
            { NAME: 'NAME', TYPE: 112, ID: 1 },      // TYPE=112 (ulong) → 제외
            { NAME: 'TIME', TYPE: 6, ID: 2 },        // data column
            { NAME: 'VALUE', TYPE: 20, ID: 3 },      // data column
          ];
        }
        return [];
      },
      // Step 4: alias map
      '_TAG_META': () => [
        { _ID: 1, name: 'sensor_a' },
        { _ID: 2, name: 'sensor_b' },
      ],
    });

    const info = await TableInfo.buildTag(conn, 'TAG', 100);

    assert.equal(info.tableType, 'TAG');
    assert.equal(info.logicalTable, 'TAG');

    // dataColumns: TIME, VALUE
    assert.equal(info.dataColumns.length, 2);
    assert.equal(info.dataColumns[0].name, 'TIME');
    assert.equal(info.dataColumns[0].columnType, ColumnType.DATETIME);
    assert.equal(info.dataColumns[1].name, 'VALUE');
    assert.equal(info.dataColumns[1].columnType, ColumnType.DOUBLE);

    // metadataColumns: LOCATION, UNIT
    assert.equal(info.metadataColumns.length, 2);
    assert.equal(info.metadataColumns[0].name, 'LOCATION');
    assert.equal(info.metadataColumns[1].name, 'UNIT');

    // writeColumns: NAME + data + metadata
    assert.equal(info.writeColumns.length, 5); // NAME + TIME + VALUE + LOCATION + UNIT
    assert.equal(info.writeColumns[0].name, 'NAME');
    assert.equal(info.writeColumns[1].name, 'TIME');
    assert.equal(info.writeColumns[2].name, 'VALUE');
    assert.equal(info.writeColumns[3].name, 'LOCATION');
    assert.equal(info.writeColumns[4].name, 'UNIT');

    // aliasMap
    assert.equal(info.aliasMap.size, 2);
    assert.equal(info.aliasMap.get(1n), 'sensor_a');
    assert.equal(info.aliasMap.get(2n), 'sensor_b');
  });

  test('metadata 없는 TAG 테이블 → metadataColumns 비어있음', async () => {
    const conn = mockConn({
      'M$SYS_COLUMNS c, M$SYS_TABLES t': (sql, params) => {
        if (params && params[0] === '_SIMPLE_META') {
          return [
            { NAME: 'NAME', TYPE: 5, ID: 1 },  // 첫 번째 user 컬럼 → skip
          ];
        }
        return [];
      },
      'c.TABLE_ID = ?': () => [
        { NAME: 'TIME', TYPE: 6, ID: 2 },
        { NAME: 'VALUE', TYPE: 20, ID: 3 },
      ],
      '_SIMPLE_META': () => [],
    });

    const info = await TableInfo.buildTag(conn, 'SIMPLE', 200);

    assert.equal(info.metadataColumns.length, 0);
    assert.equal(info.dataColumns.length, 2);
    assert.equal(info.writeColumns.length, 3); // NAME + TIME + VALUE
  });

  test('additional column이 있는 DATA 파티션', async () => {
    const conn = mockConn({
      'M$SYS_COLUMNS c, M$SYS_TABLES t': (sql, params) => {
        if (params && typeof params[0] === 'string' && params[0].includes('_META')) {
          return [{ NAME: 'NAME', TYPE: 5, ID: 1 }];
        }
        return [];
      },
      'c.TABLE_ID = ?': () => [
        { NAME: 'TIME', TYPE: 6, ID: 2 },
        { NAME: 'VALUE', TYPE: 20, ID: 3 },
        { NAME: 'QUALITY', TYPE: 20, ID: 4 },  // additional column
      ],
      '_META': () => [],
    });

    const info = await TableInfo.buildTag(conn, 'EXTRA', 300);

    assert.equal(info.dataColumns.length, 3);
    assert.equal(info.dataColumns[2].name, 'QUALITY');
    assert.equal(info.dataColumns[2].columnType, ColumnType.DOUBLE);
    assert.equal(info.writeColumns.length, 4); // NAME + TIME + VALUE + QUALITY
  });
});

// ─── buildLog ────────────────────────────────────────────────────────────────

describe('TableInfo.buildLog', () => {
  test('LOG 테이블 전체 컬럼 구성', async () => {
    const conn = mockConn({
      'M$SYS_COLUMNS c, M$SYS_TABLES t': () => [
        { NAME: 'NAME', TYPE: 5, ID: 0 },
        { NAME: 'TIME', TYPE: 6, ID: 1 },
        { NAME: 'VALUE', TYPE: 20, ID: 2 },
      ],
    });

    const info = await TableInfo.buildLog(conn, 'LOG_TABLE');

    assert.equal(info.tableType, 'LOG');
    assert.equal(info.logicalTable, 'LOG_TABLE');
    assert.equal(info.dataColumns.length, 3);
    assert.equal(info.metadataColumns.length, 0);
    assert.equal(info.writeColumns.length, 3);
    assert.equal(info.aliasMap.size, 0);

    // 컬럼 순서 확인
    assert.equal(info.writeColumns[0].name, 'NAME');
    assert.equal(info.writeColumns[1].name, 'TIME');
    assert.equal(info.writeColumns[2].name, 'VALUE');
  });

  test('LOG 테이블 + 추가 컬럼', async () => {
    const conn = mockConn({
      'M$SYS_COLUMNS c, M$SYS_TABLES t': () => [
        { NAME: 'NAME', TYPE: 5, ID: 0 },
        { NAME: 'TIME', TYPE: 6, ID: 1 },
        { NAME: 'VALUE', TYPE: 20, ID: 2 },
        { NAME: 'STATUS', TYPE: 5, ID: 3 },
      ],
    });

    const info = await TableInfo.buildLog(conn, 'LOG_EXT');

    assert.equal(info.dataColumns.length, 4);
    assert.equal(info.writeColumns.length, 4);
    assert.equal(info.writeColumns[3].name, 'STATUS');
    assert.equal(info.writeColumns[3].columnType, ColumnType.VARCHAR);
  });
});

// ─── resolveTagCanonical ─────────────────────────────────────────────────────

describe('TableInfo.resolveTagCanonical', () => {
  test('cache hit → DB 조회 없이 반환', async () => {
    const info = new TableInfo('TAG', 'TAG');
    info.aliasMap.set(1n, 'sensor_a');
    let dbCalled = false;
    const conn = { query: async () => { dbCalled = true; return []; } };

    const result = await info.resolveTagCanonical(conn, 1, { mode: 'none' });
    assert.equal(result.canonical, 'sensor_a');
    assert.equal(result.status, 'ok');
    assert.equal(dbCalled, false, 'DB 조회 없어야 함');
  });

  test('cache miss → DB 단건 조회 → cache 업데이트', async () => {
    const info = new TableInfo('TAG', 'TAG');
    const conn = {
      query: async () => [{ name: 'new_sensor' }],
    };

    const result = await info.resolveTagCanonical(conn, 99, { mode: 'none' });
    assert.equal(result.canonical, 'new_sensor');
    assert.equal(result.status, 'ok');
    assert.equal(info.aliasMap.get(99n), 'new_sensor', 'cache에 추가되어야 함');
  });

  test('DB에도 없는 tag_id → drop_not_found', async () => {
    const info = new TableInfo('TAG', 'TAG');
    const conn = { query: async () => [] };

    const result = await info.resolveTagCanonical(conn, 999, { mode: 'none' });
    assert.equal(result.canonical, null);
    assert.equal(result.status, 'drop_not_found');
  });

  test('DB 조회 오류 → retry_error', async () => {
    const info = new TableInfo('TAG', 'TAG');
    const conn = { query: async () => { throw new Error('DB down'); } };

    const result = await info.resolveTagCanonical(conn, 42, { mode: 'none' });
    assert.equal(result.canonical, null);
    assert.equal(result.status, 'retry_error');
  });

  test('tag_identifier prefix 적용', async () => {
    const info = new TableInfo('TAG', 'TAG');
    info.aliasMap.set(1n, 'sensor_a');
    const conn = { query: async () => [] };

    const result = await info.resolveTagCanonical(conn, 1, { mode: 'prefix', value: 'SRC_' });
    assert.equal(result.canonical, 'SRC_sensor_a');
  });

  test('tag_identifier suffix 적용', async () => {
    const info = new TableInfo('TAG', 'TAG');
    info.aliasMap.set(1n, 'sensor_a');
    const conn = { query: async () => [] };

    const result = await info.resolveTagCanonical(conn, 1, { mode: 'suffix', value: '_v2' });
    assert.equal(result.canonical, 'sensor_a_v2');
  });
});

// ─── loadAliases ─────────────────────────────────────────────────────────────

describe('TableInfo.loadAliases', () => {
  test('정상 로드', async () => {
    const info = new TableInfo('TAG', 'TAG');
    const conn = {
      query: async () => [
        { _ID: 1, name: 'alpha' },
        { _ID: 2, name: 'beta' },
      ],
    };

    const err = await info.loadAliases(conn);
    assert.equal(err, null);
    assert.equal(info.aliasMap.size, 2);
    assert.equal(info.aliasMap.get(1n), 'alpha');
  });

  test('DB 오류 → error 반환', async () => {
    const info = new TableInfo('TAG', 'TAG');
    const conn = { query: async () => { throw new Error('timeout'); } };

    const err = await info.loadAliases(conn);
    assert.ok(err instanceof Error);
    assert.equal(info.aliasMap.size, 0);
  });

  test('LOG 테이블 → no-op (null 반환)', async () => {
    const info = new TableInfo('LOG', 'LOG_TABLE');
    const conn = { query: async () => { throw new Error('should not be called'); } };

    const err = await info.loadAliases(conn);
    assert.equal(err, null);
  });
});

// ─── getSelectColumnNames ────────────────────────────────────────────────────

describe('TableInfo.getSelectColumnNames', () => {
  test('TAG: dataColumns의 name을 lowercase로 반환', () => {
    const info = new TableInfo('TAG', 'TAG');
    info.dataColumns = [
      { name: 'TIME', columnType: ColumnType.DATETIME, id: 2, category: 'data' },
      { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 3, category: 'data' },
      { name: 'QUALITY', columnType: ColumnType.DOUBLE, id: 4, category: 'data' },
    ];

    const names = info.getSelectColumnNames();
    assert.deepEqual(names, ['time', 'value', 'quality']);
  });

  test('LOG: dataColumns의 name을 lowercase로 반환 (name 포함)', () => {
    const info = new TableInfo('LOG', 'LOG_TABLE');
    info.dataColumns = [
      { name: 'NAME', columnType: ColumnType.VARCHAR, id: 0, category: 'data' },
      { name: 'TIME', columnType: ColumnType.DATETIME, id: 1, category: 'data' },
      { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2, category: 'data' },
    ];

    const names = info.getSelectColumnNames();
    assert.deepEqual(names, ['name', 'time', 'value']);
  });
});
