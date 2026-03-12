'use strict';

// ─── ColumnType ───────────────────────────────────────────────────────────────

/**
 * Machbase 컬럼 타입 정의
 * (공식 문서: https://docs.machbase.com/dbms/sql-reference/datatypes/#data-type-table)
 *
 * @property {string|null} ddlType  - CREATE TABLE DDL 타입 (고정 길이) 또는 null (VARCHAR 등 가변)
 * @property {string}      type     - appendOpen 프로토콜 타입 문자열
 * @property {*}           safeNull - 타입 안전 null 대체값 (append 패딩용)
 */
class ColumnType {
  constructor(ddlType, type, safeNull) {
    this.ddlType  = ddlType;
    this.type     = type;
    this.safeNull = safeNull;
  }

  static SHORT     = new ColumnType('SHORT',    'int32',   0);
  static USHORT    = new ColumnType('SHORT',    'int32',   0);
  static INTEGER   = new ColumnType('INTEGER',  'int32',   0);
  static UINTEGER  = new ColumnType('INTEGER',  'int32',   0);
  static LONG      = new ColumnType('LONG',     'int64',   0n);
  static ULONG     = new ColumnType('LONG',     'int64',   0n);
  static DATETIME  = new ColumnType('DATETIME', 'int64',   0n);
  static FLOAT     = new ColumnType('FLOAT',    'float64', 0.0);
  static DOUBLE    = new ColumnType('DOUBLE',   'float64', 0.0);
  static VARCHAR   = new ColumnType(null,       'varchar', '');
  static TEXT      = new ColumnType('TEXT',     'varchar', '');
  static CLOB      = new ColumnType('CLOB',     'varchar', '');
  static BLOB      = new ColumnType('BLOB',     'varchar', '');
  static BINARY    = new ColumnType('BINARY',   'varchar', '');
  static IPV4      = new ColumnType('IPV4',     'varchar', '');
  static IPV6      = new ColumnType('IPV6',     'varchar', '');
  static JSON      = new ColumnType('JSON',     'varchar', '');
  static UNKNOWN   = new ColumnType(null,       'unknown', null);

  /** @type {Map<number, ColumnType>} */
  static #byCode = new Map([
    [4,   ColumnType.SHORT],   [104, ColumnType.USHORT],
    [8,   ColumnType.INTEGER], [108, ColumnType.UINTEGER],
    [12,  ColumnType.LONG],    [112, ColumnType.ULONG],
    [6,   ColumnType.DATETIME],
    [16,  ColumnType.FLOAT],   [20,  ColumnType.DOUBLE],
    [5,   ColumnType.VARCHAR], [49,  ColumnType.TEXT],
    [53,  ColumnType.CLOB],    [57,  ColumnType.BLOB],
    [97,  ColumnType.BINARY],  [32,  ColumnType.IPV4],
    [36,  ColumnType.IPV6],    [61,  ColumnType.JSON],
  ]);

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
 * @property {number} length - M$SYS_COLUMNS.LENGTH (VARCHAR 가변 길이)
 */
class Column {
  constructor(name, columnType, id, category, length = 0) {
    this.name       = name;
    this.columnType = columnType;
    this.id         = id;
    this.category   = category;
    this.length     = length;
  }

  /** appendOpen 프로토콜 타입 문자열 */
  dataType() { return this.columnType.type; }

  /** append 패딩용 null 대체값 */
  safeNull() { return this.columnType.safeNull; }

  /**
   * CREATE TABLE DDL 타입 문자열 (예: 'VARCHAR(80)', 'DOUBLE')
   * @returns {string}
   */
  sqlType() {
    if (this.columnType.ddlType !== null) return this.columnType.ddlType;
    return `${this.columnType.type.toUpperCase()}(${this.length})`;
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
