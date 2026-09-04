'use strict';

const process = require('process');
const path = require('path');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));
const ROOT = path.resolve(TESTS_DIR, '..');

const { suite, test, assert, run } = require(TESTS_DIR + '/test.js');
const {
  normalizeServerProfileForSave,
  resolveEndpointConnection,
} = require(ROOT + '/src/cgi/config.js');
const { HttpApiClient, MqttApiClient } = require(ROOT + '/src/db/remote.js');

suite('multi-database configuration', () => {
  test('server profiles default to MACHBASEDB', () => {
    const profile = normalizeServerProfileForSave({
      name: 'local', type: 'native', host: '127.0.0.1', port: 5656,
    });
    assert.equal(profile.database, 'MACHBASEDB');
  });

  test('server profile database is normalized and resolved', () => {
    const profile = normalizeServerProfileForSave({
      name: 'other', type: 'native', host: '127.0.0.1', port: 5656,
      database: 'codex_v870_test', user: 'sys', password: 'manager',
    });
    const resolved = resolveEndpointConnection(
      { server: 'other', table: 'tag' },
      () => profile,
      'source'
    );
    assert.equal(profile.database, 'CODEX_V870_TEST');
    assert.equal(resolved.database, 'CODEX_V870_TEST');
  });
});

suite('multi-database remote transports', () => {
  test('HTTP query and write pass db', async () => {
    const client = new HttpApiClient({
      host: '127.0.0.1', port: 5654, database: 'CODEX_V870_TEST',
    });
    const calls = [];
    client._request = async (method, requestPath, body) => {
      calls.push({ method, requestPath, body });
      return { success: true, data: { columns: [], types: [], rows: [] } };
    };

    await client.query('SELECT 1');
    await client.writeRows('TAG', ['NAME'], [['tag-1']], 'append');

    assert.equal(calls[0].body.db, 'CODEX_V870_TEST');
    assert.ok(calls[1].requestPath.indexOf('db=CODEX_V870_TEST') >= 0);
  });

  test('MQTT query payload and v5 write properties pass db', async () => {
    const client = new MqttApiClient({
      host: '127.0.0.1', port: 5653, database: 'CODEX_V870_TEST',
    });
    let queryPayload = null;
    let writeOptions = null;
    client._runWithReply = async ({ buildPayload }) => {
      queryPayload = buildPayload('db/reply/test');
      return { success: true, data: { columns: [], types: [], rows: [] } };
    };

    await client.query('SELECT 1');
    assert.equal(queryPayload.db, 'CODEX_V870_TEST');

    client.connect = async () => {
      client.connected = true;
      client.client = {
        publish: (_topic, _payload, options) => {
          writeOptions = options;
          return { reasonCode: 0 };
        },
      };
    };
    await client.writeRows('TAG', ['NAME'], [['tag-1']]);
    assert.equal(writeOptions.properties.user.db, 'CODEX_V870_TEST');
  });
});

run();
