'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));
const ROOT = path.resolve(TESTS_DIR, '..');

const { suite, test, assert, run } = require(TESTS_DIR + '/test.js');
const { MetaSyncStateStore } = require(ROOT + '/src/replication/meta-sync-state.js');
const { MetaNameMapStore } = require(ROOT + '/src/replication/meta-name-map.js');

function tempDir(prefix) {
  const dir = path.join(TESTS_DIR, `.tmp-${prefix}${Date.now()}-${Math.floor(Math.random() * 100000)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

suite('MetaSyncStateStore', () => {

  test('save/load preserves lastMetaUpdateTime separately from lastMetaId', () => {
    const dir = tempDir('rpl-meta-state-');
    const store = new MetaSyncStateStore(dir);
    const err = store.save({
      status: 'ready',
      message: 'ok',
      progress: 100,
      lastMetaId: 12n,
      goalMetaId: 12n,
      lastMetaUpdateTime: '1782117088979728810',
      repTargetCond: { op: 'ALL', value: [] },
      pendingRepTargetCond: null,
      nameTransformRules: [],
      startedAt: '2026-06-23T00:00:00.000Z',
      updatedAt: '2026-06-23T00:00:00.000Z',
    });
    assert.equal(err, null);

    const loaded = store.load();
    assert.ok(loaded.exists);
    assert.equal(loaded.state.lastMetaId, 12n);
    assert.equal(loaded.state.lastMetaUpdateTime, '1782117088979728810');
    const pub = MetaSyncStateStore.toPublic(loaded.state);
    assert.equal(pub.lastMetaId, '12');
    assert.equal(pub.lastMetaUpdateTime, '1782117088979728810');
  });

});

suite('MetaNameMapStore', () => {

  test('save/load normalizes source ID name map', () => {
    const dir = tempDir('rpl-meta-map-');
    const store = new MetaNameMapStore(dir);
    const err = store.save({
      previousMetaUpdateTime: '10',
      lastMetaUpdateTime: '20',
      names: {
        1: 'TAG_A',
        '2': 'TAG_B',
      },
    });
    assert.equal(err, null);

    const loaded = store.load();
    assert.ok(loaded.exists);
    assert.equal(loaded.map.previousMetaUpdateTime, '10');
    assert.equal(loaded.map.lastMetaUpdateTime, '20');
    assert.deepEqual(loaded.map.names, { '1': 'TAG_A', '2': 'TAG_B' });
  });

});

run();
