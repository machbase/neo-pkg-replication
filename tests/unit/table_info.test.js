'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ColumnType, Column, TableSchema } = require('../../machbase/table_info.js');
const { TagAliasCache } = require('../../machbase/reader.js');

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

// ─── TableSchema.buildTag ─────────────────────────────────────────────────────

describe('TableSchema.buildTag', () => {
  test('META + DATA 컬럼 분류: columns (data + metadata)', async () => {
    const conn = mockConn({
      // Step 1: META 컬럼 조회
      'M$SYS_COLUMNS c, M$SYS_TABLES t': (sql, params) => {
        if (params && params[0] === '_TAG_META') {
          return [
            // _ID는 _prefix 필터(startsWith('_'))에 의해 제외됨
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
            { NAME: 'NAME', TYPE: 112, ID: 1 },      // tag_id → columns에 포함
            { NAME: 'TIME', TYPE: 6, ID: 2 },        // data column
            { NAME: 'VALUE', TYPE: 20, ID: 3 },      // data column
          ];
        }
        return [];
      },
    });

    const schema = await TableSchema.buildTag(conn, 'TAG', 100);

    assert.equal(schema.tableType, 'TAG');
    assert.equal(schema.logicalTable, 'TAG');

    // columns = data(NAME, TIME, VALUE) + metadata(LOCATION, UNIT)
    assert.equal(schema.columns.length, 5);
    assert.ok(schema.columns.every(c => c instanceof Column), 'columns must be Column instances');
    assert.equal(schema.columns[0].name, 'NAME');
    assert.equal(schema.columns[0].category, 'key');
    assert.equal(schema.columns[1].name, 'TIME');
    assert.equal(schema.columns[1].columnType, ColumnType.DATETIME);
    assert.equal(schema.columns[1].category, 'data');
    assert.equal(schema.columns[2].name, 'VALUE');
    assert.equal(schema.columns[2].columnType, ColumnType.DOUBLE);
    assert.equal(schema.columns[3].name, 'LOCATION');
    assert.equal(schema.columns[3].category, 'metadata');
    assert.equal(schema.columns[4].name, 'UNIT');
    assert.equal(schema.columns[4].category, 'metadata');

    // TableSchema에는 aliasMap 없음 (TagAliasCache로 분리됨)
    assert.equal(schema.aliasMap, undefined);
  });

  test('metadata 없는 TAG 테이블 → metadata category 컬럼 없음', async () => {
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
        { NAME: 'NAME', TYPE: 112, ID: 1 },
        { NAME: 'TIME', TYPE: 6, ID: 2 },
        { NAME: 'VALUE', TYPE: 20, ID: 3 },
      ],
    });

    const schema = await TableSchema.buildTag(conn, 'SIMPLE', 200);

    assert.equal(schema.columns.length, 3); // NAME + TIME + VALUE
    assert.ok(schema.columns.every(c => c.category !== 'metadata'));
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
        { NAME: 'NAME', TYPE: 112, ID: 1 },
        { NAME: 'TIME', TYPE: 6, ID: 2 },
        { NAME: 'VALUE', TYPE: 20, ID: 3 },
        { NAME: 'QUALITY', TYPE: 20, ID: 4 },  // additional column
      ],
    });

    const schema = await TableSchema.buildTag(conn, 'EXTRA', 300);

    assert.equal(schema.columns.length, 4); // NAME + TIME + VALUE + QUALITY
    assert.equal(schema.columns[3].name, 'QUALITY');
    assert.equal(schema.columns[3].columnType, ColumnType.DOUBLE);
    assert.equal(schema.columns[3].category, 'data');
  });
});

// ─── TableSchema.buildLog ─────────────────────────────────────────────────────

describe('TableSchema.buildLog', () => {
  test('LOG 테이블 전체 컬럼 구성', async () => {
    const conn = mockConn({
      'M$SYS_COLUMNS c, M$SYS_TABLES t': () => [
        { NAME: 'NAME', TYPE: 5, ID: 0 },
        { NAME: 'TIME', TYPE: 6, ID: 1 },
        { NAME: 'VALUE', TYPE: 20, ID: 2 },
      ],
    });

    const schema = await TableSchema.buildLog(conn, 'LOG_TABLE');

    assert.equal(schema.tableType, 'LOG');
    assert.equal(schema.logicalTable, 'LOG_TABLE');
    assert.equal(schema.columns.length, 3);
    assert.ok(schema.columns.every(c => c instanceof Column), 'columns must be Column instances');
    // LOG에는 aliasMap 없음
    assert.equal(schema.aliasMap, undefined);

    // 컬럼 순서 확인
    assert.equal(schema.columns[0].name, 'NAME');
    assert.equal(schema.columns[1].name, 'TIME');
    assert.equal(schema.columns[2].name, 'VALUE');
    // LOG 컬럼은 모두 'data' category
    assert.ok(schema.columns.every(c => c.category === 'data'));
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

    const schema = await TableSchema.buildLog(conn, 'LOG_EXT');

    assert.equal(schema.columns.length, 4);
    assert.equal(schema.columns[3].name, 'STATUS');
    assert.equal(schema.columns[3].columnType, ColumnType.VARCHAR);
  });
});

// ─── TagAliasCache.resolve ────────────────────────────────────────────────────

describe('TagAliasCache.resolve', () => {
  test('cache hit → DB 조회 없이 반환', async () => {
    const cache = new TagAliasCache('TAG');
    cache._map.set(1n, 'sensor_a');
    let dbCalled = false;
    const conn = { query: async () => { dbCalled = true; return []; } };

    const result = await cache.resolve(conn, 1, { mode: 'none' });
    assert.equal(result.canonical, 'sensor_a');
    assert.equal(result.status, 'ok');
    assert.equal(dbCalled, false, 'DB 조회 없어야 함');
  });

  test('cache miss → DB 단건 조회 → cache 업데이트', async () => {
    const cache = new TagAliasCache('TAG');
    const conn = {
      query: async () => [{ name: 'new_sensor' }],
    };

    const result = await cache.resolve(conn, 99, { mode: 'none' });
    assert.equal(result.canonical, 'new_sensor');
    assert.equal(result.status, 'ok');
    assert.equal(cache._map.get(99n), 'new_sensor', 'cache에 추가되어야 함');
  });

  test('DB에도 없는 tag_id → drop_not_found', async () => {
    const cache = new TagAliasCache('TAG');
    const conn = { query: async () => [] };

    const result = await cache.resolve(conn, 999, { mode: 'none' });
    assert.equal(result.canonical, null);
    assert.equal(result.status, 'drop_not_found');
  });

  test('DB 조회 오류 → retry_error', async () => {
    const cache = new TagAliasCache('TAG');
    const conn = { query: async () => { throw new Error('DB down'); } };

    const result = await cache.resolve(conn, 42, { mode: 'none' });
    assert.equal(result.canonical, null);
    assert.equal(result.status, 'retry_error');
  });

  test('tag_identifier prefix 적용', async () => {
    const cache = new TagAliasCache('TAG');
    cache._map.set(1n, 'sensor_a');
    const conn = { query: async () => [] };

    const result = await cache.resolve(conn, 1, { mode: 'prefix', value: 'SRC_' });
    assert.equal(result.canonical, 'SRC_sensor_a');
  });

  test('tag_identifier suffix 적용', async () => {
    const cache = new TagAliasCache('TAG');
    cache._map.set(1n, 'sensor_a');
    const conn = { query: async () => [] };

    const result = await cache.resolve(conn, 1, { mode: 'suffix', value: '_v2' });
    assert.equal(result.canonical, 'sensor_a_v2');
  });
});

// ─── TagAliasCache.load ───────────────────────────────────────────────────────

describe('TagAliasCache.load', () => {
  test('정상 로드', async () => {
    const cache = new TagAliasCache('TAG');
    const conn = {
      query: async () => [
        { _ID: 1, name: 'alpha' },
        { _ID: 2, name: 'beta' },
      ],
    };

    const err = await cache.load(conn);
    assert.equal(err, null);
    assert.equal(cache.size, 2);
    assert.equal(cache._map.get(1n), 'alpha');
  });

  test('DB 오류 → error 반환', async () => {
    const cache = new TagAliasCache('TAG');
    const conn = { query: async () => { throw new Error('timeout'); } };

    const err = await cache.load(conn);
    assert.ok(err instanceof Error);
    assert.equal(cache.size, 0);
  });
});
