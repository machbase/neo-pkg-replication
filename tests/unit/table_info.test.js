'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ColumnType, Column, TableSchema } = require('../../core/types.js');
const { TagAliasCache } = require('../../db/reader.js');
const { buildTagSchema, buildLogSchema } = require('../../db/schema_builder.js');

// ─── TableSchema (순수 DTO) ───────────────────────────────────────────────────

describe('TableSchema', () => {
  test('constructor: tableType / logicalTable / columns 저장', () => {
    const cols = [
      new Column('NAME', ColumnType.VARCHAR, 1, 'key'),
      new Column('TIME', ColumnType.DATETIME, 2, 'data'),
    ];
    const schema = new TableSchema('TAG', 'MY_TAG', cols);

    assert.equal(schema.tableType, 'TAG');
    assert.equal(schema.logicalTable, 'MY_TAG');
    assert.equal(schema.columns.length, 2);
    assert.strictEqual(schema.columns[0], cols[0]);
  });

  test('columns 미전달 시 빈 배열로 초기화', () => {
    const schema = new TableSchema('LOG', 'MY_LOG');
    assert.deepEqual(schema.columns, []);
  });

  test('columns 순서 및 category 보존', () => {
    const cols = [
      new Column('NAME',     ColumnType.VARCHAR,  1, 'key'),
      new Column('TIME',     ColumnType.DATETIME, 2, 'data'),
      new Column('VALUE',    ColumnType.DOUBLE,   3, 'data'),
      new Column('LOCATION', ColumnType.VARCHAR,  4, 'metadata'),
    ];
    const schema = new TableSchema('TAG', 'TAG', cols);

    assert.equal(schema.columns[0].category, 'key');
    assert.equal(schema.columns[1].category, 'data');
    assert.equal(schema.columns[3].category, 'metadata');
    // aliasMap 없음 (TagAliasCache로 분리됨)
    assert.equal(schema.aliasMap, undefined);
  });
});

// ─── Column ──────────────────────────────────────────────────────────────────

describe('Column', () => {
  test('name / columnType / id / category 보존', () => {
    const col = new Column('VALUE', ColumnType.DOUBLE, 3, 'data');
    assert.equal(col.name, 'VALUE');
    assert.strictEqual(col.columnType, ColumnType.DOUBLE);
    assert.equal(col.id, 3);
    assert.equal(col.category, 'data');
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

// ─── buildTagSchema ───────────────────────────────────────────────────────────

function mockClient({ byName = {}, byId = {} } = {}) {
  return {
    selectColumnsByTableName: async (tableName) => byName[tableName] ?? [],
    selectColumnsByTableId: async (tableId) => byId[tableId] ?? [],
  };
}

describe('buildTagSchema', () => {
  test('META + DATA 컬럼 분류 (data + metadata)', async () => {
    const client = mockClient({
      byName: {
        '_TAG_META': [
          { NAME: '_ID',      TYPE: 112, ID: 0 },
          { NAME: 'NAME',     TYPE: 5,   ID: 1 },   // first non-_ → skipped (tag name col)
          { NAME: 'LOCATION', TYPE: 5,   ID: 2 },   // metadata
        ],
      },
      byId: {
        1: [
          { NAME: '_ROWID', TYPE: 112, ID: 0 },  // _ prefix → skipped
          { NAME: 'NAME',   TYPE: 112, ID: 1 },  // key, VARCHAR override
          { NAME: 'TIME',   TYPE: 6,   ID: 2 },  // data
          { NAME: 'VALUE',  TYPE: 20,  ID: 3 },  // data
        ],
      },
    });

    const schema = await buildTagSchema(client, 'TAG', 1);
    assert.equal(schema.tableType, 'TAG');
    assert.equal(schema.logicalTable, 'TAG');

    const byName = Object.fromEntries(schema.columns.map(c => [c.name, c]));
    assert.equal(byName['NAME'].category, 'key');
    assert.strictEqual(byName['NAME'].columnType, ColumnType.VARCHAR);
    assert.equal(byName['TIME'].category, 'data');
    assert.equal(byName['VALUE'].category, 'data');
    assert.equal(byName['LOCATION'].category, 'metadata');
  });

  test('metadata 없는 TAG 테이블', async () => {
    const client = mockClient({
      byName: {
        '_TAG_META': [
          { NAME: '_ID',  TYPE: 112, ID: 0 },
          { NAME: 'NAME', TYPE: 5,   ID: 1 },  // first non-_ → skipped
        ],
      },
      byId: {
        2: [
          { NAME: 'NAME',  TYPE: 112, ID: 1 },
          { NAME: 'TIME',  TYPE: 6,   ID: 2 },
          { NAME: 'VALUE', TYPE: 20,  ID: 3 },
        ],
      },
    });

    const schema = await buildTagSchema(client, 'TAG', 2);
    assert.equal(schema.columns.length, 3);
    assert.ok(schema.columns.every(c => c.category !== 'metadata'), 'metadata 컬럼 없음');
  });

  test('additional data 컬럼 있는 DATA 파티션', async () => {
    const client = mockClient({
      byName: { '_MY_TAG_META': [] },
      byId: {
        5: [
          { NAME: 'NAME',    TYPE: 112, ID: 1 },
          { NAME: 'TIME',    TYPE: 6,   ID: 2 },
          { NAME: 'VALUE',   TYPE: 20,  ID: 3 },
          { NAME: 'QUALITY', TYPE: 20,  ID: 4 },
        ],
      },
    });

    const schema = await buildTagSchema(client, 'MY_TAG', 5);
    const names = schema.columns.map(c => c.name);
    assert.ok(names.includes('QUALITY'), 'QUALITY 컬럼 포함');
    assert.equal(schema.columns.find(c => c.name === 'QUALITY').category, 'data');
  });

  test('dataColumns 없으면 Error throw', async () => {
    const client = mockClient({
      byName: { '_TAG_META': [] },
      byId: { 9: [] },
    });

    await assert.rejects(
      () => buildTagSchema(client, 'TAG', 9),
      /buildTagSchema: no data columns/
    );
  });
});

// ─── buildLogSchema ───────────────────────────────────────────────────────────

describe('buildLogSchema', () => {
  test('전체 컬럼 data category로 구성', async () => {
    const client = mockClient({
      byName: {
        'MY_LOG': [
          { NAME: 'NAME',  TYPE: 5,  ID: 1 },
          { NAME: 'TIME',  TYPE: 6,  ID: 2 },
          { NAME: 'VALUE', TYPE: 20, ID: 3 },
        ],
      },
    });

    const schema = await buildLogSchema(client, 'MY_LOG');
    assert.equal(schema.tableType, 'LOG');
    assert.equal(schema.logicalTable, 'MY_LOG');
    assert.equal(schema.columns.length, 3);
    assert.ok(schema.columns.every(c => c.category === 'data'), '모든 컬럼 data category');
  });

  test('추가 컬럼 있는 LOG 테이블', async () => {
    const client = mockClient({
      byName: {
        'EXT_LOG': [
          { NAME: 'NAME',    TYPE: 5,  ID: 1 },
          { NAME: 'TIME',    TYPE: 6,  ID: 2 },
          { NAME: 'VALUE',   TYPE: 20, ID: 3 },
          { NAME: 'STATUS',  TYPE: 5,  ID: 4 },
        ],
      },
    });

    const schema = await buildLogSchema(client, 'EXT_LOG');
    assert.equal(schema.columns.length, 4);
    const names = schema.columns.map(c => c.name);
    assert.ok(names.includes('STATUS'), 'STATUS 컬럼 포함');
  });
});
