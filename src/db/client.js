'use strict';

const { createConnection, QueryError } = require('@machbase/ts-client');
const { ColumnType, Column, TableSchema, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA, FLAG_PRIMARY } = require('./types.js');


class MachbaseClient {
  constructor(config) {
    this.conn = createConnection(config);
  }

  async connect() {
    await this.conn.connect();
  }

  async close() {
    await this.conn.end();
  }

  async query(sql, values) {
    const [rows] = await this.conn.query(sql, values);
    return rows || [];
  }

  async appendOpen(table, columns, options) {
    return this.conn.appendOpen(table, columns, options);
  }

  async execute(sql) {
    return this.conn.execute(sql);
  }

  /**
   * 테이블 타입 조회
   * @param {string} tableName
   * @returns {Promise<{ type: 'TAG'|'LOG'|'UNSUPPORTED' }>}
   */
  async selectTableType(tableName) {
    const rows = await this.query(
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
   * TAG 데이터 파티션 목록 조회
   * @param {string} tableName - 논리 테이블명
   * @returns {Promise<Array<{ data_table: string }>>}
   */
  async selectTagDataTables(tableName) {
    const pattern = `_${tableName}_DATA_%`;
    const sql = `
      SELECT m.NAME AS data_table
      FROM V$STORAGE_TAG_TABLES v, M$SYS_TABLES m
      WHERE v.ID = m.ID AND m.NAME LIKE ?
      ORDER BY m.NAME
    `.trim();
    return this.query(sql, [pattern]);
  }

  /**
   * 사용자 테이블 목록 조회 (TAG/LOG 타입만, 내부 테이블 제외)
   * @returns {Promise<Array<{ NAME: string, TYPE: number }>>}
   */
  async selectAllTables() {
    const sql = `
      SELECT NAME, TYPE
      FROM M$SYS_TABLES
      WHERE TYPE IN (0, 6)
    `.trim();
    return this.query(sql);
  }

  /**
   * 테이블명 기준으로 M$SYS_COLUMNS 조회
   * TAG META 컬럼 조회 및 LOG 컬럼 조회에 사용
   * c.FLAG === 67108864
   * @param {string} tableName
   * @returns {Promise<Array<{ NAME: string, TYPE: number, ID: number, LENGTH: number, FLAG: number }>>}
   */
  async selectColumnsByTableName(tableName) {
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
   * 테이블의 최대 RID 조회
   * @param {string} tableName
   * @returns {Promise<bigint>} 빈 테이블이면 0n
   */
  async selectMaxRid(tableName) {
    const rows = await this.query(`SELECT MAX(_RID) as max_rid FROM ${tableName}`);
    const raw = rows?.[0]?.max_rid;
    return raw == null ? 0n : BigInt(raw);
  }

  /**
   * TAG META 테이블 전체 조회
   * @param {string} logicalTable - 논리 테이블명
   * @returns {Promise<Array<{ _ID: bigint, name: string }>>}
   */
  async selectTagNames(logicalTable) {
    return this.query(`SELECT _ID, name FROM _${logicalTable}_META`);
  }

  /**
   * TAG META 테이블 조회 (_ID, name + metadata columns)
   * @param {string} logicalTable - 논리 테이블명
   * @param {string[]} metaColNames - metadata column 이름 목록
   * @param {{ in?: string[], like?: string }|null} [nameFilter=null] - NAME 컬럼 필터
   * @returns {Promise<Array<{ _ID: bigint, name: string, [col]: any }>>}
   */
  async selectTagMeta(logicalTable, metaColNames = []) {
    const extraCols = metaColNames.length > 0 ? ', ' + metaColNames.join(', ') : '';
    return this.query(`SELECT _ID, name${extraCols} FROM _${logicalTable}_META`);
  }

  /**
   * TAG META 업데이트 (name 변경 및/또는 metadata column value 변경)
   * UPDATE {logicalTable} METADATA SET ... WHERE NAME='oldName'
   * @param {string} logicalTable - 논리 테이블명 (e.g. 'TAG')
   * @param {string} oldName - WHERE NAME=... 기준 (현재 dst name)
   * @param {Array<{ name: string, value: any }>} sets - SET 절 항목 (NAME 포함 가능)
   */
  async updateTagMeta(logicalTable, oldName, sets) {
    const esc = v => v == null ? 'NULL'
      : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'`
      : String(v);
    const setClauses = sets.map(({ name, value }) => `${name} = ${esc(value)}`).join(', ');
    await this.execute(
      `UPDATE ${logicalTable} METADATA SET ${setClauses} WHERE NAME = ${esc(oldName)}`
    );
  }

  /**
   * TAG META 테이블에서 tagId 기준 단건 조회 (_ID, name, metadata 컬럼 포함)
   * @param {string} logicalTable - 논리 테이블명
   * @param {number|bigint} tagId - _ID 값
   * @param {string[]} [metaColNames=[]] - metadata column 이름 목록
   * @returns {Promise<{ _ID: bigint, name: string, [col]: any }|null>} 없으면 null
   */
  async selectTagMetaById(logicalTable, tagId, metaColNames = []) {
    const extraCols = metaColNames.length > 0 ? ', ' + metaColNames.join(', ') : '';
    const rows = await this.query(
      `SELECT _ID, name${extraCols} FROM _${logicalTable}_META WHERE _ID = ?`,
      [tagId]
    );
    return rows?.[0] ?? null;
  }

  /**
   * src 스키마를 기반으로 TAG 테이블 생성
   * @param {string} tableName
   * @param {import('./types').TableSchema} srcSchema
   */
  async createTagTable(tableName, srcSchema) {
    const dataCols = srcSchema.columns.filter(c => !(c.flag & FLAG_METADATA));
    const metaCols = srcSchema.columns.filter(c =>   c.flag & FLAG_METADATA);

    if (!dataCols.some(c => c.flag & FLAG_PRIMARY))
      throw new Error(`createTagTable: PRIMARY KEY column not found in schema for '${srcSchema.logicalTable}'`);
    if (!dataCols.some(c => c.flag & FLAG_BASETIME))
      throw new Error(`createTagTable: BASETIME column not found in schema for '${srcSchema.logicalTable}'`);

    const colDefs = dataCols.map(c => {
      let def = `${c.name} ${c.sqlType()}`;
      if      (c.flag & FLAG_PRIMARY)   def += ' PRIMARY KEY';
      else if (c.flag & FLAG_BASETIME)  def += ' BASETIME';
      else if (c.flag & FLAG_SUMMARIZED) def += ' SUMMARIZED';
      return def;
    });

    let sql = `CREATE TAG TABLE ${tableName} (${colDefs.join(', ')})`;
    if (metaCols.length > 0) {
      const metaDefs = metaCols.map(c => `${c.name} ${c.sqlType()}`).join(', ');
      sql += ` METADATA (${metaDefs})`;
    }
    await this.execute(sql);
  }

  /**
   * src 스키마를 기반으로 LOG 테이블 생성
   * @param {string} tableName
   * @param {import('./types').TableSchema} srcSchema
   */
  async createLogTable(tableName, srcSchema) {
    const colDefs = srcSchema.columns.map(c => `${c.name} ${c.sqlType()}`);
    await this.execute(`CREATE TABLE ${tableName} (${colDefs.join(', ')})`);
  }
}

/**
 * 값을 int64(BigInt)로 변환한다.
 * @param {*} val
 * @returns {bigint}
 */
function toInt64(val) {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(Math.trunc(val));
  return BigInt(val);
}

module.exports = { createConnection, QueryError, MachbaseClient, toInt64, ColumnType, Column, TableSchema };
