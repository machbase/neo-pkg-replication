'use strict';

/**
 * @fileoverview TagTable / TagDataTable / filter 통합 테스트
 *
 * 기본값은 로컬 DB(127.0.0.1:5656)이며 fixtures.js 환경변수 override를 지원한다.
 * 사용법: jsh cgi-bin/tests/table.test.js
 */

const process = require('process');
const path = require('path');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));
const ROOT = path.resolve(TESTS_DIR, '..');

const { suite, test, assert, run } = require(TESTS_DIR + '/test.js');
const { MachbaseClient } = require(ROOT + '/src/db/client.js');
const { TagTable, TagDataTable } = require(ROOT + '/src/db/table.js');
const { SRC, DST, SRC_TABLE, DST_TABLE } = require(TESTS_DIR + '/fixtures.js');

suite('TagTable', () => {

  test('open / getSchema / close', async () => {
    const table = new TagTable(SRC, SRC_TABLE);
    try {
      await table.open();
      const schema = await table.getSchema();
      assert.equal(schema.tableType, 'TAG');
      assert.ok(schema.columns.length > 0);
      assert.ok(schema.columns.some(c => c.name === 'NAME'), 'NAME column missing');
      assert.ok(schema.columns.some(c => c.name === 'TIME'), 'TIME column missing');
    } finally {
      await table.close();
    }
  });

  test('getDataTables', async () => {
    const table = new TagTable(SRC, SRC_TABLE);
    try {
      await table.open();
      const parts = await table.getDataTables();
      assert.ok(Array.isArray(parts));
      assert.ok(parts.length > 0, 'should have at least one partition');
    } finally {
      await table.close();
    }
  });

  test('loadTagMetaCache', async () => {
    const table = new TagTable(SRC, SRC_TABLE);
    try {
      await table.open();
      const schema = await table.getSchema();
      table.setSchema(schema);
      const cache = await table.loadTagMetaCache();
      assert.ok(cache, 'loadTagMetaCache should return a cache object');
    } finally {
      await table.close();
    }
  });

});

suite('TagDataTable', () => {

  test('open / cacheTagMetaAll / close', async () => {
    const tagTable = new TagTable(SRC, SRC_TABLE);
    let dataTableName, schema;
    try {
      await tagTable.open();
      const parts = await tagTable.getDataTables();
      assert.ok(parts.length > 0, 'no partitions found');
      dataTableName = parts[0].data_table;
      schema = await tagTable.getSchema();
    } finally {
      await tagTable.close();
    }

    const dataTable = new TagDataTable(dataTableName, SRC);
    try {
      await dataTable.open();
      dataTable.setSchema(schema);
      const err = await dataTable.cacheTagMetaAll();
      assert.ok(err === null || err === undefined, `cacheTagMetaAll failed: ${err}`);
    } finally {
      await dataTable.close();
    }
  });

  test('read - returns rows array', async () => {
    const tagTable = new TagTable(SRC, SRC_TABLE);
    let dataTableName, schema;
    try {
      await tagTable.open();
      const parts = await tagTable.getDataTables();
      assert.ok(parts.length > 0);
      dataTableName = parts[0].data_table;
      schema = await tagTable.getSchema();
    } finally {
      await tagTable.close();
    }

    const dataTable = new TagDataTable(dataTableName, SRC);
    try {
      await dataTable.open();
      dataTable.setSchema(schema);
      await dataTable.cacheTagMetaAll();
      const { rows, err } = await dataTable.read(0n, 10n, 10, {
        selectColumns: ['NAME', 'TIME', 'VALUE'],
      });
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(Array.isArray(rows));
    } finally {
      await dataTable.close();
    }
  });

});

suite('TagDataTable - filter', () => {

  let dataTableName, schema;

  function pickSampleNamePattern() {
    const client = new MachbaseClient(SRC);
    try {
      client.connect();
      const rows = client.selectTagNames(SRC_TABLE) || [];
      assert.ok(rows.length > 0, 'TAG META is empty');
      const exact = rows[0].name;
      const prefix = exact.slice(0, 1);
      return {
        exact,
        like: `${prefix}%`,
        matches: (name) => String(name || '').startsWith(prefix),
      };
    } finally {
      client.close();
    }
  }

  /**
   * TagDataTable 인스턴스를 열어 반환하는 헬퍼 함수.
   * 첫 번째 파티션 이름과 스키마를 준비하고 TAG META 캐시를 로드한다.
   * @returns {TagDataTable}
   */
  async function openDataTable() {
    const tagTable = new TagTable(SRC, SRC_TABLE);
    await tagTable.open();
    try {
      const parts = await tagTable.getDataTables();
      dataTableName = parts[0].data_table;
      schema = await tagTable.getSchema();
    } finally {
      await tagTable.close();
    }

    const dt = new TagDataTable(dataTableName, SRC);
    await dt.open();
    dt.setSchema(schema);
    await dt.cacheTagMetaAll();
    return dt;
  }

  test('NAME filter - in: 특정 태그만 반환', async () => {
    const sample = pickSampleNamePattern();
    const dt = await openDataTable();
    try {
      const { rows, err } = await dt.read(0n, 50n, 50, {
        selectColumns: ['NAME', 'TIME', 'VALUE'],
        repTargetCond: { column: 'NAME', op: 'IN', value: [sample.exact] },
      });
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(rows.length > 0, 'filter 결과가 0행');
      for (const r of rows) {
        assert.equal(r.data.NAME, sample.exact, `NAME filter 위반: ${r.data.NAME}`);
      }
    } finally {
      await dt.close();
    }
  });

  test('NAME filter - in: 매칭 없는 태그는 0행', async () => {
    const dt = await openDataTable();
    try {
      const { rows, err } = await dt.read(0n, 50n, 50, {
        selectColumns: ['NAME', 'TIME', 'VALUE'],
        repTargetCond: { column: 'NAME', op: 'IN', value: ['__nonexistent__'] },
      });
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.equal(rows.length, 0, '존재하지 않는 태그에 결과가 있음');
    } finally {
      await dt.close();
    }
  });

  test('NAME filter - like: 패턴 매칭', async () => {
    const sample = pickSampleNamePattern();
    const dt = await openDataTable();
    try {
      const { rows, err } = await dt.read(0n, 50n, 50, {
        selectColumns: ['NAME', 'TIME', 'VALUE'],
        repTargetCond: { column: 'NAME', op: 'LIKE', value: [sample.like] },
      });
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(rows.length > 0, 'like 필터 결과가 0행');
      for (const r of rows) {
        assert.ok(sample.matches(r.data.NAME), `NAME like '${sample.like}' 위반: ${r.data.NAME}`);
      }
    } finally {
      await dt.close();
    }
  });

  test('VALUE filter - min: 하한선 이상만 반환', async () => {
    const dt = await openDataTable();
    try {
      const { rows, err } = await dt.read(0n, 100n, 100, {
        selectColumns: ['NAME', 'TIME', 'VALUE'],
        transform: [{
          criteria: { op: 'ALL', value: [] },
          expr: [{ column: 'VALUE', type: 'filter', min: 80 }],
        }],
      });
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(rows.length > 0, 'min filter 결과가 0행');
      for (const r of rows) {
        assert.ok(r.data.VALUE >= 80, `VALUE >= 80 위반: ${r.data.VALUE}`);
      }
    } finally {
      await dt.close();
    }
  });

  test('VALUE filter - max: 상한선 이하만 반환', async () => {
    const dt = await openDataTable();
    try {
      const { rows, err } = await dt.read(0n, 100n, 100, {
        selectColumns: ['NAME', 'TIME', 'VALUE'],
        transform: [{
          criteria: { op: 'ALL', value: [] },
          expr: [{ column: 'VALUE', type: 'filter', max: 35 }],
        }],
      });
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(rows.length > 0, 'max filter 결과가 0행');
      for (const r of rows) {
        assert.ok(r.data.VALUE <= 35, `VALUE <= 35 위반: ${r.data.VALUE}`);
      }
    } finally {
      await dt.close();
    }
  });

  test('VALUE filter - min+max: 범위 필터', async () => {
    const dt = await openDataTable();
    try {
      const { rows, err } = await dt.read(0n, 100n, 100, {
        selectColumns: ['NAME', 'TIME', 'VALUE'],
        transform: [{
          criteria: { op: 'ALL', value: [] },
          expr: [{ column: 'VALUE', type: 'filter', min: 50, max: 60 }],
        }],
      });
      assert.ok(err === null || err === undefined, `read failed: ${err}`);
      assert.ok(rows.length > 0, 'range filter 결과가 0행');
      for (const r of rows) {
        assert.ok(r.data.VALUE >= 50 && r.data.VALUE <= 60, `VALUE 범위 위반: ${r.data.VALUE}`);
      }
    } finally {
      await dt.close();
    }
  });

});

suite('MachbaseClient - createTagTable', () => {

  test('createTagTable and drop', async () => {
    const srcTable = new TagTable(SRC, SRC_TABLE);
    const dstClient = new MachbaseClient(DST);
    const tmpTable = `_TEST_CREATE_${Date.now()}`;

    try {
      await srcTable.open();
      const schema = await srcTable.getSchema();
      await srcTable.close();

      dstClient.connect();
      dstClient.createTagTable(tmpTable, schema);

      const result = dstClient.selectTableType(tmpTable);
      assert.equal(result.type, 'TAG');

      dstClient.execute(`DROP TABLE ${tmpTable}`);
    } finally {
      try { await srcTable.close(); } catch (_) {}
      dstClient.close();
    }
  });

});

run();
