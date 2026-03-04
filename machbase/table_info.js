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
 * TAG/LOG 테이블의 컬럼 구조를 분석하여:
 *   - columns: appendOpen용 전체 컬럼 순서 (NAME + data + metadata)
 */
class TableSchema {
  constructor(tableType, logicalTable) {
    this.tableType = tableType;       // 'TAG' | 'LOG'
    this.logicalTable = logicalTable;

    /** @type {Column[]} */
    this.columns = [];
  }

  // ── 팩토리 메서드 ──────────────────────────────────────────────────────────

  /**
   * TAG 테이블용 TableSchema 생성
   *
   * Step 1: _{table}_META 컬럼 조회 → metadata columns 추출
   * Step 2: _{table}_DATA_{dataTableId} 컬럼 조회 → data columns 추출
   * Step 3: columns = [NAME(varchar)] + dataColumns + metadataColumns
   *
   * @param {MachbaseClient} conn
   * @param {string} logicalTable - 논리 테이블명 (예: 'TAG')
   * @param {number} dataTableId - 첫 번째 데이터 파티션의 table_id (M$SYS_TABLES.ID)
   * @returns {Promise<TableSchema>}
   */
  static async buildTag(conn, logicalTable, dataTableId) {
    const schema = new TableSchema('TAG', logicalTable);
    const metaTableName = `_${logicalTable}_META`;

    // Step 1: META 컬럼 조회 → metadata columns 추출
    // c.ID < 65534: 시스템 예약 컬럼 제외. _prefix 컬럼은 JS 레벨에서 필터링.
    const metaSql = `
      SELECT c.NAME, c.TYPE, c.ID
      FROM M$SYS_COLUMNS c, M$SYS_TABLES t
      WHERE c.TABLE_ID = t.ID AND t.NAME = ?
        AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim();
    const metaRows = await conn.query(metaSql, [metaTableName]);

    // META 컬럼 중:
    //   - _ prefix 컬럼 제외 (시스템 컬럼: _ID 등)
    //   - 첫 번째 user 컬럼 = NAME (varchar, tag 이름) → 제외
    //   - 나머지 = metadata columns
    const metadataColumns = [];
    let nameSkipped = false;
    for (const r of (metaRows || [])) {
      if (r.NAME.startsWith('_')) continue;
      if (!nameSkipped) {
        nameSkipped = true; // 첫 번째 user 컬럼(NAME) skip
        continue;
      }
      metadataColumns.push(new Column(r.NAME, ColumnType.fromCode(r.TYPE), r.ID, 'metadata'));
    }

    // Step 2: DATA 파티션 컬럼 조회 → data columns 추출
    const dataSql = `
      SELECT c.NAME, c.TYPE, c.ID
      FROM M$SYS_COLUMNS c
      WHERE c.TABLE_ID = ? AND c.ID > 0 AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim();
    const dataRows = await conn.query(dataSql, [dataTableId]);

    const dataColumns = [];
    for (const r of (dataRows || [])) {
      if (r.NAME.startsWith('_')) continue;
      // DATA 파티션의 NAME 컬럼은 내부적으로 tag_id(ulong)이지만
      // 논리적으로는 VARCHAR 문자열이므로 타입을 VARCHAR로 오버라이드
      const columnType = r.NAME.toLowerCase() === 'name'
        ? ColumnType.VARCHAR
        : ColumnType.fromCode(r.TYPE);
      const category = r.NAME.toLowerCase() === 'name' ? 'key' : 'data';
      dataColumns.push(new Column(r.NAME, columnType, r.ID, category));
    }

    // Step 3: dataColumns 빈 배열 검증 — Worker 시작 전에 오류를 조기 발견
    if (dataColumns.length === 0) {
      throw new Error(`buildTag: no data columns found for table '${logicalTable}' (dataTableId=${dataTableId})`);
    }

    // columns = dataColumns(NAME 포함) + metadataColumns
    schema.columns = [...dataColumns, ...metadataColumns];

    return schema;
  }

  /**
   * LOG 테이블용 TableSchema 생성
   *
   * LOG는 META/metadata 없음.
   * 전체 컬럼 = columns
   *
   * @param {MachbaseClient} conn
   * @param {string} logicalTable - 논리 테이블명 (예: 'LOG_TABLE')
   * @returns {Promise<TableSchema>}
   */
  static async buildLog(conn, logicalTable) {
    const schema = new TableSchema('LOG', logicalTable);

    const sql = `
      SELECT c.NAME, c.TYPE, c.ID
      FROM M$SYS_COLUMNS c, M$SYS_TABLES t
      WHERE c.TABLE_ID = t.ID AND t.NAME = ?
        AND c.ID >= 0 AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim();
    const rows = await conn.query(sql, [logicalTable]);

    for (const r of (rows || [])) {
      schema.columns.push(new Column(r.NAME, ColumnType.fromCode(r.TYPE), r.ID, 'data'));
    }

    return schema;
  }

}

module.exports = { ColumnType, Column, TableSchema };
