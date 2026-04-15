'use strict';

const http = require('http');
const mqtt = require('mqtt');
const { ColumnType } = require('./types.js');

const DEFAULT_HTTP_TIMEOUT_MS = 10000;
const DEFAULT_MQTT_TIMEOUT_MS = 10000;
const DEFAULT_MQTT_QOS = 1;
const DEFAULT_MQTT_REPLY_DELAY_MS = 50;
const NS_PER_MS = 1000000n;
const NS_PER_SEC = 1000000000n;

function _sqlLiteral(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function substituteSql(sql, values) {
  if (!values || values.length === 0) return sql;
  let index = 0;
  return String(sql).replace(/\?/g, () => {
    if (index >= values.length) return '?';
    return _sqlLiteral(values[index++]);
  });
}

function _buildServerUrl(config, protocol) {
  const host = String(config.host || '').trim();
  const port = Number(config.port);
  return `${protocol}://${host}:${port}`;
}

function _normalizeBoolean(value, defaultValue) {
  if (value == null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes' || text === 'y') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'n') return false;
  return defaultValue;
}

function _normalizeInteger(value, defaultValue) {
  if (value == null || value === '') return defaultValue;
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : defaultValue;
}

function _buildHttpHeaders(config, extraHeaders) {
  const headers = { ...(extraHeaders || {}) };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  return headers;
}

function _parseJsonPreserveLargeIntegers(text) {
  if (text == null || text === '') return null;
  const patched = String(text).replace(
    /([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g,
    '$1"$2"'
  );
  return JSON.parse(patched);
}

function _parseHttpQueryRows(result) {
  if (!result || !result.success) {
    throw new Error(result && result.reason ? result.reason : 'query failed');
  }
  const columns = Array.isArray(result.data?.columns) ? result.data.columns : [];
  const types = Array.isArray(result.data?.types) ? result.data.types : [];
  const rows = Array.isArray(result.data?.rows) ? result.data.rows : [];
  return rows.map((row) => {
    const out = {};
    for (let i = 0; i < columns.length; i++) {
      const type = String(types[i] || '').toLowerCase();
      const value = row[i];
      if (type === 'datetime' && value != null) {
        out[columns[i]] = parseEpochNsLike(value);
      } else {
        out[columns[i]] = value;
      }
    }
    return out;
  });
}

function parseEpochNsLike(value) {
  if (value == null) return value;
  if (typeof value === 'bigint') return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? BigInt(ms) * NS_PER_MS : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value;
    return BigInt(Math.trunc(value)) * NS_PER_MS;
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (typeof json === 'string' && json.length >= 2 && json[0] === '"' && json[json.length - 1] === '"') {
        return parseEpochNsLike(json.slice(1, -1));
      }
    } catch (_) {}
  }
  const text = String(value).trim();
  if (/^-?\d+$/.test(text)) {
    return BigInt(text);
  }
  const match = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+\-]\d{2}:\d{2})$/);
  const nativeMatch = text.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))? ([+\-]\d{4}) UTC$/);
  if (nativeMatch) {
    const zone = `${nativeMatch[4].slice(0, 3)}:${nativeMatch[4].slice(3)}`;
    return parseEpochNsLike(`${nativeMatch[1]}T${nativeMatch[2]}${nativeMatch[3] ? `.${nativeMatch[3]}` : ''}${zone}`);
  }
  if (!match) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? BigInt(ms) * NS_PER_MS : value;
  }
  const secondText = `${match[1]}${match[3]}`;
  const ms = Date.parse(secondText);
  if (!Number.isFinite(ms)) return value;
  const fraction = ((match[2] || '') + '000000000').slice(0, 9);
  return BigInt(ms) * NS_PER_MS + BigInt(fraction);
}

function formatEpochNsToRfc3339NanoUtc(value) {
  if (value == null) return value;
  let nsValue = value;
  if (typeof nsValue !== 'bigint') {
    nsValue = parseEpochNsLike(nsValue);
    if (typeof nsValue !== 'bigint') return value;
  }
  let seconds = nsValue / NS_PER_SEC;
  let nanos = nsValue % NS_PER_SEC;
  if (nanos < 0) {
    nanos += NS_PER_SEC;
    seconds -= 1n;
  }
  const date = new Date(Number(seconds * 1000n));
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const frac = nanos.toString().padStart(9, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${frac}Z`;
}

function formatEpochNsToRfc3339NanoLocal(value) {
  if (value == null) return value;
  let nsValue = value;
  if (typeof nsValue !== 'bigint') {
    nsValue = parseEpochNsLike(nsValue);
    if (typeof nsValue !== 'bigint') return value;
  }
  let seconds = nsValue / NS_PER_SEC;
  let nanos = nsValue % NS_PER_SEC;
  if (nanos < 0) {
    nanos += NS_PER_SEC;
    seconds -= 1n;
  }
  const date = new Date(Number(seconds * 1000n));
  const yyyy = String(date.getFullYear()).padStart(4, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const frac = nanos.toString().padStart(9, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offsetAbs = Math.abs(offsetMinutes);
  const offHh = String(Math.floor(offsetAbs / 60)).padStart(2, '0');
  const offMi = String(offsetAbs % 60).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${frac}${sign}${offHh}:${offMi}`;
}

function _clearTimer(timerId) {
  if (timerId != null) {
    try { clearTimeout(timerId); } catch (_) {}
  }
}

function _withTimeout(timeoutMs, onTimeout) {
  let timerId = null;
  let finished = false;
  return {
    arm(reject) {
      timerId = setTimeout(() => {
        if (finished) return;
        finished = true;
        try { onTimeout && onTimeout(); } catch (_) {}
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    },
    finish() {
      if (finished) return false;
      finished = true;
      _clearTimer(timerId);
      return true;
    },
  };
}

class SqlLikeClient {
  async connect() {}
  async close() {}

  async query(_sql, _values) {
    throw new Error('not implemented');
  }

  async execute(sql, ...values) {
    return this.query(sql, values);
  }

  splitQualifiedTableName(tableName) {
    const text = String(tableName || '').trim();
    const dot = text.indexOf('.');
    if (dot <= 0 || dot >= text.length - 1) {
      return { owner: null, table: text.toUpperCase() };
    }
    return {
      owner: text.slice(0, dot).trim().toUpperCase(),
      table: text.slice(dot + 1).trim().toUpperCase(),
    };
  }

  async selectTableInfoQualified(tableName) {
    const qualified = this.splitQualifiedTableName(tableName);
    let rows;
    if (!qualified.owner) {
      rows = await this.query(
        'SELECT ID, TYPE FROM M$SYS_TABLES WHERE NAME = ?',
        [qualified.table]
      );
    } else {
      rows = await this.query(
        `
        SELECT t.ID, t.TYPE
        FROM M$SYS_TABLES t
        JOIN M$SYS_USERS u
          ON t.USER_ID = u.USER_ID
        WHERE u.NAME = ?
          AND t.NAME = ?
        `.trim(),
        [qualified.owner, qualified.table]
      );
    }
    if (!rows || rows.length === 0) {
      return { owner: qualified.owner, table: qualified.table, id: null, type: null };
    }
    return {
      owner: qualified.owner,
      table: qualified.table,
      id: rows[0].ID,
      type: rows[0].TYPE,
    };
  }

  async selectTableTypeQualified(tableName) {
    const info = await this.selectTableInfoQualified(tableName);
    if (info.type == null) return { type: 'UNSUPPORTED' };
    switch (info.type) {
      case 6: return { type: 'TAG' };
      case 0: return { type: 'LOG' };
      default: return { type: 'UNSUPPORTED' };
    }
  }

  async selectVisibleTables() {
    return this.query(`
      SELECT t.NAME AS TABLE_NAME,
             t.TYPE AS TABLE_TYPE,
             u.NAME AS OWNER
      FROM M$SYS_TABLES t
      LEFT JOIN M$SYS_USERS u
        ON t.USER_ID = u.USER_ID
      WHERE t.TYPE IN (0, 6)
      ORDER BY t.NAME
    `.trim());
  }

  async selectColumnsByQualifiedTableName(tableName) {
    const info = await this.selectTableInfoQualified(tableName);
    if (info.id == null) return [];
    return this.query(`
      SELECT c.NAME, c.TYPE, c.ID, c.LENGTH, c.FLAG
      FROM M$SYS_COLUMNS c
      WHERE c.TABLE_ID = ?
        AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim(), [info.id]);
  }

  async selectTagDataTables(tableName) {
    const logicalTable = this.splitQualifiedTableName(tableName).table;
    const pattern = `_${logicalTable}_DATA_%`;
    return this.query(`
      SELECT m.NAME AS data_table
      FROM V$STORAGE_TAG_TABLES v, M$SYS_TABLES m
      WHERE v.ID = m.ID AND m.NAME LIKE ?
      ORDER BY m.NAME
    `.trim(), [pattern]);
  }

  async selectMaxRid(tableName) {
    const rows = await this.query(`SELECT MAX(_RID) as max_rid FROM ${tableName}`);
    const raw = rows?.[0]?.max_rid;
    return raw == null ? -1n : BigInt(raw);
  }

  async selectTagNames(logicalTable) {
    const table = this.splitQualifiedTableName(logicalTable).table;
    return this.query(`SELECT _ID, name FROM _${table}_META`);
  }

  async selectTagMeta(logicalTable, metaColNames) {
    const extraCols = metaColNames && metaColNames.length > 0 ? ', ' + metaColNames.join(', ') : '';
    const table = this.splitQualifiedTableName(logicalTable).table;
    return this.query(`SELECT _ID, name${extraCols} FROM _${table}_META`);
  }

  async selectTagMetaById(logicalTable, tagId, metaColNames) {
    const extraCols = metaColNames && metaColNames.length > 0 ? ', ' + metaColNames.join(', ') : '';
    const table = this.splitQualifiedTableName(logicalTable).table;
    const rows = await this.query(`SELECT _ID, name${extraCols} FROM _${table}_META WHERE _ID = ?`, [tagId]);
    return rows?.[0] ?? null;
  }

  async insertTagMeta(logicalTable, values) {
    const placeholders = values.map(() => '?').join(', ');
    return this.execute(`INSERT INTO ${logicalTable} METADATA VALUES (${placeholders})`, ...values);
  }
}

class HttpApiClient extends SqlLikeClient {
  constructor(config) {
    super();
    this.config = { ...config };
    this.timeoutMs = _normalizeInteger(config.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
    this.protocol = String(config.protocol || 'http').trim().toLowerCase() === 'https' ? 'https' : 'http';
  }

  async _request(method, requestPath, body, headers) {
    const url = `${this.protocol}://${this.config.host}:${this.config.port}${requestPath}`;
    const bodyText = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let req = null;
      const timeout = _withTimeout(this.timeoutMs, () => {
        try { req && typeof req.destroy === 'function' && req.destroy(); } catch (_) {}
        try { req && typeof req.close === 'function' && req.close(); } catch (_) {}
      });
      timeout.arm(reject);
      try {
        req = http.request(url, {
          method,
          headers: _buildHttpHeaders(this.config, headers),
        });
        req.on('response', (res) => {
          try {
            const result = _parseJsonPreserveLargeIntegers(res.text());
            if (!timeout.finish()) return;
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const err = new Error(result?.reason || `HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim());
              err.statusCode = res.statusCode;
              reject(err);
              return;
            }
            resolve(result);
          } catch (err) {
            if (!timeout.finish()) return;
            reject(err);
          }
        });
        req.on('error', (err) => {
          if (!timeout.finish()) return;
          reject(err);
        });
        if (bodyText != null) {
          req.write(bodyText);
        }
        req.end();
      } catch (err) {
        if (!timeout.finish()) return;
        reject(err);
      }
    });
  }

  async query(sql, values) {
    const q = substituteSql(sql, values);
    const result = await this._request('POST', '/db/query', {
      q,
      format: 'json',
      timeformat: 'RFC3339Nano',
      tz: 'UTC',
    }, {
      'Content-Type': 'application/json',
    });
    return _parseHttpQueryRows(result);
  }

  async execute(sql, ...values) {
    const q = substituteSql(sql, values);
    const result = await this._request('POST', '/db/query', {
      q,
      format: 'json',
      timeformat: 'RFC3339Nano',
      tz: 'UTC',
    }, {
      'Content-Type': 'application/json',
    });
    if (!result || !result.success) {
      throw new Error(result && result.reason ? result.reason : 'http execute failed');
    }
    return result;
  }

  async writeRows(tableName, columns, rows, method) {
    const table = encodeURIComponent(String(tableName));
    const result = await this._request(
      'POST',
      `/db/write/${table}?method=${encodeURIComponent(method || 'append')}&timeformat=RFC3339Nano&tz=UTC`,
      { data: { columns, rows } },
      { 'Content-Type': 'application/json' }
    );
    if (!result || !result.success) {
      throw new Error(result && result.reason ? result.reason : 'http write failed');
    }
    return result;
  }
}

class MqttApiClient extends SqlLikeClient {
  constructor(config) {
    super();
    this.config = { ...config };
    this.timeoutMs = _normalizeInteger(config.timeoutMs, DEFAULT_MQTT_TIMEOUT_MS);
    this.qos = _normalizeInteger(config.qos, DEFAULT_MQTT_QOS);
    if (this.qos < 0 || this.qos > 2) this.qos = DEFAULT_MQTT_QOS;
    this.replyBase = String(config.replyTopicBase || 'db/reply/rpl').trim() || 'db/reply/rpl';
    this.replyDelayMs = _normalizeInteger(config.replyDelayMs, DEFAULT_MQTT_REPLY_DELAY_MS);
    this.client = null;
    this.connected = false;
    this.busy = false;
  }

  _clientId() {
    if (this.config.clientId) return String(this.config.clientId);
    return `rpl-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  }

  _buildOptions() {
    const options = {
      servers: [_buildServerUrl(this.config, 'tcp')],
      clientId: this._clientId(),
      keepAlive: 30,
      connectRetryDelay: 0,
      cleanStartOnInitialConnection: true,
      connectTimeout: this.timeoutMs,
    };
    if (this.config.token) {
      options.username = String(this.config.token);
      options.password = '';
    }
    return options;
  }

  async connect() {
    if (this.client && this.connected) return;
    if (this.client && !this.connected) {
      try { this.client.close(); } catch (_) {}
      this.client = null;
    }
    const client = new mqtt.Client(this._buildOptions());
    this.client = client;
    await new Promise((resolve, reject) => {
      const timeout = _withTimeout(this.timeoutMs, () => {
        try { client.close(); } catch (_) {}
      });
      const done = (err) => {
        if (!timeout.finish()) return;
        if (err) {
          this.connected = false;
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          this.connected = true;
          resolve();
        }
      };
      timeout.arm(reject);
      client.on('open', () => done(null));
      client.on('error', (err) => done(err));
      client.on('close', () => {
        this.connected = false;
      });
    });
  }

  async close() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.connected = false;
    try {
      client.close();
    } catch (_) {}
  }

  async _runWithReply({ publishTopic, buildPayload, publishUserProperties }) {
    await this.connect();
    if (!this.client) throw new Error('mqtt client is not connected');
    if (this.busy) throw new Error('mqtt client is busy');
    this.busy = true;

    const client = this.client;
    const replyTopic = `${this.replyBase}/${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    try {
      return await new Promise((resolve, reject) => {
        let done = false;
        let timerId = null;
        const finish = (err, result) => {
          if (done) return;
          done = true;
          _clearTimer(timerId);
          try { client.unsubscribe({ topics: [replyTopic] }); } catch (_) {}
          if (typeof client.removeListener === 'function') {
            client.removeListener('message', handleMessage);
            client.removeListener('subscribed', handleSubscribed);
            client.removeListener('error', handleError);
          }
          if (err) reject(err);
          else resolve(result);
        };
        timerId = setTimeout(() => finish(new Error(`timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
        const handleMessage = (msg) => {
          if (!msg || msg.topic !== replyTopic) return;
          try {
            const payloadText = typeof msg.payloadText === 'string'
              ? msg.payloadText
              : (msg.payload ? String(msg.payload) : '');
            const result = payloadText ? JSON.parse(payloadText) : null;
            finish(null, result);
          } catch (err) {
            finish(err);
          }
        };
        const handleSubscribed = (topic, reason) => {
          if (topic !== replyTopic || published) return;
          if (reason >= 128) {
            finish(new Error(`mqtt subscribe failed, reason=${reason}`));
            return;
          }
          published = true;
          try {
            const ack = client.publish(
              publishTopic,
              JSON.stringify(buildPayload(replyTopic)),
              {
                qos: this.qos,
                properties: publishUserProperties
                  ? { user: { ...publishUserProperties, reply: replyTopic } }
                  : undefined,
              }
            );
            if (ack && ack.reasonCode >= 128) {
              finish(new Error(`mqtt publish failed, reasonCode=${ack.reasonCode}`));
            }
          } catch (err) {
            finish(err);
          }
        };
        const handleError = (err) => {
          finish(err instanceof Error ? err : new Error(String(err)));
        };
        let published = false;
        if (typeof client.on === 'function') {
          client.on('message', handleMessage);
          client.on('subscribed', handleSubscribed);
          client.on('error', handleError);
        }

        try {
          client.subscribe(replyTopic, { qos: this.qos });
        } catch (err) {
          finish(err);
        }
      });
    } finally {
      this.busy = false;
    }
  }

  async query(sql, values) {
    const q = substituteSql(sql, values);
    const result = await this._runWithReply({
      publishTopic: 'db/query',
      buildPayload: (replyTopic) => ({
        q,
        format: 'json',
        timeformat: 'RFC3339Nano',
        tz: 'UTC',
        reply: replyTopic,
      }),
    });
    if (!result || !result.success) {
      throw new Error(result && result.reason ? result.reason : 'mqtt query failed');
    }
    return _parseHttpQueryRows(result);
  }

  async execute(sql, ...values) {
    const q = substituteSql(sql, values);
    const result = await this._runWithReply({
      publishTopic: 'db/query',
      buildPayload: (replyTopic) => ({
        q,
        format: 'json',
        timeformat: 'RFC3339Nano',
        tz: 'UTC',
        reply: replyTopic,
      }),
    });
    if (!result || !result.success) {
      throw new Error(result && result.reason ? result.reason : 'mqtt execute failed');
    }
    return result;
  }

  async writeRows(tableName, columns, rows) {
    await this.connect();
    if (!this.client) throw new Error('mqtt client is not connected');
    let ack = null;
    try {
      ack = this.client.publish(
        `db/write/${String(tableName)}`,
        JSON.stringify({
          data: {
            columns,
            rows,
          },
        }),
        {
          qos: this.qos,
          properties: {
            user: {
              method: 'append',
              timeformat: 'RFC3339Nano',
              tz: 'UTC',
            },
          },
        }
      );
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (ack && ack.reasonCode >= 128) {
      throw new Error(`mqtt write failed, reasonCode=${ack.reasonCode}`);
    }
    return ack || { reasonCode: 0 };
  }
}

class MqttPublishClient {
  constructor(config) {
    this.config = { ...config };
    this.timeoutMs = _normalizeInteger(config.timeoutMs, DEFAULT_MQTT_TIMEOUT_MS);
    this.qos = _normalizeInteger(config.qos, DEFAULT_MQTT_QOS);
    if (this.qos < 0 || this.qos > 2) this.qos = DEFAULT_MQTT_QOS;
    this.retain = _normalizeBoolean(config.retain, false);
    this.client = null;
    this.connected = false;
  }

  _clientId() {
    if (this.config.clientId) return String(this.config.clientId);
    return `rpl-pub-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  }

  _buildOptions() {
    const options = {
      servers: [_buildServerUrl(this.config, 'tcp')],
      clientId: this._clientId(),
      keepAlive: 30,
      connectRetryDelay: 0,
      cleanStartOnInitialConnection: true,
      connectTimeout: this.timeoutMs,
    };
    if (this.config.token && !this.config.user) {
      options.username = String(this.config.token);
      options.password = '';
    } else if (this.config.user) {
      options.username = String(this.config.user);
      options.password = this.config.password == null ? '' : String(this.config.password);
    }
    return options;
  }

  async connect() {
    if (this.client && this.connected) return;
    if (this.client && !this.connected) {
      try { this.client.close(); } catch (_) {}
      this.client = null;
    }
    const client = new mqtt.Client(this._buildOptions());
    this.client = client;
    await new Promise((resolve, reject) => {
      const timeout = _withTimeout(this.timeoutMs, () => {
        try { client.close(); } catch (_) {}
      });
      const done = (err) => {
        if (!timeout.finish()) return;
        if (err) {
          this.connected = false;
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          this.connected = true;
          resolve();
        }
      };
      timeout.arm(reject);
      client.on('open', () => done(null));
      client.on('error', (err) => done(err));
      client.on('close', () => {
        this.connected = false;
      });
    });
  }

  async close() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.connected = false;
    try {
      client.close();
    } catch (_) {}
  }

  async publish(topic, payload) {
    await this.connect();
    if (!this.client) throw new Error('mqtt publisher is not connected');
    const ack = this.client.publish(topic, JSON.stringify(payload), {
      qos: this.qos,
      retain: this.retain,
    });
    if (ack && ack.reasonCode >= 128) {
      throw new Error(`mqtt publish failed, reasonCode=${ack.reasonCode}`);
    }
    return ack || { reasonCode: 0 };
  }
}

function createQueryClient(config) {
  const type = String(config?.type || 'native').trim().toLowerCase();
  if (type === 'http') return new HttpApiClient(config);
  if (type === 'mqtt-api') return new MqttApiClient(config);
  if (type === 'mqtt-publish') {
    throw new Error('mqtt-publish does not support query operations');
  }
  return null;
}

module.exports = {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MQTT_TIMEOUT_MS,
  DEFAULT_MQTT_QOS,
  HttpApiClient,
  MqttApiClient,
  MqttPublishClient,
  SqlLikeClient,
  createQueryClient,
  formatEpochNsToRfc3339NanoLocal,
  formatEpochNsToRfc3339NanoUtc,
  parseEpochNsLike,
  substituteSql,
};
