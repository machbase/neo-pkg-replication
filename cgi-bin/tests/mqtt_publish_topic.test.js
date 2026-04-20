'use strict';

/**
 * @fileoverview mqtt-publish topic validation / runtime selection test
 *
 * 기본값은 로컬 DB(127.0.0.1:5656) source fixture를 사용한다.
 * 사용법: jsh cgi-bin/tests/mqtt_publish_topic.test.js
 */

const process = require('process');
const path = require('path');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));
const ROOT = path.resolve(TESTS_DIR, '..');

const { suite, test, assert, run } = require(TESTS_DIR + '/test.js');
const { prepareReplicatorConfig } = require(ROOT + '/src/cgi/validation.js');
const { LogTable, TagTable } = require(ROOT + '/src/db/table.js');
const { ColumnType, Column, TableSchema } = require(ROOT + '/src/db/client.js');
const { FLAG_PRIMARY, FLAG_BASETIME } = require(ROOT + '/src/db/types.js');
const { SRC, SRC_TABLE } = require(TESTS_DIR + '/fixtures.js');

function makeInlineConfig(overrides = {}) {
  const config = {
    source: {
      ...SRC,
      type: 'native',
      table: SRC_TABLE,
      columns: ['NAME', 'TIME', 'VALUE'],
      meta: [],
      rep_target_cond: { op: 'ALL', value: [] },
      transform: null,
    },
    target: {
      host: '127.0.0.1',
      port: 5653,
      type: 'mqtt-publish',
      token: '',
      qos: 1,
      retain: false,
      table: 'TOPIC_TARGET',
      topic: 'factory/line1/topic-target',
      columns: ['NAME', 'TIME', 'VALUE'],
      meta: [],
    },
    startMode: 'full',
    queryLimit: 100,
    pollIntervalMs: 1000,
    shutdownTimeoutMs: 30000,
    onSaveFailure: 'continue',
    retry: null,
    logging: { level: 'info', maxFiles: 5 },
  };
  const next = { ...config, ...overrides };
  if (overrides.source) next.source = { ...config.source, ...overrides.source };
  if (overrides.target) next.target = { ...config.target, ...overrides.target };
  return next;
}

function makeTagSchema() {
  return new TableSchema('TAG', 'TOPIC_TARGET', [
    new Column('NAME', ColumnType.VARCHAR, 0, FLAG_PRIMARY, 80),
    new Column('TIME', ColumnType.DATETIME, 1, FLAG_BASETIME, 0),
    new Column('VALUE', ColumnType.DOUBLE, 2, 0, 0),
  ]);
}

function makeLogSchema() {
  return new TableSchema('LOG', 'TOPIC_TARGET', [
    new Column('TIME', ColumnType.DATETIME, 0, 0, 0),
    new Column('VALUE', ColumnType.DOUBLE, 1, 0, 0),
  ]);
}

suite('mqtt-publish topic - validation', () => {

  test('explicit target.topic is preserved for mqtt-publish', async () => {
    const prepared = await prepareReplicatorConfig(makeInlineConfig());
    assert.equal(prepared.storedConfig.target.topic, 'factory/line1/topic-target');
    assert.equal(prepared.runtimeConfig.target.topic, 'factory/line1/topic-target');
    assert.equal(prepared.warnings.length, 0);
  });

  test('missing target.topic uses legacy table-based fallback with warning', async () => {
    const prepared = await prepareReplicatorConfig(makeInlineConfig({
      target: {
        topic: null,
        table: 'TOPIC_FALLBACK',
      },
    }));
    assert.equal(prepared.storedConfig.target.topic, null);
    assert.equal(prepared.runtimeConfig.target.topic, 'topic_fallback');
    assert.ok(prepared.warnings.some((item) => item.indexOf('legacy fallback') >= 0), 'legacy fallback warning missing');
  });

  test('wildcards in target.topic are rejected', async () => {
    await assert.rejects(async () => {
      await prepareReplicatorConfig(makeInlineConfig({
        target: { topic: 'factory/+/topic' },
      }));
    }, 'target.topic with wildcard should be rejected');
  });

  test('target.topic is rejected for non mqtt-publish target', async () => {
    await assert.rejects(async () => {
      await prepareReplicatorConfig(makeInlineConfig({
        target: {
          type: 'http',
          port: 5654,
          protocol: 'http',
          topic: 'factory/line1/topic-target',
        },
      }));
    }, 'target.topic on http target should be rejected');
  });

});

suite('mqtt-publish topic - runtime publish', () => {

  test('TagTable append publishes to explicit target.topic', async () => {
    const table = new TagTable({
      type: 'mqtt-publish',
      host: '127.0.0.1',
      port: 5653,
      topic: 'factory/line1/tag-stream',
      qos: 1,
      retain: false,
    }, 'TOPIC_TARGET');
    table.setSchema(makeTagSchema());

    const calls = [];
    table.writer = {
      async publish(topic, payload) {
        calls.push({ topic, payload });
        return { reasonCode: 0 };
      },
    };

    const err = await table.append([
      { NAME: 'TAG-01', TIME: 1713340800000000000n, VALUE: 12.5 },
    ]);

    assert.equal(err, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].topic, 'factory/line1/tag-stream');
    assert.deepEqual(calls[0].payload.columns, ['NAME', 'TIME', 'VALUE']);
  });

  test('LogTable append uses legacy lower-case table fallback when topic is absent', async () => {
    const table = new LogTable('TOPIC_TARGET', {
      type: 'mqtt-publish',
      host: '127.0.0.1',
      port: 5653,
      qos: 1,
      retain: false,
    });
    table.setSchema(makeLogSchema());

    const calls = [];
    table.writer = {
      async publish(topic, payload) {
        calls.push({ topic, payload });
        return { reasonCode: 0 };
      },
    };

    const err = await table.append([
      { TIME: 1713340800000000000n, VALUE: 7.25 },
    ]);

    assert.equal(err, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].topic, 'topic_target');
    assert.deepEqual(calls[0].payload.columns, ['TIME', 'VALUE']);
  });

});

run();
