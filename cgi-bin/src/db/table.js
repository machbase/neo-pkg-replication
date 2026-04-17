'use strict';

const { ColumnType, Column, TableSchema, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA, FLAG_PRIMARY } = require('./types.js');
const { MachbaseClient } = require('./client.js');
const { MachbaseStream } = require('./stream.js');
const { HttpApiClient, MqttApiClient, MqttPublishClient, createQueryClient, formatEpochNsToRfc3339NanoLocal, formatEpochNsToRfc3339NanoUtc } = require('./remote.js');
const { getInstance: getLogger } = require('../lib/logger.js');
const { buildQueryFilterSql } = require('../replication/rules.js');

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────


/**
 * source batch 순서대로 target 존재 여부를 확인하여 첫 번째 miss row의 0-based 인덱스를 반환.
 * startup integrity에서만 사용한다.
 *
 * @param {string} logicalTable - 논리 테이블명
 * @param {TableSchema} schema
 * @param {Array<{ canonical: string, time: bigint }>} rows
 * @param {MachbaseClient} client - target 독립 연결
 * @returns {{ firstMissIdx: number|null, err: Error|null }}
 */
async function _findFirstMissRow(logicalTable, schema, rows, client) {
  if (!rows || rows.length === 0) return { firstMissIdx: null, err: null };

  const keyCol = schema.columns.find(c => c.flag & FLAG_PRIMARY);
  const baseTimeCol = schema.columns.find(c => c.flag & FLAG_BASETIME);
  if (!keyCol || !baseTimeCol) {
    return { firstMissIdx: null, err: new Error(`findFirstMissRow: PRIMARY/BASETIME column not found in schema for '${logicalTable}'`) };
  }
  try {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let sql =
        `SELECT 1 AS EXISTS_ROW FROM ${logicalTable} ` +
        `WHERE ${keyCol.name} = ? AND ${baseTimeCol.name} = ? LIMIT 1`;
      let params = [r.canonical, r.time];
      if (typeof r.time === 'bigint') {
        sql =
          `SELECT 1 AS EXISTS_ROW FROM ${logicalTable} ` +
          `WHERE ${keyCol.name} = ? AND ${baseTimeCol.name} = ${r.time.toString()} LIMIT 1`;
        params = [r.canonical];
      }
      const foundRows = await client.query(sql, params);
      if (!foundRows || foundRows.length === 0) {
        return { firstMissIdx: i, err: null };
      }
    }
    return { firstMissIdx: null, err: null };
  } catch (err) {
    getLogger().error('table', { table: logicalTable, msg: err.message });
    return { firstMissIdx: null, err };
  }
}

function _stringifyParams(params) {
  try {
    return JSON.stringify(Array.isArray(params) ? params : []);
  } catch (_) {
    return '[]';
  }
}

function _toEpochMs(value) {
  if (value == null) return value;
  if (typeof value === 'bigint') {
    return Number(value / 1000000n);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : value;
}

function _isIntegerFamilyColumn(column) {
  if (!column || !column.columnType) return false;
  return column.columnType === ColumnType.SHORT
    || column.columnType === ColumnType.USHORT
    || column.columnType === ColumnType.INTEGER
    || column.columnType === ColumnType.UINTEGER
    || column.columnType === ColumnType.LONG
    || column.columnType === ColumnType.ULONG;
}

function _coerceIntegerFamilyValue(value) {
  if (value == null) return value;
  if (typeof value === 'bigint') {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
    if (value <= maxSafe && value >= minSafe) {
      return Number(value);
    }
    return value.toString();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const text = String(value).trim();
  if (text === '') return null;
  if (/^-?\d+$/.test(text)) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : text;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : value;
}

/**
 * transport별 write payload 직렬화 차이를 흡수한다.
 *
 * 의도:
 * - DB가 직접 해석하는 native/http/mqtt-api 경로는 DATETIME을 UTC RFC3339Nano로 맞춰
 *   target 쪽 time parsing 결과를 일관되게 유지한다.
 * - mqtt-publish는 generic sink이므로 DB 전용 timeformat 약속이 없고, 기존 consumer 기대값에 맞춰
 *   local timestamp 문자열을 보낸다.
 * - http/mqtt-api는 JSON 숫자 직렬화 과정에서 정수 계열이 흔들리지 않도록 integer family를 한 번 더 정리한다.
 *
 * 주의:
 * - 여기 포맷을 바꾸면 restart integrity나 외부 consumer가 기대하는 payload 모양이 함께 바뀐다.
 */
function _normalizeWriteValue(column, value, targetType) {
  if (value == null) return value;
  if (targetType === 'native' && column && column.columnType === ColumnType.DATETIME) {
    return formatEpochNsToRfc3339NanoUtc(value);
  }
  if (targetType === 'http' && column && column.columnType === ColumnType.DATETIME) {
    return formatEpochNsToRfc3339NanoUtc(value);
  }
  if (targetType === 'mqtt-api' && column && column.columnType === ColumnType.DATETIME) {
    return formatEpochNsToRfc3339NanoUtc(value);
  }
  if (targetType === 'mqtt-publish' && column && column.columnType === ColumnType.DATETIME) {
    return formatEpochNsToRfc3339NanoLocal(value);
  }
  if ((targetType === 'http' || targetType === 'mqtt-api') && _isIntegerFamilyColumn(column)) {
    return _coerceIntegerFamilyValue(value);
  }
  return value;
}

function _createQueryClient(config) {
  const type = String(config?.type || 'native').trim().toLowerCase();
  if (type === 'native') return new MachbaseClient(config);
  const client = createQueryClient(config);
  if (!client) {
    throw new Error(`query client not supported for type '${type}'`);
  }
  return client;
}

function _createWriter(config) {
  const type = String(config?.type || 'native').trim().toLowerCase();
  // query 경로와 writer 경로를 분리해 두어, write-only transport도 동일한 Table API로 다룰 수 있게 한다.
  if (type === 'http') return new HttpApiClient(config);
  if (type === 'mqtt-api') return new MqttApiClient(config);
  if (type === 'mqtt-publish') return new MqttPublishClient(config);
  return null;
}


function _buildSelectColumns(schema, requestedColumns) {
  const seen = {};
  const result = [];
  const ordered = schema.columns
    .filter((column) => !(column.flag & FLAG_METADATA))
    .map((column) => column.name);

  if (!Array.isArray(requestedColumns) || requestedColumns.length === 0) {
    return ordered;
  }

  for (const columnName of ordered) {
    if (requestedColumns.includes(columnName) && !seen[columnName]) {
      seen[columnName] = true;
      result.push(columnName);
    }
  }
  return result;
}

function _buildSelectList(schema, selectedColumns, config) {
  const type = String(config?.type || 'native').trim().toLowerCase();
  return selectedColumns.map((name) => {
    const column = schema.columns.find((item) => item.name === name);
    if (type === 'native' && column && column.columnType === ColumnType.DATETIME) {
      return `TO_CHAR(TO_TIMESTAMP(${name})) AS ${name}`;
    }
    return name;
  }).join(', ');
}

/**
 * LOG 테이블 복제 클래스
 *
 * 스키마, append 스트림을 소유하며 LOG 테이블의 read/write를 담당한다.
 */
class LogTable {
  /**
   * @param {string} logicalTable - 논리 테이블명
   * @param {object} config - MachbaseClient 접속 설정
   */
  constructor(logicalTable, config) {
    this.qualifiedTable = logicalTable;
    this.logicalTable = (new MachbaseClient(config)).splitQualifiedTableName(logicalTable).table;
    this.config = config;
    this.client = null;
    this.writer = null;
    /** @type {TableSchema|null} */
    this.schema = null;
    /** @type {MachbaseStream|null} */
    this.stream = null;
    this.appendColumns = null;
  }

  /**
   * 테이블 컬럼 목록 조회
   * @returns {Array<{ NAME: string, TYPE: number, ID: number, LENGTH: number, FLAG: number }>}
   */
  async getColumns() {
    return this.client.selectColumnsByQualifiedTableName(this.qualifiedTable);
  }

  /**
   * 스키마 조회 후 반환
   * @returns {TableSchema}
   */
  async getSchema() {
    const rows = await this.getColumns();
    const columns = rows.map(r => new Column(r.NAME, ColumnType.fromCode(r.TYPE), r.ID, 'data', r.LENGTH ?? 0));
    return new TableSchema('LOG', this.logicalTable, columns);
  }

  /**
   * this.schema 설정
   * @param {TableSchema} schema
   */
  setSchema(schema) {
    this.schema = schema;
  }

  setAppendColumns(columnNames) {
    this.appendColumns = Array.isArray(columnNames) ? columnNames.slice() : null;
  }

  /**
   * DB 연결
   */
  async open() {
    const type = String(this.config?.type || 'native').toLowerCase();
    if (type === 'native' || type === 'http') {
      this.client = _createQueryClient(this.config);
      await this.client.connect();
      if (type === 'http') this.writer = this.client;
      return;
    }
    this.writer = _createWriter(this.config);
    if (this.writer && typeof this.writer.connect === 'function') {
      await this.writer.connect();
    }
  }

  /**
   * append 스트림 열기 (schema 없으면 자동 조회)
   * @returns {Error|null}
   */
  openStream() {
    if (!this.schema) {
      return new Error(`schema is required before openStream for '${this.logicalTable}'`);
    }
    const appendColumnNames = Array.isArray(this.appendColumns) && this.appendColumns.length > 0
      ? this.appendColumns.slice()
      : this.schema.columns.map((column) => column.name);
    this.stream = new MachbaseStream();
    return this.stream.open(
      this.client,
      this.qualifiedTable,
      appendColumnNames.map((name) => {
        const column = this.schema.columns.find((item) => item.name === name);
        return { name, type: column ? column.sqlType() : ColumnType.VARCHAR.ddlType || 'VARCHAR(400)' };
      })
    );
  }

  /**
   * append 스트림 + DB 연결 닫기
   * @returns {Error|null}
   */
  async close() {
    let firstErr = null;
    const client = this.client;
    const writer = this.writer;
    this.writer = null;
    if (this.stream) {
      firstErr = this.stream.close();
      this.stream = null;
    }
    if (client) {
      try { await client.close(); } catch (err) { if (!firstErr) firstErr = err; }
      this.client = null;
    }
    if (writer && writer !== client) {
      try { await writer.close(); } catch (err) { if (!firstErr) firstErr = err; }
    }
    return firstErr;
  }

  /**
   * 테이블의 최대 RID 조회
   * @returns {bigint}
   */
  async getMaxRid() {
    return this.client.selectMaxRid(this.qualifiedTable);
  }


  /**
   * RID 기반 배치 읽기
   * @param {bigint} startRid
   * @param {bigint} endRid
   * @param {number} [limit=1000]
   * @param {{ selectColumns?: string[], repTargetCond?: object|null, transform?: Array|null }} [options]
   * @returns {{ rows: Array<{ rid: bigint, data: object }>, err: Error|null }}
   */
  async read(startRid, endRid, limit = 1000, options) {
    const colNames = _buildSelectColumns(this.schema, options?.selectColumns);
    const colList = ['_RID', _buildSelectList(this.schema, colNames, this.config)].join(', ');
    const filterSql = buildQueryFilterSql(options?.repTargetCond, options?.transform, {
      tableType: 'LOG',
      logicalTable: this.logicalTable,
      primaryColumnName: null,
    });
    const hintEndRid = endRid + 1n;
    const whereClause = filterSql.sql !== '1=1' ? ` WHERE ${filterSql.sql}` : '';
    const sql = `SELECT /*+ RID_RANGE(${this.qualifiedTable}, ${startRid}, ${hintEndRid}) */ ${colList} FROM ${this.qualifiedTable}${whereClause} ORDER BY _RID LIMIT ${limit}`;
    getLogger().trace('table_read_query', {
      table: this.logicalTable,
      startRid: String(startRid),
      endRid: String(endRid),
      sql,
      params: _stringifyParams(filterSql.params),
    });
    try {
      const sqlRows = (await this.client.query(sql, filterSql.params)) || [];
      const result = [];
      for (const row of sqlRows) {
        if (row._RID == null) {
          getLogger().warn('table', { msg: `row with null _RID skipped in ${this.logicalTable}` });
          continue;
        }
        const rid = BigInt(row._RID);
        const data = {};
        for (const col of colNames) data[col] = row[col];
        result.push({ rid, data });
      }
      return { rows: result, err: null };
    } catch (err) {
      getLogger().error('table', { table: this.logicalTable, msg: err.message });
      return { rows: [], err };
    }
  }

  /**
   * 배치 데이터 append
   * @param {Array<object>} rows - 컬럼명 기준 객체 배열
   * @returns {Error|null}
   */
  async append(rows) {
    if (!rows || rows.length === 0) return null;

    const type = String(this.config?.type || 'native').toLowerCase();
    const appendColumnNames = Array.isArray(this.appendColumns) && this.appendColumns.length > 0
      ? this.appendColumns.slice()
      : this.schema.columns.map((column) => column.name);
    const matrix = rows.map(row =>
      appendColumnNames.map((name) => {
        const col = this.schema.columns.find((item) => item.name === name) || { name, columnType: null };
        const val = _normalizeWriteValue(col, row[col.name], type);
        if (typeof val === 'number' && !isFinite(val)) {
          getLogger().warn('stream', { table: this.logicalTable, col: col.name, val: String(val), msg: 'non-finite value will be stored as null' });
        }
        return val;
      })
    );
    if (type === 'native') {
      if (!this.stream) {
        const err = this.openStream();
        if (err) return err;
      }
      return this.stream.append(matrix);
    }
    if (type === 'http') {
      try {
        await this.writer.writeRows(this.qualifiedTable, appendColumnNames, matrix, 'append');
        return null;
      } catch (err) {
        return err;
      }
    }
    if (type === 'mqtt-api') {
      try {
        await this.writer.writeRows(this.qualifiedTable, appendColumnNames, matrix);
        return null;
      } catch (err) {
        return err;
      }
    }
    if (type === 'mqtt-publish') {
      try {
        await this.writer.publish(String(this.qualifiedTable || '').toLowerCase(), {
          columns: appendColumnNames,
          rows: matrix,
        });
        return null;
      } catch (err) {
        return err;
      }
    }
    return new Error(`append not supported for type '${type}'`);
  }

  /**
   * source batch 순서대로 target 존재 여부를 확인하여 첫 번째 miss row의 0-based 인덱스를 반환
   * @param {Array<{ canonical: string, time: bigint }>} rows
   * @param {MachbaseClient} client
   * @param {string} suffix
   * @returns {{ firstMissIdx: number|null, err: Error|null }}
   */
  async findFirstMissRow(rows, client, suffix) {
    return _findFirstMissRow(this.logicalTable, this.schema, rows, client);
  }
}


/**
 * TAG alias 캐시
 */
class TagMetaCache {
  constructor() {
    /** @type {Map<bigint, string>} */
    this._map = new Map();
  }

  get size() { return this._map.size; }

  /**
   * tagId에 대한 이름과 메타 정보를 캐시에 등록한다.
   * @param {number|bigint} tagId
   * @param {string} name
   * @param {object} [meta={}]
   */
  set(tagId, name, meta = {}) {
    if (name.includes('\x00')) {
      throw new Error(`tag name contains null byte: ${JSON.stringify(name)}`);
    }
    this._map.set(BigInt(tagId), { name, meta });
  }

  /**
   * tagId에 해당하는 이름을 반환한다. 없으면 undefined를 반환한다.
   * @param {number|bigint} tagId
   * @returns {string|undefined}
   */
  get(tagId) {
    return this._map.get(BigInt(tagId))?.name;
  }

  /**
   * tagId를 이름으로 변환하고 nameRule을 적용한다.
   * @param {number|bigint} tagId
   * @param {{ prefix?: string, suffix?: string }|null} nameRule
   * @returns {{ name: string|null, canonical: string|null, meta: object, status: 'ok'|'drop_not_found' }}
   */
  resolve(tagId, nameRule) {
    const entry = this._map.get(BigInt(tagId));
    if (entry === undefined) return { name: null, canonical: null, meta: {}, status: 'drop_not_found' };
    const canonical = TagMetaCache._applyNameRule(entry.name, nameRule);
    return { name: entry.name, canonical, meta: entry.meta, status: 'ok' };
  }

  /**
   * tagName에 nameRule의 prefix/suffix를 적용한다.
   * @param {string} tagName
   * @param {{ prefix?: string, suffix?: string }|null} nameRule
   * @returns {string}
   */
  static _applyNameRule(tagName, nameRule) {
    if (!nameRule) return tagName;
    let name = tagName;
    if (nameRule.prefix) name = nameRule.prefix + name;
    if (nameRule.suffix) name = name + nameRule.suffix;
    return name;
  }
}

/**
 * TAG 테이블 복제 클래스
 */
class TagTable {
  /**
   * @param {object} config - MachbaseClient 접속 설정
   * @param {string} logicalTable - 논리 테이블명
   */
  constructor(config, logicalTable) {
    this.qualifiedTable = logicalTable;
    this.logicalTable = (new MachbaseClient(config)).splitQualifiedTableName(logicalTable).table;
    this.config = config;
    this.client = null;
    this.writer = null;
    /** @type {TableSchema|null} */
    this.schema = null;
    /** @type {MachbaseStream|null} */
    this.stream = null;
    this.appendColumns = null;
  }

  /**
   * 컬럼 목록 조회
   * @returns {Array<{ NAME: string, TYPE: number, ID: number, LENGTH: number, FLAG: number }>}
   */
  async getColumns() {
    return this.client.selectColumnsByQualifiedTableName(this.qualifiedTable);
  }

  /**
   * TAG 스키마 조회 후 반환
   * @returns {TableSchema}
   */
  async getSchema() {
    const rows = await this.getColumns();
    const cols = [];
    for (const r of rows) {
      if (r.NAME.startsWith('_')) continue;
      cols.push(new Column(r.NAME, ColumnType.fromCode(r.TYPE), r.ID, r.FLAG ?? 0, r.LENGTH ?? 0));
    }

    if (cols.length === 0) {
      throw new Error(`TagTable.getSchema: no data columns found for '${this.logicalTable}'`);
    }

    return new TableSchema('TAG', this.logicalTable, cols);
  }

  /**
   * TAG 데이터 파티션 목록 조회
   * @returns {Array<{ data_table: string }>}
   */
  async getDataTables() {
    return this.client.selectTagDataTables(this.logicalTable);
  }

  /**
   * this.schema 설정
   * @param {TableSchema} schema
   */
  setSchema(schema) {
    this.schema = schema;
  }

  setAppendColumns(columnNames) {
    this.appendColumns = Array.isArray(columnNames) ? columnNames.slice() : null;
  }

  /**
   * DB 연결
   */
  async open() {
    const type = String(this.config?.type || 'native').toLowerCase();
    if (type === 'native' || type === 'http') {
      this.client = _createQueryClient(this.config);
      await this.client.connect();
      if (type === 'http') this.writer = this.client;
      return;
    }
    this.writer = _createWriter(this.config);
    if (this.writer && typeof this.writer.connect === 'function') {
      await this.writer.connect();
    }
  }

  /**
   * append 스트림 열기 (schema 없으면 자동 조회)
   * @returns {Error|null}
   */
  openStream() {
    if (!this.schema) {
      return new Error(`schema is required before openStream for '${this.logicalTable}'`);
    }
    const appendColumnNames = Array.isArray(this.appendColumns) && this.appendColumns.length > 0
      ? this.appendColumns.slice()
      : this.schema.columns.map((column) => column.name);
    this.stream = new MachbaseStream();
    return this.stream.open(
      this.client,
      this.qualifiedTable,
      appendColumnNames.map((name) => {
        const column = this.schema.columns.find((item) => item.name === name);
        return { name, type: column ? column.sqlType() : 'VARCHAR(400)' };
      })
    );
  }

  /**
   * append 스트림 + DB 연결 닫기
   * @returns {Error|null}
   */
  async close() {
    let firstErr = null;
    const client = this.client;
    const writer = this.writer;
    this.writer = null;
    if (this.stream) {
      firstErr = this.stream.close();
      this.stream = null;
    }
    if (client) {
      try { await client.close(); } catch (err) { if (!firstErr) firstErr = err; }
      this.client = null;
    }
    if (writer && writer !== client) {
      try { await writer.close(); } catch (err) { if (!firstErr) firstErr = err; }
    }
    return firstErr;
  }

  /**
   * 논리 테이블 전체 조회
   * @returns {Array<object>}
   */
  async read() {
    const colNames = this.schema.columns.map(c => c.name);
    const colList = colNames.join(', ');
    const sql = `SELECT ${colList} FROM ${this.qualifiedTable}`;
    try {
      const rows = await this.client.query(sql);
      return (rows || []).map(row => {
        const data = {};
        for (const col of colNames) {
          data[col] = row[col];
        }
        return data;
      });
    } catch (err) {
      getLogger().error('table', { table: this.logicalTable, msg: err.message });
      return [];
    }
  }

  /**
   * 배치 데이터 append
   * @param {Array<object>} rows - 컬럼명 기준 객체 배열
   * @returns {Error|null}
   */
  async append(rows) {
    if (!rows || rows.length === 0) return null;

    const type = String(this.config?.type || 'native').toLowerCase();
    const appendColumnNames = Array.isArray(this.appendColumns) && this.appendColumns.length > 0
      ? this.appendColumns.slice()
      : this.schema.columns.map((column) => column.name);
    const matrix = rows.map(row =>
      appendColumnNames.map((name) => {
        const col = this.schema.columns.find((item) => item.name === name) || { name, columnType: null };
        const val = _normalizeWriteValue(col, row[col.name], type);
        if (typeof val === 'number' && !isFinite(val)) {
          getLogger().warn('stream', { table: this.logicalTable, col: col.name, val: String(val), msg: 'non-finite value will be stored as null' });
        }
        return val;
      })
    );
    if (type === 'native') {
      if (!this.stream) {
        const err = this.openStream();
        if (err) return err;
      }
      return this.stream.append(matrix);
    }
    if (type === 'http') {
      try {
        await this.writer.writeRows(this.qualifiedTable, appendColumnNames, matrix, 'append');
        return null;
      } catch (err) {
        return err;
      }
    }
    if (type === 'mqtt-api') {
      try {
        await this.writer.writeRows(this.qualifiedTable, appendColumnNames, matrix);
        return null;
      } catch (err) {
        return err;
      }
    }
    if (type === 'mqtt-publish') {
      try {
        await this.writer.publish(String(this.qualifiedTable || '').toLowerCase(), {
          columns: appendColumnNames,
          rows: matrix,
        });
        return null;
      } catch (err) {
        return err;
      }
    }
    return new Error(`append not supported for type '${type}'`);
  }

  /**
   * source batch 순서대로 target 존재 여부를 확인하여 첫 번째 miss row의 0-based 인덱스를 반환
   * @param {Array<{ canonical: string, time: bigint }>} rows
   * @param {MachbaseClient} client
   * @param {string} suffix
   * @returns {{ firstMissIdx: number|null, err: Error|null }}
   */
  async findFirstMissRow(rows, client, suffix) {
    return _findFirstMissRow(this.logicalTable, this.schema, rows, client);
  }

  /**
   * TAG META 전체 로드 (nameFilter 조건 적용)
   * @param {{ in?: string[], like?: string }|null} [nameFilter=null]
   * @returns {TagMetaCache}
   */
  async loadTagMetaCache(nameFilter = null) {
    const metaColNames = this.schema
      ? this.schema.columns.filter(c => c.flag & FLAG_METADATA).map(c => c.name)
      : [];
    const extraCols = metaColNames.length > 0 ? ', ' + metaColNames.join(', ') : '';

    let whereClauses = [];
    let params = [];
    if (nameFilter?.in && nameFilter.in.length > 0) {
      whereClauses.push(`name IN (${nameFilter.in.map(() => '?').join(', ')})`);
      params.push(...nameFilter.in);
    }
    if (nameFilter?.like) {
      whereClauses.push(`name LIKE ?`);
      params.push(nameFilter.like);
    }
    const where = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
    const sql = `SELECT _ID, name${extraCols} FROM _${this.logicalTable}_META${where}`;

    const rows = await this.client.query(sql, params.length > 0 ? params : undefined);
    const cache = new TagMetaCache();
    for (const row of (rows || [])) {
      const meta = {};
      for (const col of metaColNames) meta[col] = row[col];
      cache.set(row._ID, row.name, meta);
    }
    return cache;
  }
}

/**
 * TAG 데이터 파티션 클래스
 */
class TagDataTable {
  /**
   * @param {string} dataTable - 파티션 테이블명 (예: _TAG_DATA_0)
   * @param {object} config - MachbaseClient 접속 설정
   */
  constructor(dataTable, config) {
    this.dataTable = dataTable;
    this.config = config;
    this.client = null;
    /** @type {string} TAG 논리 테이블명 — '_TAG_DATA_0' → 'TAG' */
    this.logicalTable = dataTable.replace(/^_/, '').replace(/_DATA_\d+$/, '');
    /** @type {TableSchema|null} */
    this.schema = null;
    /** @type {TagMetaCache|null} */
    this.aliasCache = null;
  }

  /**
   * this.schema 설정
   * @param {TableSchema} schema
   */
  setSchema(schema) {
    this.schema = schema;
  }

  /**
   * DB 연결
   */
  async open() {
    this.client = _createQueryClient(this.config);
    await this.client.connect();
  }

  /**
   * DB 연결 닫기
   * @returns {Error|null}
   */
  async close() {
    if (this.client) {
      try { await this.client.close(); } catch (_) {}
      this.client = null;
    }
    return null;
  }

  /**
   * 파티션의 최대 RID 조회
   * @returns {bigint}
   */
  async getMaxRid() {
    return this.client.selectMaxRid(this.dataTable);
  }

  /**
   * _TAG_META 전체 로드 후 내부 aliasCache 구성 (metadata 컬럼 값 포함)
   * @returns {Error|null}
   */
  async cacheTagMetaAll() {
    try {
      const metaColNames = this.schema
        ? this.schema.columns.filter(c => c.flag & FLAG_METADATA).map(c => c.name)
        : [];
      const rows = await this.client.selectTagMeta(this.logicalTable, metaColNames);
      this.aliasCache = new TagMetaCache();
      for (const row of (rows || [])) {
        const meta = {};
        for (const col of metaColNames) meta[col] = row[col];
        this.aliasCache.set(row._ID, row.name, meta);
      }
      return null;
    } catch (err) {
      getLogger().error('table', { msg: `cacheTagMetaAll failed: ${err.message}` });
      return err;
    }
  }

  /**
   * 캐시 miss 시 DB에서 tag_id → name을 단건 조회하여 캐시에 등록.
   * @param {*} tagId
   * @returns {boolean}
   */
  async cacheTagMetaByTagID(tagId) {
    const metaColNames = this.schema
      ? this.schema.columns.filter(c => c.flag & FLAG_METADATA).map(c => c.name)
      : [];
    const row = await this.client.selectTagMetaById(this.logicalTable, tagId, metaColNames);
    if (row == null) return false;
    const meta = {};
    for (const col of metaColNames) meta[col] = row[col];
    this.aliasCache.set(row._ID, row.name, meta);
    return true;
  }

  /**
   * RID 기반 배치 읽기
   *
   * @param {bigint} startRid
   * @param {bigint} endRid
   * @param {number} [limit=1000]
   * @param {{ selectColumns?: string[], repTargetCond?: object|null, transform?: Array|null }} [options]
   * @returns {{ rows: Array<{ rid: bigint, data: object }>, err: Error|null }}
   */
  async read(startRid, endRid, limit = 1000, options) {
    const cols = this.schema.columns.filter(c => !(c.flag & FLAG_METADATA));
    const colNames = _buildSelectColumns(this.schema, options?.selectColumns);
    const colList = ['_RID', _buildSelectList(this.schema, colNames, this.config)].join(', ');
    const keyCol = cols.find(c => c.flag & FLAG_PRIMARY);
    const keyColName = keyCol ? keyCol.name : null;
    const filterSql = buildQueryFilterSql(options?.repTargetCond, options?.transform, {
      tableType: 'TAG',
      logicalTable: this.logicalTable,
      primaryColumnName: keyColName,
    });

    const hintEndRid = endRid + 1n;
    const whereClause = filterSql.sql !== '1=1' ? ` WHERE ${filterSql.sql}` : '';
    const sql = `SELECT /*+ RID_RANGE(${this.dataTable}, ${startRid}, ${hintEndRid}) */ ${colList} FROM ${this.dataTable}${whereClause} ORDER BY _RID LIMIT ${limit}`;
    getLogger().trace('table_read_query', {
      table: this.logicalTable,
      dataTable: this.dataTable,
      startRid: String(startRid),
      endRid: String(endRid),
      sql,
      params: _stringifyParams(filterSql.params),
    });
    try {
      const sqlRows = (await this.client.query(sql, filterSql.params)) || [];
      const result = [];
      for (const row of sqlRows) {
        if (row._RID == null) {
          getLogger().warn('table', { msg: `row with null _RID skipped in ${this.dataTable}` });
          continue;
        }
        const rid = BigInt(row._RID);

        const data = {};
        for (const col of colNames) data[col] = row[col];

        if (this.aliasCache && keyColName && Object.prototype.hasOwnProperty.call(data, keyColName)) {
          const tagId = data[keyColName];
          let entry = this.aliasCache._map.get(BigInt(tagId));
          if (!entry) {
            const found = await this.cacheTagMetaByTagID(tagId);
            if (!found) continue;
            entry = this.aliasCache._map.get(BigInt(tagId));
          }
          if (!entry) continue;
          data[keyColName] = entry.name;
          Object.assign(data, entry.meta);
        }
        result.push({
          rid,
          tagId: keyColName && Object.prototype.hasOwnProperty.call(row, keyColName) ? row[keyColName] : null,
          data,
        });
      }

      return { rows: result, err: null };
    } catch (err) {
      getLogger().error('table', { table: this.dataTable, msg: err.message });
      return { rows: [], err };
    }
  }
}

module.exports = { TagMetaCache, LogTable, TagTable, TagDataTable };
