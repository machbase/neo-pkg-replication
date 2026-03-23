'use strict';

const process = require('process');
const path = require('path');
const ROOT = process.cwd();

const { suite, test, assert, run } = require(path.join(ROOT, 'tests', 'test.js'));
const { MachbaseClient } = require(path.join(ROOT, 'src', 'db', 'client.js'));
const { TagTable } = require(path.join(ROOT, 'src', 'db', 'table.js'));
const { SRC, DST, SRC_TABLE, DST_TABLE } = require(path.join(ROOT, 'tests', 'fixtures.js'));

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
      const cache = table.loadTagMetaCache();
      assert.ok(cache, 'loadTagMetaCache should return a cache object');
    } finally {
      table.close();
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

suite('Replicator - discover', () => {

  test('discover TAG table', () => {
    const { Replicator } = require(path.join(ROOT, 'src', 'replication', 'replicator.js'));
    const config = {
      source: { ...SRC, table: SRC_TABLE, columns: null, filter: null, transform: null },
      target: { ...DST, table: DST_TABLE, autoCreate: true },
      startMode: 'full',
      queryLimit: 100,
      ridRangeSize: 50000,
      pollIntervalMs: 1000,
      onSaveFailure: 'continue',
      integrity: true,
    };
    const replicator = new Replicator(config);
    const discovered = replicator.discover();
    assert.ok(discovered, 'discover should return result');
    assert.equal(discovered.tableType, 'TAG');
    assert.ok(discovered.dataTables.length > 0);
    assert.ok(discovered.srcSchema);
    assert.ok(discovered.dstSchema);
  });

});

run();
