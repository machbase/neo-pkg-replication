'use strict';

const { createConnection, QueryError } = require('@machbase/ts-client');
const { ColumnType, Column, TableSchema } = require('../core/types.js');

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
//   BE로 저장된 값을 LE로 잘못 읽으면 반드시 denormal(|v| < 2.225e-308)이 된다.
//   실측 센서값이 우연히 denormal 범위에 들어오는 경우는 실무상 없으므로,
//   number 타입 필드가 denormal이면 바이트를 뒤집어(LE→BE 재해석) 원래 값으로
//   복원한다. MachbaseClient.query() 반환 직전에 모든 row에 적용된다.
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
      if (abs < FLOAT_MIN_NORMAL) {
        // denormal 범위: DOUBLE(8바이트) 또는 FLOAT(4바이트) BE→LE 오독 가능성
        // DOUBLE 기준으로 먼저 시도한 후, 복원값이 FLOAT_MIN_NORMAL 이상이면 정상 복원된 것으로 판단
        _fixBuf.writeDoubleLE(v, 0);
        const asDoubleBE = _fixBuf.readDoubleBE(0);
        if (Math.abs(asDoubleBE) >= DOUBLE_MIN_NORMAL) {
          // DOUBLE 컬럼이 BE로 저장된 경우
          row[key] = asDoubleBE;
        } else if (abs < FLOAT_MIN_NORMAL) {
          // FLOAT 컬럼 시도: 라이브러리가 4바이트 LE로 읽었을 가능성
          // 한계: NaN/Infinity로 변환된 경우 복원 불가
          _fixBuf.writeFloatLE(v, 0);
          row[key] = _fixBuf.readFloatBE(0);
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
   * @param {string} table
   * @returns {Promise<BigInt>} 빈 테이블이면 0n
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
