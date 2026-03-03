'use strict';

const { createConnection, QueryError } = require('@machbase/ts-client');

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
// 현재 DOUBLE 타입(code 20)에만 적용됨. FLOAT(code 16) 지원 시
// FLT32_MIN_NORMAL(~1.175e-38) 별도 임계값 처리 필요.
const DOUBLE_MIN_NORMAL = 2.2250738585072014e-308;

/**
 * 쿼리 결과 row 배열에서 BE→LE 오독으로 손상된 double 값을 복원한다.
 * @param {object[]} rows
 * @returns {object[]}
 */
function fixDoubleEndian(rows) {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const v = row[key];
      if (typeof v !== 'number') continue;
      if (v !== 0 && Math.abs(v) < DOUBLE_MIN_NORMAL) {
        // 라이브러리가 LE로 읽은 바이트를 다시 BE로 해석하면 원래 값이 나온다.
        // 한계: NaN/Infinity는 이 조건(Math.abs(v) < DOUBLE_MIN_NORMAL)이 false가 되어
        // 검출되지 않으며, BE로 저장된 정상값이 LE로 읽혀 NaN/Infinity가 된 경우는 복원 불가.
        _fixBuf.writeDoubleLE(v, 0);
        row[key] = _fixBuf.readDoubleBE(0);
      }
    }
  }
  return rows;
}

/**
 * Machbase 컬럼 타입 정의
 * (공식 문서: https://docs.machbase.com/dbms/sql-reference/datatypes/#data-type-table)
 *
 * @property {number} code      - M$SYS_COLUMNS.TYPE 값
 * @property {string} type      - appendOpen 프로토콜 타입 문자열
 */
class ColumnType {
  constructor(code, type, safeNull) {
    this.code     = code;
    this.type     = type;
    this.safeNull = safeNull;
  }

  static SHORT     = new ColumnType(4,   'int32',   0);
  static USHORT    = new ColumnType(104, 'int32',   0);
  static INTEGER   = new ColumnType(8,   'int32',   0);
  static UINTEGER  = new ColumnType(108, 'int32',   0);
  static LONG      = new ColumnType(12,  'int64',   0n);
  static ULONG     = new ColumnType(112, 'int64',   0n);
  static DATETIME  = new ColumnType(6,   'int64',   0n);
  static FLOAT     = new ColumnType(16,  'float64', 0.0);
  static DOUBLE    = new ColumnType(20,  'float64', 0.0);
  static VARCHAR   = new ColumnType(5,   'varchar', '');
  static TEXT      = new ColumnType(49,  'varchar', '');
  static CLOB      = new ColumnType(53,  'varchar', '');
  static BLOB      = new ColumnType(57,  'varchar', '');
  static BINARY    = new ColumnType(97,  'varchar', '');
  static IPV4      = new ColumnType(32,  'varchar', '');
  static IPV6      = new ColumnType(36,  'varchar', '');
  static JSON      = new ColumnType(61,  'varchar', '');
  static UNKNOWN   = new ColumnType(-1,  'unknown', null);

  /** @type {Map<number, ColumnType>} */
  static #byCode = new Map(
    [
      ColumnType.SHORT, ColumnType.USHORT, ColumnType.INTEGER, ColumnType.UINTEGER,
      ColumnType.LONG, ColumnType.ULONG, ColumnType.DATETIME,
      ColumnType.FLOAT, ColumnType.DOUBLE,
      ColumnType.VARCHAR, ColumnType.TEXT, ColumnType.CLOB, ColumnType.BLOB,
      ColumnType.BINARY, ColumnType.IPV4, ColumnType.IPV6, ColumnType.JSON,
    ].map(ct => [ct.code, ct])
  );

  /**
   * M$SYS_COLUMNS.TYPE 코드로 ColumnType 인스턴스 반환
   * @param {number} code
   * @returns {ColumnType}
   */
  static fromCode(code) {
    return ColumnType.#byCode.get(code) ?? ColumnType.UNKNOWN;
  }
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

  async getTableType(table) {
    try {
      const rows = await this.query(
        'SELECT TYPE FROM M$SYS_TABLES WHERE NAME = ?',
        [table]
      );
      if (!rows || rows.length === 0) return { type: 'UNSUPPORTED' };
      const typeCode = rows[0].TYPE;
      if (typeCode === 6) return { type: 'TAG' };
      if (typeCode === 0) return { type: 'LOG' };
      return { type: 'UNSUPPORTED' };
    } catch (err) {
      // 연결 오류도 UNSUPPORTED로 반환하여 JobRunner에서 mapping skip 처리됨.
      // 연결 오류와 테이블 미존재를 구분하지 않는 의도적 설계.
      console.error(JSON.stringify({ level: 'error', stage: 'catalog', table, msg: `getTableType DB error: ${err.message}` }));
      return { type: 'UNSUPPORTED' };
    }
  }

  async listTagDataTables(logicalTable) {
    const pattern = `_${logicalTable}_DATA_%`;
    const sql = `
      SELECT m.NAME AS data_table, m.ID AS table_id
      FROM V$STORAGE_TAG_TABLES v, M$SYS_TABLES m
      WHERE v.ID = m.ID AND m.NAME LIKE ?
      ORDER BY m.NAME
    `.trim();
    try {
      const rows = await this.query(sql, [pattern]);
      return (rows || []).map(r => ({ data_table: r.data_table, table_id: Number(r.table_id) }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'catalog', table: logicalTable, msg: `listTagDataTables DB error: ${err.message}` }));
      return [];
    }
  }
}

module.exports = { createConnection, QueryError, MachbaseClient, ColumnType };
