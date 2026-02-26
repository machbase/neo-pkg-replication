'use strict';

const { createConnection, QueryError } = require('@machbase/ts-client');

/**
 * Machbase 컬럼 타입 정의
 * (공식 문서: https://docs.machbase.com/dbms/sql-reference/datatypes/#data-type-table)
 *
 * @property {number} code      - M$SYS_COLUMNS.TYPE 값
 * @property {string} type      - appendOpen 프로토콜 타입 문자열
 * @property {bigint|number|null} nullValue - (미사용) 타입별 NULL sentinel 참조값
 */
class ColumnType {
  constructor(code, type, nullValue, safeNull) {
    this.code      = code;
    this.type      = type;
    this.nullValue = nullValue;
    this.safeNull  = safeNull;
  }

  static SHORT     = new ColumnType(4,   'int32',   -2147483648,              0);
  static USHORT    = new ColumnType(104, 'int32',   -2147483648,              0);
  static INTEGER   = new ColumnType(8,   'int32',   -2147483648,              0);
  static UINTEGER  = new ColumnType(108, 'int32',   -2147483648,              0);
  static LONG      = new ColumnType(12,  'int64',   -9223372036854775808n,    0n);
  static ULONG     = new ColumnType(112, 'int64',   -9223372036854775808n,    0n);
  static DATETIME  = new ColumnType(6,   'int64',   18446744073709551615n,    0n);
  static FLOAT     = new ColumnType(16,  'float64', 1.7976931348623157e+308,  0.0);
  static DOUBLE    = new ColumnType(20,  'float64', 1.7976931348623157e+308,  0.0);
  static VARCHAR   = new ColumnType(5,   'varchar', null,                     '');
  static TEXT      = new ColumnType(49,  'varchar', null,                     '');
  static CLOB      = new ColumnType(53,  'varchar', null,                     '');
  static BLOB      = new ColumnType(57,  'varchar', null,                     '');
  static BINARY    = new ColumnType(97,  'varchar', null,                     '');
  static IPV4      = new ColumnType(32,  'varchar', null,                     '');
  static IPV6      = new ColumnType(36,  'varchar', null,                     '');
  static JSON      = new ColumnType(61,  'varchar', null,                     '');
  static UNKNOWN   = new ColumnType(-1,  'unknown', null,                     null);

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
    return rows || [];
  }

  async appendOpen(table, columns, options) {
    return this.conn.appendOpen(table, columns, options);
  }
}

module.exports = { createConnection, QueryError, MachbaseClient, ColumnType };
