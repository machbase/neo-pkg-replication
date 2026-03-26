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

suite('TagDataTable - filter', () => {

  let dataTableName, schema;

  // 공통 setup: 파티션 이름과 스키마 준비
  function openDataTable() {
    const tagTable = new TagTable(SRC, SRC_TABLE);
    tagTable.open();
    const parts = tagTable.getDataTables();
    dataTableName = parts[0].data_table;
    schema = tagTable.getSchema();
    tagTable.close();

    const dt = new TagDataTable(dataTableName, SRC);
    dt.open();
    dt.setSchema(schema);
    dt.cacheTagMetaAll();
    return dt;
  }

  test('NAME filter - in: 특정 태그만 반환', () => {
    const dt = openDataTable();
    try {
      const filter = [{ column: 'NAME', in: ['a01'] }];
      const { rows, err } = dt.read(0n, 50, 50000, null, null, filter);
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(rows.length > 0, 'filter 결과가 0행');
      for (const r of rows) {
        assert.equal(r.data.NAME, 'a01', `NAME filter 위반: ${r.data.NAME}`);
      }
    } finally {
      dt.close();
    }
  });

  test('NAME filter - in: 매칭 없는 태그는 0행', () => {
    const dt = openDataTable();
    try {
      const filter = [{ column: 'NAME', in: ['__nonexistent__'] }];
      const { rows, err } = dt.read(0n, 50, 50000, null, null, filter);
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.equal(rows.length, 0, '존재하지 않는 태그에 결과가 있음');
    } finally {
      dt.close();
    }
  });

  test('NAME filter - like: 패턴 매칭', () => {
    const dt = openDataTable();
    try {
      const filter = [{ column: 'NAME', like: 'a%' }];
      const { rows, err } = dt.read(0n, 50, 50000, null, null, filter);
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(rows.length > 0, 'like 필터 결과가 0행');
      for (const r of rows) {
        assert.ok(r.data.NAME.startsWith('a'), `NAME like 'a%' 위반: ${r.data.NAME}`);
      }
    } finally {
      dt.close();
    }
  });

  test('VALUE filter - min: 하한선 이상만 반환', () => {
    const dt = openDataTable();
    try {
      const filter = [{ column: 'VALUE', min: 80 }];
      const { rows, err } = dt.read(0n, 100, 50000, null, null, filter);
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(rows.length > 0, 'min filter 결과가 0행');
      for (const r of rows) {
        assert.ok(r.data.VALUE >= 80, `VALUE >= 80 위반: ${r.data.VALUE}`);
      }
    } finally {
      dt.close();
    }
  });

  test('VALUE filter - max: 상한선 이하만 반환', () => {
    const dt = openDataTable();
    try {
      const filter = [{ column: 'VALUE', max: 35 }];
      const { rows, err } = dt.read(0n, 100, 50000, null, null, filter);
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(rows.length > 0, 'max filter 결과가 0행');
      for (const r of rows) {
        assert.ok(r.data.VALUE <= 35, `VALUE <= 35 위반: ${r.data.VALUE}`);
      }
    } finally {
      dt.close();
    }
  });

  test('VALUE filter - min+max: 범위 필터', () => {
    const dt = openDataTable();
    try {
      const filter = [{ column: 'VALUE', min: 50, max: 60 }];
      const { rows, err } = dt.read(0n, 100, 50000, null, null, filter);
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(rows.length > 0, 'range filter 결과가 0행');
      for (const r of rows) {
        assert.ok(r.data.VALUE >= 50 && r.data.VALUE <= 60, `VALUE 범위 위반: ${r.data.VALUE}`);
      }
    } finally {
      dt.close();
    }
  });

  test('VALUE filter - NaN min/max: 무시되고 정상 반환', () => {
    const dt = openDataTable();
    try {
      const noFilter = dt.read(0n, 20, 50000, null, null, null);
      const withNaN  = dt.read(0n, 20, 50000, null, null, [{ column: 'VALUE', min: NaN, max: Infinity }]);
      assert.ok(noFilter.err === null || noFilter.err === undefined);
      assert.ok(withNaN.err === null || withNaN.err === undefined);
      assert.equal(noFilter.rows.length, withNaN.rows.length, 'NaN/Infinity filter 적용 시 행 수가 달라짐');
    } finally {
      dt.close();
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
