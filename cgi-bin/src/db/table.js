'use strict';

const { ColumnType, Column, TableSchema, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA, FLAG_PRIMARY } = require('./types.js');
const { MachbaseClient } = require('./client.js');
const { MachbaseStream } = require('./stream.js');
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
function _findFirstMissRow(logicalTable, schema, rows, client) {
  if (!rows || rows.length === 0) return { firstMissIdx: null, err: null };

  const keyCol = schema.columns.find(c => c.flag & FLAG_PRIMARY);
  const baseTimeCol = schema.columns.find(c => c.flag & FLAG_BASETIME);
  if (!keyCol || !baseTimeCol) {
    return { firstMissIdx: null, err: new Error(`findFirstMissRow: PRIMARY/BASETIME column not found in schema for '${logicalTable}'`) };
  }
  const sql =
    `SELECT 1 AS EXISTS_ROW FROM ${logicalTable} ` +
    `WHERE ${keyCol.name} = ? AND ${baseTimeCol.name} = ? LIMIT 1`;

  try {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const foundRows = client.query(sql, [r.canonical, r.time]);
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
    this.logicalTable = logicalTable;
    this.config = config;
    this.client = null;
    /** @type {TableSchema|null} */
    this.schema = null;
    /** @type {MachbaseStream|null} */
    this.stream = null;
  }

  /**
   * 테이블 컬럼 목록 조회
   * @returns {Array<{ NAME: string, TYPE: number, ID: number, LENGTH: number, FLAG: number }>}
   */
  getColumns() {
    return this.client.selectColumnsByTableName(this.logicalTable);
  }

  /**
   * 스키마 조회 후 반환
   * @returns {TableSchema}
   */
  getSchema() {
    const rows = this.getColumns();
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

  /**
   * DB 연결
   */
  open() {
    this.client = new MachbaseClient(this.config);
    this.client.connect();
  }

  /**
   * append 스트림 열기 (schema 없으면 자동 조회)
   * @returns {Error|null}
   */
  openStream() {
    if (!this.schema) this.schema = this.getSchema();
    this.stream = new MachbaseStream();
    return this.stream.open(
      this.client,
      this.logicalTable,
      this.schema.columns.map(c => ({ name: c.name, type: c.sqlType() }))
    );
  }

  /**
   * append 스트림 + DB 연결 닫기
   * @returns {Error|null}
   */
  close() {
    let firstErr = null;
    if (this.stream) {
      firstErr = this.stream.close();
      this.stream = null;
    }
    if (this.client) {
      try { this.client.close(); } catch (err) { if (!firstErr) firstErr = err; }
      this.client = null;
    }
    return firstErr;
  }

  /**
   * 테이블의 최대 RID 조회
   * @returns {bigint}
   */
  getMaxRid() {
    return this.client.selectMaxRid(this.logicalTable);
  }


  /**
   * RID 기반 배치 읽기
   * @param {bigint} startRid
   * @param {bigint} endRid
   * @param {number} [limit=1000]
   * @param {{ selectColumns?: string[], repTargetCond?: object|null, transform?: Array|null }} [options]
   * @returns {{ rows: Array<{ rid: bigint, data: object }>, err: Error|null }}
   */
  read(startRid, endRid, limit = 1000, options) {
    const colNames = _buildSelectColumns(this.schema, options?.selectColumns);
    const filterSql = buildQueryFilterSql(options?.repTargetCond, options?.transform, {
      tableType: 'LOG',
      logicalTable: this.logicalTable,
      primaryColumnName: null,
    });
    const hintEndRid = endRid + 1n;
    const colList = ['_RID', ...colNames].join(', ');
    const where = [`_RID >= ${startRid}`, `_RID <= ${endRid}`];
    if (filterSql.sql !== '1=1') {
      where.push(filterSql.sql);
    }
    const sql = `SELECT /*+ RID_RANGE(${this.logicalTable}, ${startRid}, ${hintEndRid}) */ ${colList} FROM ${this.logicalTable} WHERE ${where.join(' AND ')} ORDER BY _RID LIMIT ${limit}`;
    try {
      const sqlRows = this.client.query(sql, filterSql.params) || [];
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
  append(rows) {
    if (!this.stream) {
      const err = this.openStream();
      if (err) return err;
    }

    if (!rows || rows.length === 0) return null;

    const matrix = rows.map(row =>
      this.schema.columns.map(col => {
        const val = row[col.name];
        if (typeof val === 'number' && !isFinite(val)) {
          getLogger().warn('stream', { table: this.logicalTable, col: col.name, val: String(val), msg: 'non-finite value will be stored as null' });
        }
        return val;
      })
    );
    return this.stream.append(matrix);
  }

  /**
   * source batch 순서대로 target 존재 여부를 확인하여 첫 번째 miss row의 0-based 인덱스를 반환
   * @param {Array<{ canonical: string, time: bigint }>} rows
   * @param {MachbaseClient} client
   * @param {string} suffix
   * @returns {{ firstMissIdx: number|null, err: Error|null }}
   */
  findFirstMissRow(rows, client, suffix) {
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
    this.logicalTable = logicalTable;
    this.config = config;
    this.client = null;
    /** @type {TableSchema|null} */
    this.schema = null;
    /** @type {MachbaseStream|null} */
    this.stream = null;
  }

  /**
   * 컬럼 목록 조회
   * @returns {Array<{ NAME: string, TYPE: number, ID: number, LENGTH: number, FLAG: number }>}
   */
  getColumns() {
    return this.client.selectColumnsByTableName(this.logicalTable);
  }

  /**
   * TAG 스키마 조회 후 반환
   * @returns {TableSchema}
   */
  getSchema() {
    const rows = this.getColumns();
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
  getDataTables() {
    return this.client.selectTagDataTables(this.logicalTable);
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
  open() {
    this.client = new MachbaseClient(this.config);
    this.client.connect();
  }

  /**
   * append 스트림 열기 (schema 없으면 자동 조회)
   * @returns {Error|null}
   */
  openStream() {
    if (!this.schema) this.schema = this.getSchema();
    this.stream = new MachbaseStream();
    return this.stream.open(
      this.client,
      this.logicalTable,
      this.schema.columns.map(c => ({ name: c.name, type: c.sqlType() }))
    );
  }

  /**
   * append 스트림 + DB 연결 닫기
   * @returns {Error|null}
   */
  close() {
    let firstErr = null;
    if (this.stream) {
      firstErr = this.stream.close();
      this.stream = null;
    }
    if (this.client) {
      try { this.client.close(); } catch (err) { if (!firstErr) firstErr = err; }
      this.client = null;
    }
    return firstErr;
  }

  /**
   * 논리 테이블 전체 조회
   * @returns {Array<object>}
   */
  read() {
    const colNames = this.schema.columns.map(c => c.name);
    const colList = colNames.join(', ');
    const sql = `SELECT ${colList} FROM ${this.logicalTable}`;
    try {
      const rows = this.client.query(sql);
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
  append(rows) {
    if (!this.stream) {
      const err = this.openStream();
      if (err) return err;
    }

    if (!rows || rows.length === 0) return null;

    const matrix = rows.map(row =>
      this.schema.columns.map(col => {
        const val = row[col.name];
        if (typeof val === 'number' && !isFinite(val)) {
          getLogger().warn('stream', { table: this.logicalTable, col: col.name, val: String(val), msg: 'non-finite value will be stored as null' });
        }
        return val;
      })
    );

    return this.stream.append(matrix);
  }

  /**
   * source batch 순서대로 target 존재 여부를 확인하여 첫 번째 miss row의 0-based 인덱스를 반환
   * @param {Array<{ canonical: string, time: bigint }>} rows
   * @param {MachbaseClient} client
   * @param {string} suffix
   * @returns {{ firstMissIdx: number|null, err: Error|null }}
   */
  findFirstMissRow(rows, client, suffix) {
    return _findFirstMissRow(this.logicalTable, this.schema, rows, client);
  }

  /**
   * TAG META 전체 로드 (nameFilter 조건 적용)
   * @param {{ in?: string[], like?: string }|null} [nameFilter=null]
   * @returns {TagMetaCache}
   */
  loadTagMetaCache(nameFilter = null) {
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

    const rows = this.client.query(sql, params.length > 0 ? params : undefined);
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
  open() {
    this.client = new MachbaseClient(this.config);
    this.client.connect();
  }

  /**
   * DB 연결 닫기
   * @returns {Error|null}
   */
  close() {
    if (this.client) {
      try { this.client.close(); } catch (_) {}
      this.client = null;
    }
    return null;
  }

  /**
   * 파티션의 최대 RID 조회
   * @returns {bigint}
   */
  getMaxRid() {
    return this.client.selectMaxRid(this.dataTable);
  }

  /**
   * _TAG_META 전체 로드 후 내부 aliasCache 구성 (metadata 컬럼 값 포함)
   * @returns {Error|null}
   */
  cacheTagMetaAll() {
    try {
      const metaColNames = this.schema
        ? this.schema.columns.filter(c => c.flag & FLAG_METADATA).map(c => c.name)
        : [];
      const rows = this.client.selectTagMeta(this.logicalTable, metaColNames);
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
  cacheTagMetaByTagID(tagId) {
    const metaColNames = this.schema
      ? this.schema.columns.filter(c => c.flag & FLAG_METADATA).map(c => c.name)
      : [];
    const row = this.client.selectTagMetaById(this.logicalTable, tagId, metaColNames);
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
  read(startRid, endRid, limit = 1000, options) {
    const cols = this.schema.columns.filter(c => !(c.flag & FLAG_METADATA));
    const colNames = _buildSelectColumns(this.schema, options?.selectColumns);
    const keyCol = cols.find(c => c.flag & FLAG_PRIMARY);
    const keyColName = keyCol ? keyCol.name : null;
    const filterSql = buildQueryFilterSql(options?.repTargetCond, options?.transform, {
      tableType: 'TAG',
      logicalTable: this.logicalTable,
      primaryColumnName: keyColName,
    });

    const hintEndRid = endRid + 1n;
    const colList = ['_RID', ...colNames].join(', ');
    const where = [`_RID >= ${startRid}`, `_RID <= ${endRid}`];
    if (filterSql.sql !== '1=1') {
      where.push(filterSql.sql);
    }
    const sql = `SELECT /*+ RID_RANGE(${this.dataTable}, ${startRid}, ${hintEndRid}) */ ${colList} FROM ${this.dataTable} WHERE ${where.join(' AND ')} ORDER BY _RID LIMIT ${limit}`;
    try {
      const sqlRows = this.client.query(sql, filterSql.params) || [];
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
            const found = this.cacheTagMetaByTagID(tagId);
            if (!found) continue;
            entry = this.aliasCache._map.get(BigInt(tagId));
          }
          if (!entry) continue;
          data[keyColName] = entry.name;
          Object.assign(data, entry.meta);
        }
        result.push({ rid, data });
      }

      return { rows: result, err: null };
    } catch (err) {
      getLogger().error('table', { table: this.dataTable, msg: err.message });
      return { rows: [], err };
    }
  }
}

module.exports = { TagMetaCache, LogTable, TagTable, TagDataTable };
