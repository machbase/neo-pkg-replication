'use strict';

/**
 * @fileoverview MachbaseClient 통합 테스트
 *
 * 기본값은 로컬 DB(127.0.0.1:5656)이며 fixtures.js 환경변수 override를 지원한다.
 * 사용법: jsh cgi-bin/tests/client.test.js
 */

const process = require('process');
const path = require('path');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));
const ROOT = path.resolve(TESTS_DIR, '..');

const { suite, test, assert, run } = require(TESTS_DIR + '/test.js');
const { MachbaseClient } = require(ROOT + '/src/db/client.js');
const { SRC, SRC_TABLE } = require(TESTS_DIR + '/fixtures.js');

suite('MachbaseClient', () => {

  test('connect / close', () => {
    const client = new MachbaseClient(SRC);
    client.connect();
    client.close();
  });

  test('selectTableType - TAG', () => {
    const client = new MachbaseClient(SRC);
    try {
      client.connect();
      const result = client.selectTableType(SRC_TABLE);
      assert.equal(result.type, 'TAG');
    } finally {
      client.close();
    }
  });

  test('selectTableType - UNSUPPORTED', () => {
    const client = new MachbaseClient(SRC);
    try {
      client.connect();
      const result = client.selectTableType('NO_SUCH_TABLE_XYZ');
      assert.equal(result.type, 'UNSUPPORTED');
    } finally {
      client.close();
    }
  });

  test('selectTagDataTables', () => {
    const client = new MachbaseClient(SRC);
    try {
      client.connect();
      const parts = client.selectTagDataTables(SRC_TABLE);
      assert.ok(Array.isArray(parts));
      assert.ok(parts.length > 0, 'should have at least one partition');
      assert.ok(parts[0].data_table, 'data_table field missing');
      assert.ok(parts[0].table_id !== undefined && parts[0].table_id !== null, 'table_id field missing');
    } finally {
      client.close();
    }
  });

  test('selectColumnsByTableName', () => {
    const client = new MachbaseClient(SRC);
    try {
      client.connect();
      const cols = client.selectColumnsByTableName(SRC_TABLE);
      assert.ok(Array.isArray(cols));
      assert.ok(cols.length > 0);
      assert.ok(cols[0].NAME);
    } finally {
      client.close();
    }
  });

  test('selectMaxRid', () => {
    const client = new MachbaseClient(SRC);
    try {
      client.connect();
      const parts = client.selectTagDataTables(SRC_TABLE);
      assert.ok(parts.length > 0);
      const rid = client.selectMaxRid(parts[0].data_table);
      assert.ok(typeof rid === 'bigint', 'should return bigint');
    } finally {
      client.close();
    }
  });

  test('selectTagNames', () => {
    const client = new MachbaseClient(SRC);
    try {
      client.connect();
      const tags = client.selectTagNames(SRC_TABLE);
      assert.ok(Array.isArray(tags));
    } finally {
      client.close();
    }
  });

});

run();
