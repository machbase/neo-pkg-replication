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
const { MachbaseClient } = require(ROOT + '/src/db/client.js');
const { normalizeDatabaseRows, assertDatabaseUsable } = require(ROOT + '/src/db/database.js');
const { listServerDatabases } = require(ROOT + '/src/cgi/validation.js');
const { SRC } = require(TESTS_DIR + '/fixtures.js');

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

  test('database metadata rows are normalized', () => {
    const rows = normalizeDatabaseRows([{
      NAME: 'machbasedb', KIND: 'active', ACCESS_MODE: 'read_write',
      CAN_USE: 1, STATE: 'normal', IS_DEFAULT: 1,
    }]);
    assert.equal(rows[0].name, 'MACHBASEDB');
    assert.equal(rows[0].accessMode, 'READ_WRITE');
    assert.equal(rows[0].canUse, true);
    assert.equal(rows[0].writable, true);
  });

  test('READ_ONLY database is allowed for source but rejected for target', () => {
    const database = {
      name: 'READ_DB', kind: 'ACTIVE', accessMode: 'READ_ONLY',
      canUse: true, writable: false,
    };
    assertDatabaseUsable(database, 'READ_DB', { label: 'source.database', requireWritable: false });
    assert.throws(() => assertDatabaseUsable(database, 'READ_DB', {
      label: 'target.database', requireWritable: true,
    }));
  });

  test('native connection lists the current usable database', () => {
    const client = new MachbaseClient(SRC);
    try {
      client.connect();
      const databases = client.selectDatabases();
      assert.ok(databases.some((database) => database.name === SRC.database));
      const currentRows = client.query('SELECT CURRENT_DATABASE() AS DATABASE_NAME');
      assert.equal(currentRows[0].DATABASE_NAME, String(SRC.database).toUpperCase());
      const current = client.selectDatabaseStatus(SRC.database);
      assert.equal(current.name, SRC.database);
      assert.equal(current.kind, 'ACTIVE');
      assert.equal(current.canUse, true);
    } finally {
      client.close();
    }
  });

  test('native database list ignores an invalid configured database', async () => {
    const databases = await listServerDatabases({
      ...SRC,
      type: 'native',
      database: 'NO_SUCH_DATABASE',
    });
    assert.ok(databases.some((database) => database.name === 'MACHBASEDB'));
  });
});

suite('multi-database remote transports', () => {
  test('HTTP query, execute, and write pass db', async () => {
    const client = new HttpApiClient({
      host: '127.0.0.1', port: 5654, database: 'CODEX_V870_TEST',
    });
    const calls = [];
    client._request = async (method, requestPath, body) => {
      calls.push({ method, requestPath, body });
      return { success: true, data: { columns: [], types: [], rows: [] } };
    };

    await client.query('SELECT 1');
    await client.execute('CREATE TAG TABLE DUMMY (NAME VARCHAR(40) PRIMARY KEY, TIME DATETIME BASETIME, VALUE DOUBLE SUMMARIZED)');
    await client.writeRows('TAG', ['NAME'], [['tag-1']], 'append');

    assert.equal(calls[0].body.db, 'CODEX_V870_TEST');
    assert.equal(calls[1].body.db, 'CODEX_V870_TEST');
    assert.ok(calls[2].requestPath.indexOf('db=CODEX_V870_TEST') >= 0);
  });

  test('HTTP database list maps query response', async () => {
    const client = new HttpApiClient({ host: '127.0.0.1', port: 5654, database: 'MACHBASEDB' });
    let requestBody;
    client._request = async (_method, _path, body) => {
      requestBody = body;
      return ({
      success: true,
      data: {
        columns: ['NAME', 'KIND', 'ACCESS_MODE', 'CAN_USE', 'STATE', 'IS_DEFAULT'],
        types: ['string', 'string', 'string', 'int32', 'string', 'int32'],
        rows: [['MACHBASEDB', 'ACTIVE', 'READ_WRITE', 1, 'NORMAL', 1]],
      },
      });
    };
    const databases = await client.selectDatabases();
    assert.equal(databases.length, 1);
    assert.equal(databases[0].writable, true);
    assert.equal(Object.prototype.hasOwnProperty.call(requestBody, 'db'), false);
  });

  test('MQTT database list omits configured db', async () => {
    const client = new MqttApiClient({
      host: '127.0.0.1', port: 5653, database: 'NO_ACCESS_DB',
    });
    let queryPayload = null;
    client._runWithReply = async ({ buildPayload }) => {
      queryPayload = buildPayload('db/reply/test');
      return { success: true, data: { columns: [], types: [], rows: [] } };
    };

    await client.selectDatabases();
    assert.equal(Object.prototype.hasOwnProperty.call(queryPayload, 'db'), false);
  });

  test('MQTT query, execute, and v5 write properties pass db', async () => {
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
    await client.execute('CREATE TAG TABLE DUMMY (NAME VARCHAR(40) PRIMARY KEY, TIME DATETIME BASETIME, VALUE DOUBLE SUMMARIZED)');
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
