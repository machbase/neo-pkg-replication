'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writer } = require('../../db/writer.js');
const { ColumnType } = require('../../core/types.js');

// ─── TableInfo mock 헬퍼 ─────────────────────────────────────────────────────

function makeTableInfo(columns) {
  return { columns };
}

test('Scenario A: columns only in target get safeNull padding', async () => {
  const srcInfo = makeTableInfo([
    { name: 'NAME',  columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',  columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2 },
  ]);
  const dstInfo = makeTableInfo([
    { name: 'NAME',  columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',  columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2 },
    { name: 'EXTRA', columnType: ColumnType.DOUBLE, id: 3 },
  ]);

  const writer = new Writer(dstInfo);
  const captured = [];
  const mockConn = {
    appendOpen: async (table, cols) => ({
      append: async (matrix) => { captured.push(...matrix); },
      close: async () => {},
    }),
    close: async () => {},
  };

  const err = await writer.open(mockConn, 'TAG2', srcInfo);
  assert.equal(err, null);
  assert.equal(writer.schema.columns.length, 4);
  assert.equal(writer.srcNames.has('EXTRA'), false);

  const appendErr = await writer.append([{ NAME: 'sensor_a', TIME: 1000n, VALUE: 1.5 }]);
  assert.equal(appendErr, null);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], ['sensor_a', 1000n, 1.5, 0.0]); // EXTRA gets safeNull(0.0)
});


test('Scenario C: int64 columns convert number to BigInt', async () => {
  const srcInfo = makeTableInfo([
    { name: 'NAME',  columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',  columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2 },
  ]);
  const dstInfo = makeTableInfo([
    { name: 'NAME',  columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',  columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2 },
  ]);

  const writer = new Writer(dstInfo);
  const captured = [];
  const mockConn = {
    appendOpen: async () => ({
      append: async (matrix) => { captured.push(...matrix); },
      close: async () => {},
    }),
    close: async () => {},
  };

  await writer.open(mockConn, 'TAG2', srcInfo);
  const err = await writer.append([{ NAME: 'sensor_c', TIME: 3000, VALUE: 3.5 }]);
  assert.equal(err, null);
  assert.equal(captured.length, 1);
  assert.equal(typeof captured[0][1], 'bigint');
  assert.equal(captured[0][1], 3000n);
});

test('Scenario D: target-only columns of various types get safeNull', async () => {
  const srcInfo = makeTableInfo([
    { name: 'NAME',  columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',  columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2 },
  ]);
  const dstInfo = makeTableInfo([
    { name: 'NAME',     columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',     columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE',    columnType: ColumnType.DOUBLE, id: 2 },
    { name: 'COL_INT',  columnType: ColumnType.INTEGER, id: 3 },
    { name: 'COL_LONG', columnType: ColumnType.LONG, id: 4 },
    { name: 'COL_STR',  columnType: ColumnType.VARCHAR, id: 5 },
  ]);

  const writer = new Writer(dstInfo);
  const captured = [];
  const mockConn = {
    appendOpen: async () => ({
      append: async (matrix) => { captured.push(...matrix); },
      close: async () => {},
    }),
    close: async () => {},
  };

  await writer.open(mockConn, 'TAG2', srcInfo);
  const err = await writer.append([{ NAME: 'sensor_d', TIME: 4000n, VALUE: 4.5 }]);
  assert.equal(err, null);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], ['sensor_d', 4000n, 4.5, 0, 0n, '']); // safeNull for each type
});

test('Scenario E: metadata columns get safeNull padding (TAG table)', async () => {
  const srcInfo = makeTableInfo([
    { name: 'NAME',  columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',  columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2 },
  ]);
  const dstInfo = makeTableInfo([
    { name: 'NAME',     columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',     columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE',    columnType: ColumnType.DOUBLE, id: 2 },
    { name: 'LOCATION', columnType: ColumnType.VARCHAR, id: 3 },  // metadata column
  ]);

  const writer = new Writer(dstInfo);
  const captured = [];
  const mockConn = {
    appendOpen: async () => ({
      append: async (matrix) => { captured.push(...matrix); },
      close: async () => {},
    }),
    close: async () => {},
  };

  await writer.open(mockConn, 'TAG2', srcInfo);
  const err = await writer.append([{ NAME: 'pump_a', TIME: 5000n, VALUE: 55.5 }]);
  assert.equal(err, null);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], ['pump_a', 5000n, 55.5, '']); // LOCATION gets safeNull('')
});

test('Scenario G: Infinity and NaN float values get safeNull and log warn', async () => {
  const srcInfo = makeTableInfo([
    { name: 'NAME',  columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',  columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2 },
    { name: 'RATIO', columnType: ColumnType.FLOAT, id: 3 },
  ]);
  const dstInfo = makeTableInfo([
    { name: 'NAME',  columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',  columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2 },
    { name: 'RATIO', columnType: ColumnType.FLOAT, id: 3 },
  ]);

  const writer = new Writer(dstInfo);
  const captured = [];
  const mockConn = {
    appendOpen: async () => ({
      append: async (matrix) => { captured.push(...matrix); },
      close: async () => {},
    }),
    close: async () => {},
  };

  await writer.open(mockConn, 'TAG2', srcInfo);
  const err = await writer.append([{ NAME: 'sensor_g', TIME: 6000n, VALUE: Infinity, RATIO: NaN }]);
  assert.equal(err, null);
  assert.equal(captured.length, 1);
  // Infinity → safeNull(0.0), NaN → safeNull(0.0)
  assert.deepEqual(captured[0], ['sensor_g', 6000n, 0.0, 0.0]);
});

test('Scenario F: null source value gets safeNull instead of null', async () => {
  const srcInfo = makeTableInfo([
    { name: 'NAME',  columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',  columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2 },
  ]);
  const dstInfo = makeTableInfo([
    { name: 'NAME',  columnType: ColumnType.VARCHAR, id: 0 },
    { name: 'TIME',  columnType: ColumnType.DATETIME, id: 1 },
    { name: 'VALUE', columnType: ColumnType.DOUBLE, id: 2 },
  ]);

  const writer = new Writer(dstInfo);
  const captured = [];
  const mockConn = {
    appendOpen: async () => ({
      append: async (matrix) => { captured.push(...matrix); },
      close: async () => {},
    }),
    close: async () => {},
  };

  await writer.open(mockConn, 'TAG2', srcInfo);
  const err = await writer.append([{ NAME: 'sensor_f', TIME: null, VALUE: undefined }]);
  assert.equal(err, null);
  assert.equal(captured.length, 1);
  // null/undefined source values → safeNull
  assert.deepEqual(captured[0], ['sensor_f', 0n, 0.0]);
});
