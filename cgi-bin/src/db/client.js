'use strict';

/**
 * @fileoverview MachbaseClient — machcli 동기 DB 클라이언트 래퍼
 *
 * 모든 메서드는 동기(sync)로 동작한다.
 * 단일 연결에서 동시 query + append를 수행할 수 없으므로 Worker별 독립 인스턴스를 사용한다.
 */

const { Client } = require('machcli');
const { ColumnType, Column, TableSchema, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA, FLAG_PRIMARY } = require('./types.js');

function _isStructureModifiedErrorMessage(message) {
  const text = String(message || '');
  return text.indexOf('MACHCLI-ERR-2361') >= 0
    || text.toLowerCase().indexOf('structure was modified') >= 0;
}


/**
 * Machbase Neo DB 연결 및 쿼리 클라이언트
 */
class MachbaseClient {
  /**
   * @param {{ host: string, port: number, user: string, password: string }} config - DB 접속 정보
   */
  constructor(config) {
    this._config = config;
    this._db = null;
    this._conn = null;
  }

  /**
   * DB에 연결한다.
   */
  connect() {
    this._db   = new Client(this._config);
    this._conn = this._db.connect();
  }

  /**
   * DB 연결을 닫는다. 오류는 무시한다.
   */
  close() {
    try { this._conn && this._conn.close(); } catch (_) {}
    try { this._db   && this._db.close();   } catch (_) {}
    this._conn = null;
    this._db   = null;
  }

  /**
   * SELECT 쿼리를 실행하고 결과 행 배열을 반환한다.
   * @param {string} sql
   * @param {Array} [values] - 바인딩 파라미터
   * @returns {Array<object>}
   */
  query(sql, values) {
    const runQuery = () => {
      let rows = null;
      try {
        rows = values && values.length > 0
          ? this._conn.query(sql, ...values)
          : this._conn.query(sql);

        const result = [];
        for (const row of rows) {
          result.push(row);
        }
        return result;
      } finally {
        // machcli result cursor는 소비 후 명시적으로 닫아야 native query handle 누수를 막을 수 있다.
        // 이 wrapper는 worker의 maxRid polling/read/meta lookup 공통 경로이므로 누수가 쌓이면
        // 장시간 복제 중 간헐적인 query 실패로 이어질 수 있다.
        try { rows && rows.close && rows.close(); } catch (_) {}
      }
    };

    try {
      return runQuery();
    } catch (err) {
      if (_isStructureModifiedErrorMessage(err.message)) {
        // TAG 신규 등록처럼 source 내부 구조가 바뀌는 순간 기존 native connection이 stale 상태가 될 수 있다.
        // query는 읽기 전용이므로 연결을 새로 열고 한 번 더 시도한다.
        try { this.close(); } catch (_) {}
        this.connect();
        try {
          return runQuery();
        } catch (retryErr) {
          const wrapped = new Error(retryErr.message);
          wrapped.retryable = _isStructureModifiedErrorMessage(retryErr.message);
          throw wrapped;
        }
      }
      const wrapped = new Error(err.message);
      wrapped.retryable = _isStructureModifiedErrorMessage(err.message);
      throw wrapped;
    }
  }

  /**
   * 지정 테이블에 대한 append 스트림을 열어 반환한다.
   * @param {string} table
   * @param {Array<{ name: string }>} columns
   * @returns {object} machcli Appender 인스턴스
   */
  openAppender(table, columns) {
    const appender = this._conn.append(table);
    return appender.withInputColumns(...columns.map(c => c.name));
  }

  /**
   * DDL/DML SQL을 실행한다.
   * @param {string} sql
   * @param {...*} values - 바인딩 파라미터
   * @returns {*}
   */
  execute(sql, ...values) {
    try {
      return values.length > 0 ? this._conn.exec(sql, ...values) : this._conn.exec(sql);
    } catch (err) {
      throw new Error(err.message);
    }
  }

  /**
   * 테이블 타입 조회
   * @param {string} tableName
   * @returns {{ type: 'TAG'|'LOG'|'UNSUPPORTED' }}
   */
  selectTableType(tableName) {
    const rows = this.query(
      'SELECT TYPE FROM M$SYS_TABLES WHERE NAME = ?',
      [tableName]
    );
    if (!rows || rows.length === 0) return { type: 'UNSUPPORTED' };
    switch (rows[0].TYPE) {
      case 6: return { type: 'TAG' };
      case 0: return { type: 'LOG' };
      default: return { type: 'UNSUPPORTED' };
    }
  }

  /**
   * owner.table 형태를 { owner, table }로 분리한다.
   * @param {string} tableName
   * @returns {{ owner: string|null, table: string }}
   */
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

  /**
   * owner.table 형태를 포함하여 TAG META 테이블명을 반환한다.
   * @param {string} logicalTable
   * @returns {string}
   */
  qualifiedTagMetaTable(logicalTable) {
    const qualified = this.splitQualifiedTableName(logicalTable);
    const metaTable = `_${qualified.table}_META`;
    return qualified.owner ? `${qualified.owner}.${metaTable}` : metaTable;
  }

  /**
   * owner.table 형태를 포함하여 테이블 기본 정보를 조회한다.
   * @param {string} tableName
   * @returns {{ owner: string|null, table: string, id: number|null, type: number|null }}
   */
  selectTableInfoQualified(tableName) {
    const qualified = this.splitQualifiedTableName(tableName);
    let rows;
    if (!qualified.owner) {
      rows = this.query(
        'SELECT ID, TYPE FROM M$SYS_TABLES WHERE NAME = ?',
        [qualified.table]
      );
    } else {
      rows = this.query(
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

  /**
   * owner.table 형태를 포함하여 테이블 타입 조회
   * @param {string} tableName
   * @returns {{ type: 'TAG'|'LOG'|'UNSUPPORTED' }}
   */
  selectTableTypeQualified(tableName) {
    const info = this.selectTableInfoQualified(tableName);
    if (info.type == null) return { type: 'UNSUPPORTED' };
    switch (info.type) {
      case 6: return { type: 'TAG' };
      case 0: return { type: 'LOG' };
      default: return { type: 'UNSUPPORTED' };
    }
  }

  /**
   * TAG 데이터 파티션 목록 조회
   * @param {string} tableName - 논리 테이블명
   * @returns {Array<{ data_table: string }>}
   */
  selectTagDataTables(tableName) {
    const logicalTable = this.splitQualifiedTableName(tableName).table;
    const pattern = `_${logicalTable}_DATA_%`;
    const sql = `
      SELECT m.NAME AS data_table
      FROM V$STORAGE_TAG_TABLES v, M$SYS_TABLES m
      WHERE v.ID = m.ID AND m.NAME LIKE ?
      ORDER BY m.NAME
    `.trim();
    return this.query(sql, [pattern]);
  }

  /**
   * 사용자 테이블 목록 조회 (TAG/LOG 타입만)
   * @returns {Array<{ NAME: string, TYPE: number }>}
   */
  selectAllTables() {
    const sql = `
      SELECT NAME, TYPE
      FROM M$SYS_TABLES
      WHERE TYPE IN (0, 6)
    `.trim();
    return this.query(sql);
  }

  /**
   * 사용자 관점의 논리 테이블 목록 조회 (TAG/LOG + owner)
   * @returns {Array<{ TABLE_NAME: string, TABLE_TYPE: number, OWNER: string|null }>}
   */
  selectVisibleTables() {
    const sql = `
      SELECT t.NAME AS TABLE_NAME,
             t.TYPE AS TABLE_TYPE,
             u.NAME AS OWNER
      FROM M$SYS_TABLES t
      LEFT JOIN M$SYS_USERS u
        ON t.USER_ID = u.USER_ID
      WHERE t.TYPE IN (0, 6)
      ORDER BY t.NAME
    `.trim();
    return this.query(sql);
  }

  /**
   * 테이블명 기준으로 M$SYS_COLUMNS 조회
   * @param {string} tableName
   * @returns {Array<{ NAME: string, TYPE: number, ID: number, LENGTH: number, FLAG: number }>}
   */
  selectColumnsByTableName(tableName) {
    const sql = `
      SELECT c.NAME, c.TYPE, c.ID, c.LENGTH, c.FLAG
      FROM M$SYS_COLUMNS c, M$SYS_TABLES t
      WHERE c.TABLE_ID = t.ID AND t.NAME = ?
        AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim();
    return this.query(sql, [tableName]);
  }

  /**
   * owner.table 형태를 포함하여 M$SYS_COLUMNS 조회
   * @param {string} tableName
   * @returns {Array<{ NAME: string, TYPE: number, ID: number, LENGTH: number, FLAG: number }>}
   */
  selectColumnsByQualifiedTableName(tableName) {
    const info = this.selectTableInfoQualified(tableName);
    if (info.id == null) return [];
    const sql = `
      SELECT c.NAME, c.TYPE, c.ID, c.LENGTH, c.FLAG
      FROM M$SYS_COLUMNS c
      WHERE c.TABLE_ID = ?
        AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim();
    return this.query(sql, [info.id]);
  }

  /**
   * 테이블의 최대 RID 조회
   * @param {string} tableName
   * @returns {bigint} 빈 테이블이면 -1n
   */
  selectMaxRid(tableName) {
    const rows = this.query(`SELECT MAX(_RID) as max_rid FROM ${tableName}`);
    const raw = rows?.[0]?.max_rid;
    return raw == null ? -1n : BigInt(raw);
  }

  /**
   * 논리 테이블 전체 행 수를 조회한다.
   * checkpoint API는 파티션별 합산 대신 사용자가 보는 logical table 기준 count를 보여주기 위해 이 값을 사용한다.
   * @param {string} tableName
   * @returns {bigint}
   */
  selectCountRows(tableName) {
    const rows = this.query(`SELECT COUNT(*) as row_count FROM ${tableName}`);
    const raw = rows?.[0]?.row_count;
    return raw == null ? 0n : BigInt(raw);
  }

  /**
   * TAG META 테이블 전체 조회
   * @param {string} logicalTable - 논리 테이블명
   * @returns {Array<{ _ID: bigint, name: string }>}
   */
  selectTagNames(logicalTable) {
    return this.query(`SELECT _ID, name FROM ${this.qualifiedTagMetaTable(logicalTable)}`);
  }

  /**
   * TAG META에 name 기준 단건 존재 여부를 조회한다.
   * @param {string} logicalTable
   * @param {string} name
   * @returns {{ _ID: bigint, name: string }|null}
   */
  selectTagName(logicalTable, name) {
    const rows = this.query(`SELECT _ID, name FROM ${this.qualifiedTagMetaTable(logicalTable)} WHERE NAME = ?`, [name]);
    return rows?.[0] ?? null;
  }

  /**
   * TAG META 테이블 조회 (_ID, name + metadata columns)
   * @param {string} logicalTable - 논리 테이블명
   * @param {string[]} metaColNames - metadata column 이름 목록
   * @returns {Array<{ _ID: bigint, name: string, [col]: any }>}
   */
  selectTagMeta(logicalTable, metaColNames = []) {
    const extraCols = metaColNames.length > 0 ? ', ' + metaColNames.join(', ') : '';
    return this.query(`SELECT _ID, name${extraCols} FROM ${this.qualifiedTagMetaTable(logicalTable)}`);
  }

  /**
   * TAG META 업데이트
   * @param {string} logicalTable
   * @param {string} oldName
   * @param {Array<{ name: string, value: any }>} sets
   */
  updateTagMeta(logicalTable, oldName, sets) {
    const esc = v => v == null ? 'NULL'
      : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'`
      : String(v);
    const setClauses = sets.map(({ name, value }) => `${name} = ${esc(value)}`).join(', ');
    this.execute(
      `UPDATE ${logicalTable} METADATA SET ${setClauses} WHERE NAME = ${esc(oldName)}`
    );
  }

  /**
   * TAG META에 신규 name/metadata를 등록한다.
   * @param {string} logicalTable
   * @param {Array<any>} values - [name, ...metaValues]
   */
  insertTagMeta(logicalTable, values) {
    const placeholders = values.map(() => '?').join(', ');
    this.execute(`INSERT INTO ${logicalTable} METADATA VALUES (${placeholders})`, ...values);
  }

  /**
   * TAG META 테이블에서 tagId 기준 단건 조회
   * @param {string} logicalTable
   * @param {number|bigint} tagId
   * @param {string[]} metaColNames
   * @returns {{ _ID: bigint, name: string, [col]: any }|null}
   */
  selectTagMetaById(logicalTable, tagId, metaColNames = []) {
    const extraCols = metaColNames.length > 0 ? ', ' + metaColNames.join(', ') : '';
    const rows = this.query(
      `SELECT _ID, name${extraCols} FROM ${this.qualifiedTagMetaTable(logicalTable)} WHERE _ID = ?`,
      [tagId]
    );
    return rows?.[0] ?? null;
  }

  /**
   * TAG META row 수를 반환한다.
   * @param {string} logicalTable
   * @returns {number}
   */
  countTagNames(logicalTable) {
    const rows = this.query(`SELECT COUNT(*) as total_tags FROM ${this.qualifiedTagMetaTable(logicalTable)}`);
    const raw = rows?.[0]?.total_tags;
    return raw == null ? 0 : Number(raw);
  }

  /**
   * TAG 이름 목록을 페이지 단위로 조회한다.
   * @param {string} logicalTable
   * @param {number} offset
   * @param {number} limit
   * @returns {Array<{ NAME: string }>}
   */
  selectTagNamesPaged(logicalTable, offset, limit) {
    return this.query(
      `SELECT NAME FROM ${this.qualifiedTagMetaTable(logicalTable)} ORDER BY NAME LIMIT ${offset}, ${limit}`
    );
  }

  /**
   * 스키마를 기반으로 TAG 테이블 생성
   * @param {string} tableName
   * @param {import('./types').TableSchema} schema
   */
  createTagTable(tableName, schema) {
    const dataCols = schema.columns.filter(c => !(c.flag & FLAG_METADATA));
    const metaCols = schema.columns.filter(c =>   c.flag & FLAG_METADATA);

    if (!dataCols.some(c => c.flag & FLAG_PRIMARY))
      throw new Error(`createTagTable: PRIMARY KEY column not found in schema for '${schema.logicalTable}'`);
    if (!dataCols.some(c => c.flag & FLAG_BASETIME))
      throw new Error(`createTagTable: BASETIME column not found in schema for '${schema.logicalTable}'`);

    const colDefs = dataCols.map(c => {
      let def = `${c.name} ${c.sqlType()}`;
      if      (c.flag & FLAG_PRIMARY)    def += ' PRIMARY KEY';
      else if (c.flag & FLAG_BASETIME)   def += ' BASETIME';
      else if (c.flag & FLAG_SUMMARIZED) def += ' SUMMARIZED';
      return def;
    });

    let sql = `CREATE TAG TABLE ${tableName} (${colDefs.join(', ')})`;
    if (metaCols.length > 0) {
      const metaDefs = metaCols.map(c => `${c.name} ${c.sqlType()}`).join(', ');
      sql += ` METADATA (${metaDefs})`;
    }
    this.execute(sql);
  }

  /**
   * 스키마를 기반으로 LOG 테이블 생성
   * @param {string} tableName
   * @param {import('./types').TableSchema} schema
   */
  createLogTable(tableName, schema) {
    const colDefs = schema.columns.map(c => `${c.name} ${c.sqlType()}`);
    this.execute(`CREATE TABLE ${tableName} (${colDefs.join(', ')})`);
  }
}

module.exports = { MachbaseClient, ColumnType, Column, TableSchema };
