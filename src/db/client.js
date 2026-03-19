'use strict';

const { createConnection, QueryError } = require('@machbase/ts-client');
const { ColumnType, Column, TableSchema, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA, FLAG_PRIMARY } = require('./types.js');
const { getInstance: getLogger } = require('../lib/logger.js');

// ── @machbase/ts-client FLOAT/DOUBLE endian 버그 우회 ────────────────────────
//
// 버그 위치: node_modules/@machbase/ts-client/dist/connection.js
//           decodeFixedField() 함수 (1164~1167줄)
//
// 원인:
//   decodeFixedField()는 FLT32/FLT64 타입을 항상 readFloatLE/readDoubleLE로
//   읽도록 하드코딩되어 있다. 그러나 Machbase TAG 데이터 파티션은 파티션 인덱스
//   (DATA_0, DATA_1, …)에 따라 DOUBLE 값을 Big-Endian 또는 Little-Endian으로
//   저장한다. 서버가 BE로 저장한 값을 LE로 읽으면 IEEE 754 상 극소값(denormal)이
//   된다. 예: 3200.0 → 2.1407e-319, 85.0 → 2.083044e-317.
//
// 우회 방법 (fixDoubleEndian):
//   BE로 저장된 값을 LE로 잘못 읽으면 대부분 denormal(|v| < 2.225e-308)이 된다.
//   그러나 일부 BE 값은 LE로 읽었을 때 매우 큰 정수(isInteger && |v| > 0xffffffff)가
//   되기도 한다. 예: BE 1.732051 → LE -2.077e+34 (정수, 절댓값 > 2^32).
//   두 경우 모두 바이트를 뒤집어(LE→BE 재해석) 원래 값으로 복원한다.
//   MachbaseClient.query() 반환 직전에 모든 row에 적용된다.
//
// 라이브러리 재설치(npm install) 후에도 이 우회 코드가 있으므로 재발하지 않는다.
// 상세 분석: PROJECT.md 11.5절
// ─────────────────────────────────────────────────────────────────────────────
// 단일 스레드(Node.js) 환경에서 동기 코드(for 루프) 내에서만 사용되므로
// 모듈 레벨 공유 Buffer여도 재진입 문제 없음.
const _fixBuf = Buffer.allocUnsafe(8);
// IEEE 754 double 최소 정규수: 이 값보다 작은 nonzero number는 denormal
const DOUBLE_MIN_NORMAL = 2.2250738585072014e-308;
// IEEE 754 float32 최소 정규수
// FLOAT(code 16) 컬럼이 BE로 저장된 경우 이 임계값으로 감지한다.
const FLOAT_MIN_NORMAL = 1.1754943508222875e-38;

/**
 * 쿼리 결과 row 배열에서 BE→LE 오독으로 손상된 float/double 값을 복원한다.
 * @param {object[]} rows
 * @returns {object[]}
 */
function fixDoubleEndian(rows) {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const v = row[key];
      if (typeof v !== 'number' || v === 0 || !isFinite(v)) continue;
      const abs = Math.abs(v);
      // BE→LE 오독 패턴 두 가지:
      //   1. denormal: abs < FLOAT_MIN_NORMAL
      //   2. 큰 정수: Number.isInteger(v) && abs > 0xffffffff
      //      (일부 BE double 값을 LE로 읽으면 매우 큰 정수처럼 보임)
      if (abs < FLOAT_MIN_NORMAL || (Number.isInteger(v) && abs > 0xffffffff)) {
        // denormal 범위: DOUBLE(8바이트) 또는 FLOAT(4바이트) BE→LE 오독 가능성
        // DOUBLE 기준으로 먼저 시도한 후, 복원값이 DOUBLE_MIN_NORMAL 이상이면 정상 복원된 것으로 판단
        _fixBuf.writeDoubleLE(v, 0);
        const asDoubleBE = _fixBuf.readDoubleBE(0);
        if (Math.abs(asDoubleBE) >= DOUBLE_MIN_NORMAL) {
          // DOUBLE 컬럼이 BE로 저장된 경우
          getLogger().trace('client', { msg: `fixDoubleEndian DOUBLE: col='${key}' raw=${v} → ${asDoubleBE}` });
          row[key] = asDoubleBE;
        } else {
          // FLOAT 컬럼 시도: 라이브러리가 4바이트 LE로 읽었을 가능성
          _fixBuf.writeFloatLE(v, 0);
          const asFloatBE = _fixBuf.readFloatBE(0);
          getLogger().trace('client', { msg: `fixDoubleEndian FLOAT: col='${key}' raw=${v} → ${asFloatBE}` });
          row[key] = asFloatBE;
        }
      }
    }
  }
  return rows;
}

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
    return fixDoubleEndian(rows || []);
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
   * TAG META 테이블 전체 조회 (_ID, name + metadata columns)
   * @param {string} logicalTable - 논리 테이블명
   * @param {string[]} metaColNames - metadata column 이름 목록
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
   * TAG META 테이블에서 tagId → name 단건 조회
   * @param {string} logicalTable - 논리 테이블명
   * @param {number|bigint} tagId - _ID 값
   * @returns {Promise<string|null>} name, 없으면 null
   */
  async selectTagNameByTagId(logicalTable, tagId) {
    const rows = await this.query(
      `SELECT name FROM _${logicalTable}_META WHERE _ID = ?`,
      [tagId]
    );
    return rows?.[0]?.name ?? null;
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
