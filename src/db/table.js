'use strict';

const { ColumnType, Column, TableSchema, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA, FLAG_PRIMARY } = require('./types.js');
const { MachbaseClient } = require('./client.js');
const { MachbaseStream, _toCell } = require('./stream.js');
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
 * @returns {Promise<{ firstMissIdx: number|null, err: Error|null }>}
 */
async function _findFirstMissRow(logicalTable, schema, rows, client, suffix) {
  if (!rows || rows.length === 0) return { firstMissIdx: null, err: null };

  const chk = `_repli_chk_${suffix}`;
  const lkp = `_repli_lkp_${suffix}`;
  const nameCol = schema.columns.find(c => c.name === 'NAME');
  if (!nameCol) return { firstMissIdx: null, err: new Error(`findFirstMissRow: NAME column not found in schema for '${logicalTable}'`) };
  const nameDdlType = nameCol.sqlType();

  try {
    await client.execute(`CREATE VOLATILE TABLE ${chk} (IDX INT, NAME ${nameDdlType}, TIME DATETIME)`);
    await client.execute(`CREATE VOLATILE TABLE ${lkp} (NAME ${nameDdlType}, TIME DATETIME)`);

    const stream = new MachbaseStream();
    const openErr = await stream.open(client, chk, [
      { name: 'IDX',  type: 'int32'   },
      { name: 'NAME', type: 'varchar' },
      { name: 'TIME', type: 'int64'   },
    ]);
    if (openErr) return { firstMissIdx: null, err: openErr };
    const appendErr = await stream.append(rows.map((r, i) => [i, String(r.canonical), BigInt(r.time)]));
    const closeErr  = await stream.close();
    if (appendErr) return { firstMissIdx: null, err: appendErr };
    if (closeErr)  return { firstMissIdx: null, err: closeErr };

    await client.execute(
      `INSERT INTO ${lkp} ` +
      `SELECT t.NAME, t.TIME FROM ${logicalTable} t, ${chk} c ` +
      `WHERE t.NAME = c.NAME AND t.TIME = c.TIME`
    );

    let result;
    try {
      result = await client.query(
        `SELECT IDX FROM (` +
          `SELECT c.IDX, t.NAME AS T_NAME ` +
          `FROM ${chk} c LEFT OUTER JOIN ${lkp} t ON c.NAME = t.NAME AND c.TIME = t.TIME` +
        `) WHERE T_NAME IS NULL ORDER BY IDX ASC LIMIT 1`
      );
    } finally {
      // lkp는 쿼리 직후 즉시 DROP — 연결 종료 시까지 살려두면 비정상 종료 시 서버에 잔류할 수 있음
      await client.execute(`DROP TABLE ${lkp}`).catch(e =>
        getLogger().warn('table', { msg: `DROP ${lkp} failed: ${e.message}` })
      );
    }

    if (!result || result.length === 0) return { firstMissIdx: null, err: null };
    return { firstMissIdx: result[0].IDX, err: null };

  } catch (err) {
    getLogger().error('table', { table: logicalTable, msg: err.message });
    return { firstMissIdx: null, err };
  } finally {
    await client.execute(`DROP TABLE ${chk}`).catch(e =>
      getLogger().warn('table', { msg: `DROP ${chk} failed: ${e.message}` })
    );
    await client.execute(`DROP TABLE ${lkp}`).catch(() => {/* 이미 DROP됨 */});
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
   * @returns {Promise<Array<{ NAME: string, TYPE: number, ID: number, LENGTH: number, FLAG: number }>>}
   */
  async getColumns() {
    return this.client.selectColumnsByTableName(this.logicalTable);
  }

  /**
   * 스키마 조회 후 반환
   * @returns {Promise<TableSchema>}
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

  /**
   * DB 연결
   * @returns {Promise<void>}
   */
  async open() {
    this.client = new MachbaseClient(this.config);
    await this.client.connect();
  }

  /**
   * append 스트림 열기 (schema 없으면 자동 조회)
   * @returns {Promise<Error|null>}
   */
  async openStream() {
    if (!this.schema) this.schema = await this.getSchema();
    this.stream = new MachbaseStream();
    return this.stream.open(
      this.client,
      this.logicalTable,
      this.schema.columns.map(c => ({ name: c.name, type: c.dataType() }))
    );
  }

  /**
   * append 스트림 + DB 연결 닫기
   * @returns {Promise<Error|null>}
   */
  async close() {
    let firstErr = null;
    if (this.stream) {
      firstErr = await this.stream.close();
      this.stream = null;
    }
    if (this.client) {
      await this.client.close().catch(err => { if (!firstErr) firstErr = err; });
      this.client = null;
    }
    return firstErr;
  }

  /**
   * 테이블의 최대 RID 조회
   * @returns {Promise<bigint>}
   */
  async getMaxRid() {
    return this.client.selectMaxRid(this.logicalTable);
  }


  /**
   * RID 기반 배치 읽기
   * @param {bigint} startRid
   * @param {number} [limit=1000]
   * @param {number} [rangeSize=50000]
   * @returns {Promise<{ rows: Array<{ rid: bigint, data: object }>, err: Error|null }>}
   */
  async read(startRid, limit = 1000, rangeSize = 50000, filter = null) {
    const colNames = this.schema.columns.map(c => c.name);

    const endRid = startRid + BigInt(rangeSize);

    const colList = ['_RID', ...colNames].join(', ');
    const { clause: whereExtra, params: whereParams } = _buildWhereClause(filter, colNames, this.schema);
    const sql = `SELECT /*+ RID_RANGE(${this.logicalTable}, ${startRid}, ${endRid}) */ ${colList} FROM ${this.logicalTable} WHERE _RID >= ${startRid}${whereExtra} LIMIT ${limit}`;
    try {
      const rows = await this.client.query(sql, whereParams.length > 0 ? whereParams : undefined);
      const result = [];
      for (const row of (rows || [])) {
        if (row._RID == null) {
          getLogger().warn('table', { msg: `row with null _RID skipped in ${tableName}` });
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
      getLogger().error('table', { table: tableName, msg: err.message });
      return { rows: [], err };
    }
  }

  /**
   * 배치 데이터 append
   * @param {Array<object>} rows - 컬럼명 기준 객체 배열
   * @returns {Promise<Error|null>}
   */
  async append(rows) {
    if (!this.stream) {
      const err = await this.openStream();
      if (err) return err;
    }

    if (!rows || rows.length === 0) return null;

    const matrix = rows.map(row =>
      this.schema.columns.map(col => _toCell(col, row[col.name]))
    );
    return this.stream.append(matrix);
  }

  /**
   * VOLATILE TABLE + JOIN 방식으로 배치 내 첫 번째 miss row의 0-based 인덱스를 반환
   * schema에 NAME 컬럼이 있어야 한다.
   * @param {Array<{ canonical: string, time: bigint }>} rows
   * @param {MachbaseClient} client - 배치마다 신규 생성된 독립 연결
   * @param {string} suffix - VOLATILE TABLE 이름 suffix (Worker별 고유값, 충돌 방지)
   * @returns {Promise<{ firstMissIdx: number|null, err: Error|null }>}
   */
  async findFirstMissRow(rows, client, suffix) {
    return _findFirstMissRow(this.logicalTable, this.schema, rows, client, suffix);
  }
}


/**
 * TAG alias 캐시
 *
 * tag_id(_ID) → name 매핑을 보관하는 순수 캐시.
 * DB 조회는 TagDataTable.cacheTagMetaAll()이 담당하고,
 * TagDataTable.setTagMetaCache()로 주입하여 read() 시 사용한다.
 */
class TagMetaCache {
  constructor() {
    /** @type {Map<bigint, string>} */
    this._map = new Map();
  }

  get size() { return this._map.size; }

  /**
   * 항목 추가
   * @param {number|bigint} tagId
   * @param {string} name
   * @param {object} [meta={}] - metadata 컬럼 값 ({ colName: value, ... })
   */
  set(tagId, name, meta = {}) {
    if (name.includes('\x00')) {
      throw new Error(`tag name contains null byte: ${JSON.stringify(name)}`);
    }
    this._map.set(BigInt(tagId), { name, meta });
  }

  /**
   * tag_id → name 조회
   * @param {number|bigint} tagId
   * @returns {string|undefined}
   */
  get(tagId) {
    return this._map.get(BigInt(tagId))?.name;
  }

  /**
   * tag_id → canonical name + meta 변환 (캐시에서만 조회)
   * @param {number|bigint} tagId
   * @param {{ prefix?: string, suffix?: string }|null} nameRule - NAME 컬럼 규칙
   * @returns {{ canonical: string|null, meta: object, status: 'ok'|'drop_not_found' }}
   */
  resolve(tagId, nameRule) {
    const entry = this._map.get(BigInt(tagId));
    if (entry === undefined) return { canonical: null, meta: {}, status: 'drop_not_found' };
    const canonical = TagMetaCache._applyNameRule(entry.name, nameRule);
    return { canonical, meta: entry.meta, status: 'ok' };
  }

  /**
   * nameRule 설정에 따라 tagName을 변환 (prefix/suffix 적용)
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
 *
 * 논리 테이블 수준의 스키마 조회와 append 스트림을 담당한다.
 * 파티션 읽기는 TagDataTable이 담당한다.
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
   * @returns {Promise<Array<{ NAME: string, TYPE: number, ID: number, LENGTH: number, FLAG: number }>>}
   */
  async getColumns() {
    return this.client.selectColumnsByTableName(this.logicalTable);
  }

  /**
   * TAG 스키마 조회 후 반환
   * META 테이블에서 컬럼 목록을 조회하여 TableSchema 생성
   * @returns {Promise<TableSchema>}
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
   * @returns {Promise<Array<{ data_table: string }>>}
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

  /**
   * DB 연결
   * @returns {Promise<void>}
   */
  async open() {
    this.client = new MachbaseClient(this.config);
    await this.client.connect();
  }

  /**
   * append 스트림 열기 (schema 없으면 자동 조회)
   * @returns {Promise<Error|null>}
   */
  async openStream() {
    if (!this.schema) this.schema = await this.getSchema();
    this.stream = new MachbaseStream();
    return this.stream.open(
      this.client,
      this.logicalTable,
      this.schema.columns.map(c => ({ name: c.name, type: c.dataType() }))
    );
  }

  /**
   * append 스트림 + DB 연결 닫기
   * @returns {Promise<Error|null>}
   */
  async close() {
    let firstErr = null;
    if (this.stream) {
      firstErr = await this.stream.close();
      this.stream = null;
    }
    if (this.client) {
      await this.client.close().catch(err => { if (!firstErr) firstErr = err; });
      this.client = null;
    }
    return firstErr;
  }

  /**
   * 논리 테이블 전체 조회
   * @returns {Promise<Array<object>>}
   */
  async read() {
    const colNames = this.schema.columns.map(c => c.name);
    const colList = colNames.join(', ');
    const sql = `SELECT ${colList} FROM ${this.logicalTable}`;
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
   * @returns {Promise<Error|null>}
   */
  async append(rows) {
    if (!this.stream) {
      const err = await this.openStream();
      if (err) return err;
    }
    
    if (!rows || rows.length === 0) return null;

    const matrix = rows.map(row =>
      this.schema.columns.map(col => _toCell(col, row[col.name]))
    );

    return this.stream.append(matrix);
  }

  /**
   * VOLATILE TABLE + JOIN 방식으로 배치 내 첫 번째 miss row의 0-based 인덱스를 반환
   * schema에 NAME 컬럼이 있어야 한다.
   * @param {Array<{ canonical: string, time: bigint }>} rows
   * @param {MachbaseClient} client - 배치마다 신규 생성된 독립 연결
   * @param {string} suffix - VOLATILE TABLE 이름 suffix (Worker별 고유값, 충돌 방지)
   * @returns {Promise<{ firstMissIdx: number|null, err: Error|null }>}
   */
  async findFirstMissRow(rows, client, suffix) {
    return _findFirstMissRow(this.logicalTable, this.schema, rows, client, suffix);
  }
}

/**
 * TAG 데이터 파티션 클래스
 *
 * 단일 파티션(_TAG_DATA_N)의 읽기를 담당한다.
 * Worker별로 독립 인스턴스를 생성해 병렬 실행한다.
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
   * DB 연결 — 매 open() 호출마다 새 MachbaseClient 인스턴스를 생성한다.
   * (@machbase/ts-client는 end() 후 재연결 불가이므로 open()에서 생성)
   */
  async open() {
    this.client = new MachbaseClient(this.config);
    await this.client.connect();
  }

  /**
   * DB 연결 닫기
   * @returns {Error|null}
   */
  async close() {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    return null;
  }

  /**
   * 파티션의 최대 RID 조회
   * @returns {Promise<BigInt>}
   */
  async getMaxRid() {
    return this.client.selectMaxRid(this.dataTable);
  }

  /**
   * _TAG_META 전체 로드 후 내부 aliasCache 구성 (metadata 컬럼 값 포함)
   *
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
   * 태그 존재 시 true, 없으면 false 반환. 오류 시 throw.
   *
   * @param {*} tagId
   * @returns {Promise<boolean>}
   */
  async cacheTagMetaByTagID(tagId) {
    const metaColNames = this.schema
      ? this.schema.columns.filter(c => c.flag & FLAG_METADATA).map(c => c.name)
      : [];
    const row = await this.client.selectTagMetaById(this.logicalTable, metaColNames, tagId);
    if (row == null) return false;
    const meta = {};
    for (const col of metaColNames) meta[col] = row[col];
    this.aliasCache.set(row._ID, row.name, meta);
    return true;
  }

  /**
   * RID 기반 배치 읽기
   *
   * aliasCache가 설정된 경우 tagId를 canonical name으로 resolve하여 data.NAME에 채운다.
   * resolve 결과가 'drop_not_found'인 행은 결과에서 제외된다.
   *
   * @param {bigint} startRid
   * @param {number} [limit=1000]
   * @param {number} [rangeSize=50000]
   * @param {{ prefix?: string, suffix?: string }|null} [nameRule=null] - transform의 NAME 규칙
   * @param {string[]|null} [sourceColumns=null] - 읽을 컬럼명 목록 (null이면 전체)
   * @param {Array|null} [filter=null] - ColumnFilterConfig[] — 숫자형 컬럼 WHERE절 필터
   * @returns {Promise<{ rows: Array<{ rid: bigint, data: object }>, err: Error|null }>}
   */
  async read(startRid, limit = 1000, rangeSize = 50000, nameRule = null, sourceColumns = null, filter = null) {
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
      const rows = await this.client.query(sql, whereParams.length > 0 ? whereParams : undefined);
      const result = [];
      for (const row of (rows || [])) {
        if (row._RID == null) {
          getLogger().warn('table', { msg: `row with null _RID skipped in ${tableName}` });
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
            const found = await this.cacheTagNameByTagID(tagId);
            if (!found) continue;
            ({ canonical, meta } = this.aliasCache.resolve(tagId, nameRule));
          }
          // nameFilter 조건 검사 — 조건 밖의 태그는 skip
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
      getLogger().error('table', { table: tableName, msg: err.message });
      return { rows: [], err };
    }
  }
}

module.exports = { TagMetaCache, LogTable, TagTable, TagDataTable };
