'use strict';

/**
 * @fileoverview CheckpointStore 저장/로드 테스트
 *
 * 사용법: jsh cgi-bin/tests/checkpoint.test.js
 */

const fs = require('fs');
const path = require('path');
const process = require('process');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));
const ROOT = path.resolve(TESTS_DIR, '..');

const { suite, test, assert, run } = require(TESTS_DIR + '/test.js');
const CheckpointStore = require(ROOT + '/src/db/checkpoint.js');

const TMP_DIR = path.join(TESTS_DIR, 'tmp-checkpoint-store');

function clean() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

suite('CheckpointStore', () => {

  test('save/load preserves source table ids', () => {
    clean();
    const store = new CheckpointStore(TMP_DIR, '_SRC_DATA_0');
    store.save({
      lastSuccessRid: 10n,
      totalRowsWritten: 3n,
      sourceServer: '127.0.0.1',
      sourceTable: 'SRC_TAG',
      sourceTableId: '100',
      sourceDataTableId: '91',
    }, {
      rowsRead: 3,
      rowsWritten: 3,
      droppedNoMeta: 0,
      skippedExists: 0,
    }, {
      hasMore: false,
    });

    const loaded = store.load();
    assert.equal(loaded.exists, true);
    assert.equal(loaded.cp.sourceTableId, '100');
    assert.equal(loaded.cp.sourceDataTableId, '91');
    assert.equal(loaded.cp.sourceDataTable, '_SRC_DATA_0');
    clean();
  });

});

run();
