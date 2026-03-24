'use strict';

const process = require('process');
const path = require('path');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));
const ROOT = path.resolve(TESTS_DIR, '..');

const { suite, test, assert, run } = require(TESTS_DIR + '/test.js');
const { MachbaseClient } = require(ROOT + '/src/db/client.js');
const { TagTable, TagDataTable } = require(ROOT + '/src/db/table.js');
const { SRC, DST, SRC_TABLE, DST_TABLE } = require(TESTS_DIR + '/fixtures.js');

suite('TagTable', () => {

  test('open / getSchema / close', () => {
    const table = new TagTable(SRC, SRC_TABLE);
    try {
      table.open();
      const schema = table.getSchema();
      assert.equal(schema.tableType, 'TAG');
      assert.ok(schema.columns.length > 0);
      assert.ok(schema.columns.some(c => c.name === 'NAME'), 'NAME column missing');
      assert.ok(schema.columns.some(c => c.name === 'TIME'), 'TIME column missing');
    } finally {
      table.close();
    }
  });

  test('getDataTables', () => {
    const table = new TagTable(SRC, SRC_TABLE);
    try {
      table.open();
      const parts = table.getDataTables();
      assert.ok(Array.isArray(parts));
      assert.ok(parts.length > 0, 'should have at least one partition');
    } finally {
      table.close();
    }
  });

  test('loadTagMetaCache', () => {
    const table = new TagTable(SRC, SRC_TABLE);
    try {
      table.open();
      const schema = table.getSchema();
      table.setSchema(schema);
      const cache = table.loadTagMetaCache();
      assert.ok(cache, 'loadTagMetaCache should return a cache object');
    } finally {
      table.close();
    }
  });

});

suite('TagDataTable', () => {

  test('open / cacheTagMetaAll / close', () => {
    const tagTable = new TagTable(SRC, SRC_TABLE);
    let dataTableName, schema;
    try {
      tagTable.open();
      const parts = tagTable.getDataTables();
      assert.ok(parts.length > 0, 'no partitions found');
      dataTableName = parts[0].data_table;
      schema = tagTable.getSchema();
    } finally {
      tagTable.close();
    }

    const dataTable = new TagDataTable(dataTableName, SRC);
    try {
      dataTable.open();
      dataTable.setSchema(schema);
      const err = dataTable.cacheTagMetaAll();
      assert.ok(err === null || err === undefined, `cacheTagMetaAll failed: ${err}`);
    } finally {
      dataTable.close();
    }
  });

  test('read - returns rows array', () => {
    const tagTable = new TagTable(SRC, SRC_TABLE);
    let dataTableName, schema;
    try {
      tagTable.open();
      const parts = tagTable.getDataTables();
      assert.ok(parts.length > 0);
      dataTableName = parts[0].data_table;
      schema = tagTable.getSchema();
    } finally {
      tagTable.close();
    }

    const dataTable = new TagDataTable(dataTableName, SRC);
    try {
      dataTable.open();
      dataTable.setSchema(schema);
      dataTable.cacheTagMetaAll();
      const { rows, err } = dataTable.read(0n, 10, 50000, null, null, null);
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(Array.isArray(rows));
    } finally {
      dataTable.close();
    }
  });

});

suite('TagTable - autoCreate', () => {

  test('createTagTable and drop', () => {
    const srcTable = new TagTable(SRC, SRC_TABLE);
    const dstClient = new MachbaseClient(DST);
    const tmpTable = `_TEST_CREATE_${Date.now()}`;

    try {
      srcTable.open();
      const schema = srcTable.getSchema();
      srcTable.close();

      dstClient.connect();
      dstClient.createTagTable(tmpTable, schema);

      const result = dstClient.selectTableType(tmpTable);
      assert.equal(result.type, 'TAG');

      dstClient.execute(`DROP TABLE ${tmpTable}`);
    } finally {
      try { srcTable.close(); } catch (_) {}
      dstClient.close();
    }
  });

});

run();
