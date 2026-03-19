'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TagMetaCache, TagTable } = require('../../src/db/table.js');
const { ColumnType, Column, TableSchema } = require('../../src/db/types.js');

// ─── TagMetaCache._applyIdentifier ──────────────────────────────────────────

test('TagMetaCache.set: tag name에 null byte → throw', () => {
  const cache = new TagMetaCache();
  assert.throws(
    () => cache.set(1n, 'bad\x00key'),
    /null byte/
  );
});

// ─── TagTable.findFirstMissRow ────────────────────────────────────────────────

/**
 * findFirstMissRow 테스트용 TagTable 인스턴스 생성
 * schema에 NAME VARCHAR(80) 컬럼 포함
 */
function makeTagTableForTest() {
  const nameCol = new Column('NAME', ColumnType.VARCHAR, 0, 'key', 80);
  const timeCol = new Column('TIME', ColumnType.DATETIME, 2, 'data', 0);
  const schema = new TableSchema('TAG', 'TAG', [nameCol, timeCol]);
  // config는 사용되지 않으므로 dummy 전달
  const table = new TagTable({ host: 'mock', port: 1 }, 'TAG');
  table.setSchema(schema);
  return table;
}

/**
 * mock client 생성
 * @param {{ queryResult?: Array }} opts
 */
function makeMockClient({ queryResult = [] } = {}) {
  return {
    execute: async () => {},
    appendOpen: async () => ({
      append: async () => {},
      close: async () => {},
    }),
    query: async () => queryResult,
  };
}

test('findFirstMissRow: 빈 rows → { firstMissIdx: null, err: null }', async () => {
  const table = makeTagTableForTest();
  const client = makeMockClient();
  const { firstMissIdx, err } = await table.findFirstMissRow([], client, 'test');
  assert.equal(err, null);
  assert.equal(firstMissIdx, null);
});

test('findFirstMissRow: 모든 rows 존재 → { firstMissIdx: null, err: null }', async () => {
  const table = makeTagTableForTest();
  // query 결과 빈 배열 → LEFT OUTER JOIN에서 T_NAME IS NULL인 행 없음
  const client = makeMockClient({ queryResult: [] });
  const rows = [
    { canonical: 'sensor_a', time: 1000n },
    { canonical: 'sensor_b', time: 2000n },
  ];
  const { firstMissIdx, err } = await table.findFirstMissRow(rows, client, 'test');
  assert.equal(err, null);
  assert.equal(firstMissIdx, null);
});

test('findFirstMissRow: 첫 번째(idx=0) miss → { firstMissIdx: 0, err: null }', async () => {
  const table = makeTagTableForTest();
  // query가 IDX=0을 반환 → 첫 번째 행이 없음
  const client = makeMockClient({ queryResult: [{ IDX: 0 }] });
  const rows = [
    { canonical: 'sensor_a', time: 1000n },
    { canonical: 'sensor_b', time: 2000n },
  ];
  const { firstMissIdx, err } = await table.findFirstMissRow(rows, client, 'test');
  assert.equal(err, null);
  assert.equal(firstMissIdx, 0);
});

test('findFirstMissRow: 중간(idx=1) miss → { firstMissIdx: 1, err: null }', async () => {
  const table = makeTagTableForTest();
  // query가 IDX=1을 반환 → 두 번째 행이 없음
  const client = makeMockClient({ queryResult: [{ IDX: 1 }] });
  const rows = [
    { canonical: 'sensor_a', time: 1000n },
    { canonical: 'sensor_b', time: 2000n },
    { canonical: 'sensor_c', time: 3000n },
  ];
  const { firstMissIdx, err } = await table.findFirstMissRow(rows, client, 'test');
  assert.equal(err, null);
  assert.equal(firstMissIdx, 1);
});

test('findFirstMissRow: NAME 컬럼 없는 schema → { firstMissIdx: null, err }', async () => {
  // NAME 컬럼 없이 TIME만 있는 schema
  const timeCol = new Column('TIME', ColumnType.DATETIME, 2, 'data', 0);
  const schema = new TableSchema('TAG', 'TAG', [timeCol]);
  const table = new TagTable({ host: 'mock', port: 1 }, 'TAG');
  table.setSchema(schema);
  const client = makeMockClient();
  const rows = [{ canonical: 'sensor_a', time: 1000n }];
  const { firstMissIdx, err } = await table.findFirstMissRow(rows, client, 'test');
  assert.ok(err instanceof Error, 'err가 Error 인스턴스여야 함');
  assert.match(err.message, /NAME column not found/);
  assert.equal(firstMissIdx, null);
});

test('findFirstMissRow: execute 에러 → { firstMissIdx: null, err }', async () => {
  const table = makeTagTableForTest();
  const client = {
    execute: async () => { throw new Error('DB connection failed'); },
    appendOpen: async () => ({ append: async () => {}, close: async () => {} }),
    query: async () => [],
  };
  const rows = [{ canonical: 'sensor_a', time: 1000n }];
  const { firstMissIdx, err } = await table.findFirstMissRow(rows, client, 'test');
  assert.ok(err instanceof Error, 'err가 Error 인스턴스여야 함');
  assert.equal(firstMissIdx, null);
});
