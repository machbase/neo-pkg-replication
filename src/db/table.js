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
 * @returns {Promise<{ firstMissIdx: number|null, err: Error|null }>}
 */
async function _findFirstMissRow(logicalTable, schema, rows, client) {
  if (!rows || rows.length === 0) return { firstMissIdx: null, err: null };

  const chk = '_repli_chk';
  const lkp = '_repli_lkp';
  const nameCol = schema.columns.find(c => c.name === 'NAME');
  if (!nameCol) return { firstMissIdx: null, err: new Error(`findFirstMissRow: NAME column not found in schema for '${logicalTable}'`) };
  const nameDdlType = nameCol.sqlType();

  try {
    await client.execute(`CREATE VOLATILE TABLE ${chk} (IDX INT, NAME ${nameDdlType}, TIME DATETIME)`);
    await client.execute(`CREATE VOLATILE TABLE ${lkp} (NAME ${nameDdlType}, TIME DATETIME)`);

    const stream = new MachbaseStream();
    const openErr = await stream.open(client, chk, [
      { name: 'IDX',  type: 'int32'    },
      { name: 'NAME', type: 'varchar'  },
      { name: 'TIME', type: 'datetime' },
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

    const result = await client.query(
      `SELECT IDX FROM (` +
        `SELECT c.IDX, t.NAME AS T_NAME ` +
        `FROM ${chk} c LEFT OUTER JOIN ${lkp} t ON c.NAME = t.NAME AND c.TIME = t.TIME` +
      `) WHERE T_NAME IS NULL ORDER BY IDX ASC LIMIT 1`
    );

    if (!result || result.length === 0) return { firstMissIdx: null, err: null };
    return { firstMissIdx: result[0].IDX, err: null };

  } catch (err) {
    getLogger().error('table', { table: logicalTable, msg: err.message });
    return { firstMissIdx: null, err };
  } finally {
    await client.execute(`DROP TABLE ${chk}`).catch(e =>
      getLogger().warn('table', { msg: `DROP ${chk} failed: ${e.message}` })
    );
    await client.execute(`DROP TABLE ${lkp}`).catch(e =>
      getLogger().warn('table', { msg: `DROP ${lkp} failed: ${e.message}` })
    );
  }
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
    this.client = new MachbaseClient(config);
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
   * DB 연결 + 선택적으로 append 스트림 열기
   * @param {boolean} [useStream=false] - true면 append 스트림도 함께 열기
   * @returns {Promise<Error|null>}
   */
  async open(useStream = false) {
    await this.client.connect();
    if (useStream) {
      this.stream = new MachbaseStream();
      return this.stream.open(
        this.client,
        this.logicalTable,
        this.schema.columns.map(c => ({ name: c.name, type: c.dataType() }))
      );
    }
    return null;
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
    await this.client.close().catch(err => { if (!firstErr) firstErr = err; });
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
  async read(startRid, limit = 1000, rangeSize = 50000) {
    const tableName = this.logicalTable;
    const columnNames = this.schema.columns.map(c => c.name.toLowerCase());
    const columnNamesUpper = this.schema.columns.map(c => c.name);

    let endRid = startRid + BigInt(rangeSize);
    try {
      const maxRid = await this.client.selectMaxRid(tableName);
      const maxRidPlusOne = maxRid + 1n;
      if (maxRidPlusOne < endRid) endRid = maxRidPlusOne;
    } catch (e) {
      getLogger().warn('table', { msg: `MAX(_RID) query failed for ${tableName}, using startRid+rangeSize as endRid: ${e.message}` });
    }
    if (endRid < startRid) endRid = startRid;

    const colList = ['_RID', ...columnNames].join(', ');
    const sql = `SELECT /*+ RID_RANGE(${tableName}, ${startRid}, ${endRid}) */ ${colList} FROM ${tableName} WHERE _RID >= ${startRid} LIMIT ${limit}`;
    try {
      const rows = await this.client.query(sql);
      const result = [];
      for (const row of (rows || [])) {
        if (row._RID == null) {
          getLogger().warn('table', { msg: `row with null _RID skipped in ${tableName}` });
          continue;
        }
        const data = {};
        for (let i = 0; i < columnNames.length; i++) {
          data[columnNamesUpper[i]] = row[columnNames[i]];
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
    if (!rows || rows.length === 0) return null;
    if (!this.stream) return new Error('LogTable.append called before open()');
    const matrix = rows.map(row =>
      this.schema.columns.map(col => {
        const val = row[col.name];
        if (val != null) {
          if (col.dataType() === 'int64' && typeof val === 'number' && !Number.isInteger(val))
            getLogger().warn('table', { msg: `int64 column '${col.name}' received non-integer number ${val}, truncating` });
          else if (typeof val === 'number' && !isFinite(val))
            getLogger().warn('table', { col: col.name, value: String(val), msg: `non-finite float value replaced with null` });
        }
        return _toCell(col, val);
      })
    );
    return this.stream.append(matrix);
  }

  /**
   * VOLATILE TABLE + JOIN 방식으로 배치 내 첫 번째 miss row의 0-based 인덱스를 반환
   * schema에 NAME 컬럼이 있어야 한다.
   * @param {Array<{ canonical: string, time: bigint }>} rows
   * @param {MachbaseClient} client - 배치마다 신규 생성된 독립 연결
   * @returns {Promise<{ firstMissIdx: number|null, err: Error|null }>}
   */
  async findFirstMissRow(rows, client) {
    return _findFirstMissRow(this.logicalTable, this.schema, rows, client);
  }
}


/**
 * TAG alias 캐시
 *
 * tag_id(_ID) → name 매핑을 보관하는 순수 캐시.
 * DB 조회는 TagTable.loadTagAliasCache()가 담당하고,
 * TagDataTable.setTagAliasCache()로 주입하여 read() 시 사용한다.
 */
class TagAliasCache {
  constructor() {
    /** @type {Map<bigint, string>} */
    this._map = new Map();
  }

  get size() { return this._map.size; }

  /**
   * 항목 추가
   * @param {number|bigint} tagId
   * @param {string} name
   */
  set(tagId, name) {
    if (name.includes('\x00')) {
      throw new Error(`tag name contains null byte: ${JSON.stringify(name)}`);
    }
    this._map.set(BigInt(tagId), name);
  }

  /**
   * tag_id → name 조회
   * @param {number|bigint} tagId
   * @returns {string|undefined}
   */
  get(tagId) {
    return this._map.get(BigInt(tagId));
  }

  /**
   * tag_id → canonical name 변환 (캐시에서만 조회)
   * @param {number|bigint} tagId
   * @param {{ mode: 'prefix'|'suffix'|'none', value?: string }|null} tagIdentifier
   * @returns {{ canonical: string|null, status: 'ok'|'drop_not_found' }}
   */
  resolve(tagId, tagIdentifier) {
    const tagName = this._map.get(BigInt(tagId));
    if (tagName === undefined) return { canonical: null, status: 'drop_not_found' };
    const canonical = TagAliasCache._applyIdentifier(tagName, tagIdentifier);
    return { canonical, status: 'ok' };
  }

  /**
   * tagIdentifier 설정에 따라 tagName을 변환
   * @param {string} tagName
   * @param {{ mode: 'prefix'|'suffix'|'none', value?: string }|null} tagIdentifier
   * @returns {string}
   */
  static _applyIdentifier(tagName, tagIdentifier) {
    if (!tagIdentifier || tagIdentifier.mode === 'none') return tagName;
    if (tagIdentifier.mode === 'prefix') return (tagIdentifier.value || '') + tagName;
    if (tagIdentifier.mode === 'suffix') return tagName + (tagIdentifier.value || '');
    return tagName;
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
    this.client = new MachbaseClient(config);
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
   * DB 연결 + 선택적으로 append 스트림 열기
   * @param {boolean} [useStream=false] - true면 append 스트림도 함께 열기
   * @returns {Promise<Error|null>}
   */
  async open(useStream = false) {
    await this.client.connect();
    if (useStream) {
      this.stream = new MachbaseStream();
      return this.stream.open(
        this.client,
        this.logicalTable,
        this.schema.columns.map(c => ({ name: c.name, type: c.dataType() }))
      );
    }
    return null;
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
    await this.client.close().catch(err => { if (!firstErr) firstErr = err; });
    return firstErr;
  }

  /**
   * 논리 테이블 전체 조회
   * @returns {Promise<Array<object>>}
   */
  async read() {
    const columnNames = this.schema.columns.map(c => c.name.toLowerCase());
    const columnNamesUpper = this.schema.columns.map(c => c.name);
    const colList = columnNames.join(', ');
    const sql = `SELECT ${colList} FROM ${this.logicalTable}`;
    try {
      const rows = await this.client.query(sql);
      return (rows || []).map(row => {
        const data = {};
        for (let i = 0; i < columnNames.length; i++) {
          data[columnNamesUpper[i]] = row[columnNames[i]];
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
    if (!rows || rows.length === 0) return null;
    if (!this.stream) return new Error('TagTable.append called before open()');
    const matrix = rows.map(row =>
      this.schema.columns.map(col => {
        const val = row[col.name];
        if (val != null) {
          if (col.dataType() === 'int64' && typeof val === 'number' && !Number.isInteger(val))
            getLogger().warn('table', { msg: `int64 column '${col.name}' received non-integer number ${val}, truncating` });
          else if (typeof val === 'number' && !isFinite(val))
            getLogger().warn('table', { col: col.name, value: String(val), msg: `non-finite float value replaced with null` });
        }
        return _toCell(col, val);
      })
    );
    return this.stream.append(matrix);
  }

  /**
   * VOLATILE TABLE + JOIN 방식으로 배치 내 첫 번째 miss row의 0-based 인덱스를 반환
   * schema에 NAME 컬럼이 있어야 한다.
   * @param {Array<{ canonical: string, time: bigint }>} rows
   * @param {MachbaseClient} client - 배치마다 신규 생성된 독립 연결
   * @returns {Promise<{ firstMissIdx: number|null, err: Error|null }>}
   */
  async findFirstMissRow(rows, client) {
    return _findFirstMissRow(this.logicalTable, this.schema, rows, client);
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
    this.client = new MachbaseClient(config);
    /** @type {string} TAG 논리 테이블명 — '_TAG_DATA_0' → 'TAG' */
    this.logicalTable = dataTable.replace(/^_/, '').replace(/_DATA_\d+$/, '');
    /** @type {TableSchema|null} */
    this.schema = null;
    /** @type {TagAliasCache|null} */
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
   * _TAG_META 전체 로드 후 내부 aliasCache 구성
   * @returns {Error|null}
   */
  async loadTagAliasCache() {
    try {
      const rows = await this.client.selectTagNames(this.logicalTable);
      this.aliasCache = new TagAliasCache();
      for (const row of (rows || [])) {
        this.aliasCache.set(row._ID, row.name);
      }
      return null;
    } catch (err) {
      getLogger().error('table', { msg: `loadTagAliasCache failed: ${err.message}` });
      return err;
    }
  }

  /**
   * DB 연결
   */
  async open() {
    await this.client.connect();
  }

  /**
   * DB 연결 닫기
   * @returns {Error|null}
   */
  async close() {
    await this.client.close().catch(() => {});
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
   * RID 기반 배치 읽기
   *
   * aliasCache가 설정된 경우 tagId를 canonical name으로 resolve하여 data.NAME에 채운다.
   * resolve 결과가 'drop_not_found'인 행은 결과에서 제외된다.
   *
   * @param {bigint} startRid
   * @param {number} [limit=1000]
   * @param {number} [rangeSize=50000]
   * @param {{ mode: 'prefix'|'suffix'|'none', value?: string }|null} [tagIdentifier=null]
   * @param {string[]|null} [sourceColumns=null] - 읽을 컬럼명 목록 (null이면 전체)
   * @returns {Promise<{ rows: Array<{ rid: bigint, data: object }>, err: Error|null }>}
   */
  async read(startRid, limit = 1000, rangeSize = 50000, tagIdentifier = null, sourceColumns = null) {
    const tableName = this.dataTable;
    const cols = this.schema.columns.filter(c => !(c.flag & FLAG_METADATA));
    const filtered = sourceColumns
      ? cols.filter(c => sourceColumns.includes(c.name))
      : cols;
    const columnNames = filtered.map(c => c.name.toLowerCase());
    const columnNamesUpper = filtered.map(c => c.name);

    let endRid = startRid + BigInt(rangeSize);
    try {
      const maxRid = await this.client.selectMaxRid(tableName);
      const maxRidPlusOne = maxRid + 1n;
      if (maxRidPlusOne < endRid) endRid = maxRidPlusOne;
    } catch (e) {
      getLogger().warn('table', { msg: `MAX(_RID) query failed for ${tableName}, using startRid+rangeSize as endRid: ${e.message}` });
    }
    if (endRid < startRid) endRid = startRid;

    const colList = ['_RID', ...columnNames].join(', ');
    const sql = `SELECT /*+ RID_RANGE(${tableName}, ${startRid}, ${endRid}) */ ${colList} FROM ${tableName} WHERE _RID >= ${startRid} LIMIT ${limit}`;
    try {
      const rows = await this.client.query(sql);
      const result = [];
      for (const row of (rows || [])) {
        if (row._RID == null) {
          getLogger().warn('table', { msg: `row with null _RID skipped in ${tableName}` });
          continue;
        }
        const data = {};
        for (let i = 0; i < columnNames.length; i++) {
          data[columnNamesUpper[i]] = row[columnNames[i]];
        }
        if (this.aliasCache) {
          const tagId = data.NAME;
          let { canonical, status } = this.aliasCache.resolve(tagId, tagIdentifier);
          if (status === 'drop_not_found' && this.logicalTable) {
            let name;
            try {
              name = await this.client.selectTagNameByTagId(this.logicalTable, tagId);
            } catch (lookupErr) {
              getLogger().error('table', { msg: `selectTagNameByTagId failed: ${lookupErr.message}` });
              return { rows: [], err: lookupErr };
            }
            if (name == null) continue;
            this.aliasCache.set(tagId, name);
            ({ canonical, status } = this.aliasCache.resolve(tagId, tagIdentifier));
          }
          if (status === 'drop_not_found') continue;
          data.NAME = canonical;
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

module.exports = { TagAliasCache, LogTable, TagTable, TagDataTable };
