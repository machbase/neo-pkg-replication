'use strict';

const { ColumnType, Column, TableSchema, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA, FLAG_PRIMARY } = require('./types.js');
const { MachbaseClient } = require('./client.js');
const { MachbaseStream } = require('./stream.js');
const { getInstance: getLogger } = require('../lib/logger.js');

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────


/**
 * VOLATILE TABLE + JOIN 방식으로 배치 내 첫 번째 miss row의 0-based 인덱스를 반환.
 * LogTable.findFirstMissRow 와 TagTable.findFirstMissRow 에서 공유하는 공통 구현.
 *
 * @param {string} logicalTable - 논리 테이블명
 * @param {TableSchema} schema  - NAME 컬럼을 포함하는 스키마
 * @param {Array<{ canonical: string, time: bigint }>} rows
 * @param {MachbaseClient} client - 배치마다 신규 생성된 독립 연결
 * @param {string} suffix - VOLATILE TABLE 이름 suffix (Worker별 고유값, 충돌 방지)
 * @returns {{ firstMissIdx: number|null, err: Error|null }}
 */
function _findFirstMissRow(logicalTable, schema, rows, client, suffix) {
  if (!rows || rows.length === 0) return { firstMissIdx: null, err: null };

  const chk = `_repli_chk_${suffix}`;
  const lkp = `_repli_lkp_${suffix}`;
  const nameCol = schema.columns.find(c => c.name === 'NAME');
  if (!nameCol) return { firstMissIdx: null, err: new Error(`findFirstMissRow: NAME column not found in schema for '${logicalTable}'`) };
  const nameDdlType = nameCol.sqlType();

  try {
    client.execute(`CREATE VOLATILE TABLE ${chk} (IDX INT, NAME ${nameDdlType}, TIME DATETIME)`);
    client.execute(`CREATE VOLATILE TABLE ${lkp} (NAME ${nameDdlType}, TIME DATETIME)`);

    // VOLATILE TABLE은 append 불가 → INSERT 문으로 데이터 삽입 (TIME 객체 그대로 바인딩)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      client.execute(`INSERT INTO ${chk} (IDX, NAME, TIME) VALUES (?, ?, ?)`, i, r.canonical, r.time);
    }

    client.execute(
      `INSERT INTO ${lkp} ` +
      `SELECT t.NAME, t.TIME FROM ${logicalTable} t, ${chk} c ` +
      `WHERE t.NAME = c.NAME AND t.TIME = c.TIME`
    );

    let result;
    try {
      result = client.query(
        `SELECT IDX FROM (` +
          `SELECT c.IDX, t.NAME AS T_NAME ` +
          `FROM ${chk} c LEFT OUTER JOIN ${lkp} t ON c.NAME = t.NAME AND c.TIME = t.TIME` +
        `) WHERE T_NAME IS NULL ORDER BY IDX ASC LIMIT 1`
      );
    } finally {
      try {
        client.execute(`DROP TABLE ${lkp}`);
      } catch (e) {
        getLogger().warn('table', { msg: `DROP ${lkp} failed: ${e.message}` });
      }
    }

    if (!result || result.length === 0) return { firstMissIdx: null, err: null };
    return { firstMissIdx: result[0].IDX, err: null };

  } catch (err) {
    getLogger().error('table', { table: logicalTable, msg: err.message });
    return { firstMissIdx: null, err };
  } finally {
    try { client.execute(`DROP TABLE ${chk}`); } catch (e) {
      getLogger().warn('table', { msg: `DROP ${chk} failed: ${e.message}` });
    }
    try { client.execute(`DROP TABLE ${lkp}`); } catch (_) {/* 이미 DROP됨 */}
  }
}


/**
 * filter[] → WHERE 절 추가 부분과 바인딩 파라미터 반환
 *
 * - min/max: 숫자형 컬럼만 적용, 값을 직접 SQL에 삽입 (Number.isFinite로 안전 검증됨)
 * - in: VARCHAR/TEXT 컬럼에 IN (?, ...) 적용, 파라미터 바인딩 사용
 * - like: VARCHAR/TEXT 컬럼에 LIKE ? 적용, 파라미터 바인딩 사용
 * - NAME 컬럼은 TAG 파티션에 존재하지 않으므로 columnNamesUpper 체크에서 자동 제외됨
 *
 * @param {Array|null} filter - ColumnFilterConfig[]
 * @param {string[]} columnNamesUpper - 실제 읽는 컬럼 목록 (UPPERCASE)
 * @param {import('./types.js').TableSchema|null} schema
 * @returns {{ clause: string, params: Array }}
 */
function _buildWhereClause(filter, columnNamesUpper, schema) {
  if (!filter || filter.length === 0) return { clause: '', params: [] };
  const schemaColMap = schema
    ? new Map(schema.columns.map(c => [c.name, c]))
    : new Map();
  const NUMERIC_TYPES = new Set(['short', 'ushort', 'integer', 'uinteger', 'long', 'ulong', 'float', 'double']);
  const STRING_TYPES  = new Set(['varchar', 'text']);
  const parts  = [];
  const params = [];
  for (const f of filter) {
    if (!columnNamesUpper.includes(f.column)) continue;
    const schemaCol = schemaColMap.get(f.column);
    if (!schemaCol) continue;
    const colType = schemaCol.columnType.type;
    if (NUMERIC_TYPES.has(colType)) {
      if (f.min !== undefined) parts.push(`${f.column} >= ${f.min}`);
      if (f.max !== undefined) parts.push(`${f.column} <= ${f.max}`);
    }
    if (STRING_TYPES.has(colType)) {
      if (f.in !== undefined && f.in.length > 0) {
        parts.push(`${f.column} IN (${f.in.map(() => '?').join(', ')})`);
        params.push(...f.in);
      }
      if (f.like !== undefined) {
        parts.push(`${f.column} LIKE ?`);
        params.push(f.like);
      }
    }
  }
  return parts.length > 0
    ? { clause: ' AND ' + parts.join(' AND '), params }
    : { clause: '', params: [] };
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
      this.schema.columns.map(c => ({ name: c.name, type: c.dataType() }))
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
   * @param {number} [limit=1000]
   * @param {number} [rangeSize=50000]
   * @param {Array|null} [filter=null]
   * @returns {{ rows: Array<{ rid: bigint, data: object }>, err: Error|null }}
   */
  read(startRid, limit = 1000, rangeSize = 50000, filter = null) {
    const colNames = this.schema.columns.map(c => c.name);

    const endRid = startRid + BigInt(rangeSize);

    const colList = ['_RID', ...colNames].join(', ');
    const { clause: whereExtra, params: whereParams } = _buildWhereClause(filter, colNames, this.schema);
    const sql = `SELECT /*+ RID_RANGE(${this.logicalTable}, ${startRid}, ${endRid}) */ ${colList} FROM ${this.logicalTable} WHERE _RID >= ${startRid}${whereExtra} LIMIT ${limit}`;
    try {
      const rows = this.client.query(sql, whereParams.length > 0 ? whereParams : undefined);
      const result = [];
      for (const row of (rows || [])) {
        if (row._RID == null) {
          getLogger().warn('table', { msg: `row with null _RID skipped in ${this.logicalTable}` });
          continue;
        }
        const data = {};
        for (const col of colNames) {
          data[col] = row[col];
        }
        result.push({ rid: BigInt(row._RID), data });
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
   * VOLATILE TABLE + JOIN 방식으로 배치 내 첫 번째 miss row의 0-based 인덱스를 반환
   * @param {Array<{ canonical: string, time: bigint }>} rows
   * @param {MachbaseClient} client
   * @param {string} suffix
   * @returns {{ firstMissIdx: number|null, err: Error|null }}
   */
  findFirstMissRow(rows, client, suffix) {
    return _findFirstMissRow(this.logicalTable, this.schema, rows, client, suffix);
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

  set(tagId, name, meta = {}) {
    if (name.includes('\x00')) {
      throw new Error(`tag name contains null byte: ${JSON.stringify(name)}`);
    }
    this._map.set(BigInt(tagId), { name, meta });
  }

  get(tagId) {
    return this._map.get(BigInt(tagId))?.name;
  }

  resolve(tagId, nameRule) {
    const entry = this._map.get(BigInt(tagId));
    if (entry === undefined) return { canonical: null, meta: {}, status: 'drop_not_found' };
    const canonical = TagMetaCache._applyNameRule(entry.name, nameRule);
    return { canonical, meta: entry.meta, status: 'ok' };
  }

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
      this.schema.columns.map(c => ({ name: c.name, type: c.dataType() }))
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
   * VOLATILE TABLE + JOIN 방식으로 배치 내 첫 번째 miss row의 0-based 인덱스를 반환
   * @param {Array<{ canonical: string, time: bigint }>} rows
   * @param {MachbaseClient} client
   * @param {string} suffix
   * @returns {{ firstMissIdx: number|null, err: Error|null }}
   */
  findFirstMissRow(rows, client, suffix) {
    return _findFirstMissRow(this.logicalTable, this.schema, rows, client, suffix);
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
   * @param {number} [limit=1000]
   * @param {number} [rangeSize=50000]
   * @param {{ prefix?: string, suffix?: string }|null} [nameRule=null]
   * @param {string[]|null} [sourceColumns=null]
   * @param {Array|null} [filter=null]
   * @returns {{ rows: Array<{ rid: bigint, data: object }>, err: Error|null }}
   */
  read(startRid, limit = 1000, rangeSize = 50000, nameRule = null, sourceColumns = null, filter = null) {
    const cols = this.schema.columns.filter(c => !(c.flag & FLAG_METADATA));
    const filtered = sourceColumns
      ? cols.filter(c => sourceColumns.includes(c.name))
      : cols;
    const colNames = filtered.map(c => c.name);

    const endRid = startRid + BigInt(rangeSize);

    const colList = ['_RID', ...colNames].join(', ');
    const { clause: whereExtra, params: whereParams } = _buildWhereClause(filter, colNames, this.schema);
    const sql = `SELECT /*+ RID_RANGE(${this.dataTable}, ${startRid}, ${endRid}) */ ${colList} FROM ${this.dataTable} WHERE _RID >= ${startRid}${whereExtra} LIMIT ${limit}`;
    try {
      const rows = this.client.query(sql, whereParams.length > 0 ? whereParams : undefined);
      const result = [];
      for (const row of (rows || [])) {
        if (row._RID == null) {
          getLogger().warn('table', { msg: `row with null _RID skipped in ${this.dataTable}` });
          continue;
        }
        const data = {};
        for (const col of colNames) {
          data[col] = row[col];
        }

        if (this.aliasCache) {
          const tagId = data.NAME;
          let { canonical, meta, status } = this.aliasCache.resolve(tagId, nameRule);
          if (status === 'drop_not_found') {
            const found = this.cacheTagMetaByTagID(tagId);
            if (!found) continue;
            ({ canonical, meta } = this.aliasCache.resolve(tagId, nameRule));
          }
          const nameFilterEntry = filter?.find(f => f.column === 'NAME') ?? null;
          if (nameFilterEntry) {
            if (nameFilterEntry.in && !nameFilterEntry.in.includes(canonical)) continue;
            if (nameFilterEntry.like && !new RegExp(
              `^${nameFilterEntry.like.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i'
            ).test(canonical)) continue;
          }
          data.NAME = canonical;
          Object.assign(data, meta);
        }
        result.push({ rid: BigInt(row._RID), data });
      }

      return { rows: result, err: null };
    } catch (err) {
      getLogger().error('table', { table: this.dataTable, msg: err.message });
      return { rows: [], err };
    }
  }
}

module.exports = { TagMetaCache, LogTable, TagTable, TagDataTable };
