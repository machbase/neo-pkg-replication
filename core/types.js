'use strict';

// ─── ColumnType ───────────────────────────────────────────────────────────────

/**
 * Machbase 컬럼 타입 정의
 * (공식 문서: https://docs.machbase.com/dbms/sql-reference/datatypes/#data-type-table)
 *
 * @property {number} code      - M$SYS_COLUMNS.TYPE 값
 * @property {string} type      - appendOpen 프로토콜 타입 문자열
 * @property {*}      safeNull  - 타입 안전 null 대체값 (append 패딩용)
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

// ─── Column ───────────────────────────────────────────────────────────────────

/**
 * 테이블 컬럼 메타정보
 *
 * @property {string} name - 컬럼명 (UPPERCASE, M$SYS_COLUMNS 기준)
 * @property {ColumnType} columnType - 컬럼 타입
 * @property {number} id - 컬럼 ID (M$SYS_COLUMNS.ID)
 * @property {'key'|'data'|'metadata'} category
 *   - key: TAG의 NAME 컬럼 (논리적 PK)
 *   - data: 일반 데이터 컬럼 (DATA 파티션 및 LOG)
 *   - metadata: TAG META 테이블의 추가 속성 컬럼
 */
class Column {
  constructor(name, columnType, id, category) {
    this.name = name;
    this.columnType = columnType;
    this.id = id;
    this.category = category;
  }
}

// ─── TableSchema ─────────────────────────────────────────────────────────────

/**
 * 불변 테이블 컬럼 구조 정보
 *
 * @property {string} tableType - 'TAG' | 'LOG'
 * @property {string} logicalTable
 * @property {Column[]} columns
 */
class TableSchema {
  constructor(tableType, logicalTable, columns) {
    this.tableType = tableType;
    this.logicalTable = logicalTable;
    /** @type {Column[]} */
    this.columns = columns || [];
  }
}

module.exports = { ColumnType, Column, TableSchema };
