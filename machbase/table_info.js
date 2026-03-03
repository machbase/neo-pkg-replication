'use strict';

const { ColumnType } = require('./machbase.js');

// ─── TableSchema ─────────────────────────────────────────────────────────────

/**
 * 불변 테이블 컬럼 구조 정보
 *
 * TAG/LOG 테이블의 컬럼 구조를 분석하여:
 *   - dataColumns: SELECT에 사용할 데이터 컬럼 (TIME, VALUE, 추가 컬럼)
 *   - metadataColumns: append 시 safe null로 패딩할 metadata 컬럼
 *   - writeColumns: appendOpen용 전체 컬럼 순서 (NAME + data + metadata)
 *
 * alias 동적 상태는 TagAliasCache로 분리됨.
 */
class TableSchema {
  constructor(tableType, logicalTable) {
    this.tableType = tableType;       // 'TAG' | 'LOG'
    this.logicalTable = logicalTable;

    /** @type {Array<{name: string, columnType: ColumnType, id: number, category: string}>} */
    this.dataColumns = [];

    /** @type {Array<{name: string, columnType: ColumnType, id: number, category: string}>} */
    this.metadataColumns = [];

    /** @type {Array<{name: string, columnType: ColumnType, id: number, category: string}>} */
    this.writeColumns = [];
  }

  // ── 팩토리 메서드 ──────────────────────────────────────────────────────────

  /**
   * TAG 테이블용 TableSchema 생성
   *
   * Step 1: _{table}_META 컬럼 조회 → metadata columns 추출
   * Step 2: _{table}_DATA_{dataTableId} 컬럼 조회 → data columns 추출
   * Step 3: writeColumns = [NAME(varchar)] + dataColumns + metadataColumns
   *
   * alias map 로드는 포함하지 않음 — TagAliasCache 책임.
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
    let nameSkipped = false;
    for (const r of (metaRows || [])) {
      if (r.NAME.startsWith('_')) continue;
      if (!nameSkipped) {
        nameSkipped = true; // 첫 번째 user 컬럼(NAME) skip
        continue;
      }
      schema.metadataColumns.push({
        name: r.NAME,
        columnType: ColumnType.fromCode(r.TYPE),
        id: r.ID,
        category: 'metadata',
      });
    }

    // Step 2: DATA 파티션 컬럼 조회 → data columns 추출
    const dataSql = `
      SELECT c.NAME, c.TYPE, c.ID
      FROM M$SYS_COLUMNS c
      WHERE c.TABLE_ID = ? AND c.ID > 0 AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim();
    const dataRows = await conn.query(dataSql, [dataTableId]);

    for (const r of (dataRows || [])) {
      if (r.NAME.startsWith('_')) continue;
      // DATA 파티션에서 NAME 컬럼은 ulong(112) 타입의 tag_id 내부 표현 → 제외
      // 컬럼명 기반으로 제외하여 타입 코드 의존을 제거
      if (r.NAME.toLowerCase() === 'name') continue;
      schema.dataColumns.push({
        name: r.NAME,
        columnType: ColumnType.fromCode(r.TYPE),
        id: r.ID,
        category: 'data',
      });
    }

    // Step 3: dataColumns 빈 배열 검증 — Worker 시작 전에 오류를 조기 발견
    if (schema.dataColumns.length === 0) {
      throw new Error(`buildTag: no data columns found for table '${logicalTable}' (dataTableId=${dataTableId})`);
    }

    // writeColumns = [NAME] + dataColumns + metadataColumns
    schema.writeColumns = [
      { name: 'NAME', columnType: ColumnType.VARCHAR, id: 0, category: 'key' },
      ...schema.dataColumns,
      ...schema.metadataColumns,
    ];

    return schema;
  }

  /**
   * LOG 테이블용 TableSchema 생성
   *
   * LOG는 META/metadata 없음.
   * 전체 컬럼 = dataColumns = writeColumns
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
      schema.dataColumns.push({
        name: r.NAME,
        columnType: ColumnType.fromCode(r.TYPE),
        id: r.ID,
        category: 'data',
      });
    }

    // LOG: 전체 컬럼 = dataColumns = writeColumns (metadata 없음)
    schema.writeColumns = [...schema.dataColumns];

    return schema;
  }

  // ── 헬퍼 ──────────────────────────────────────────────────────────────────

  /**
   * Reader SELECT용 추가 컬럼명 배열 반환 (lowercase)
   *
   * Reader.readAfterRid()에서 _RID와 name은 항상 별도로 추가하므로,
   * 이 메서드는 그 외의 데이터 컬럼만 반환한다.
   * TAG: dataColumns = [TIME, VALUE, ...] (NAME은 buildTag에서 이미 제외됨)
   * LOG: dataColumns = 전체 컬럼 (Reader에서 name 중복 필터링 처리)
   *
   * @returns {string[]} lowercase 컬럼명 배열
   */
  getSelectColumnNames() {
    return this.dataColumns.map(c => c.name.toLowerCase());
  }
}

// ─── TagAliasCache ────────────────────────────────────────────────────────────

/**
 * TAG alias 동적 상태 전담 클래스
 *
 * tag_id (_ID) → canonical name 변환을 Read-through cache로 관리.
 * TableSchema가 불변인 반면, TagAliasCache는 실행 중에 항목이 추가될 수 있다.
 *
 * Worker별로 독립 인스턴스를 생성해 상태 격리를 보장한다.
 */
class TagAliasCache {
  constructor(logicalTable) {
    this.logicalTable = logicalTable;
    /** @type {Map<bigint, string>} TAG alias: _ID → name */
    this._map = new Map();
  }

  /** 현재 캐시 항목 수 */
  get size() { return this._map.size; }

  /**
   * _TAG_META 전체 로드 → aliasMap 구성
   *
   * 주의: META 테이블을 full scan 한다. TAG가 수십만 개인 대규모 환경에서는
   * Worker 시작 시 지연이 발생할 수 있음. 현재는 Worker당 1회 호출이므로 실용상 문제없음.
   *
   * @param {MachbaseClient} conn
   * @returns {Error|null}
   */
  async load(conn) {
    const sql = `SELECT _ID, name FROM _${this.logicalTable}_META`;
    try {
      const rows = await conn.query(sql);
      this._map.clear();
      for (const row of (rows || [])) {
        this._map.set(BigInt(row._ID), row.name);
      }
      return null;
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'table_info', msg: `loadAliases failed: ${err.message}` }));
      return err;
    }
  }

  /**
   * tag_id → canonical 태그명 변환 (Read-through cache)
   * @param {MachbaseClient} conn
   * @param {number|bigint} tagId
   * @param {{ mode: 'prefix'|'suffix'|'none', value?: string }|null} tagIdentifier
   * @returns {{ canonical: string|null, status: 'ok'|'drop_not_found'|'retry_error' }}
   */
  async resolve(conn, tagId, tagIdentifier) {
    const tagIdBig = BigInt(tagId);
    let tagName = this._map.get(tagIdBig);

    // 캐시 miss → DB 단건 조회
    if (tagName === undefined) {
      try {
        const sql = `SELECT name FROM _${this.logicalTable}_META WHERE _ID = ?`;
        const rows = await conn.query(sql, [tagId]);
        if (!rows || rows.length === 0) {
          return { canonical: null, status: 'drop_not_found' };
        }
        tagName = rows[0].name;
        this._map.set(tagIdBig, tagName);
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', stage: 'table_info', tag_id: String(tagId), msg: err.message }));
        return { canonical: null, status: 'retry_error' };
      }
    }

    const canonical = TagAliasCache._applyIdentifier(tagName, tagIdentifier);
    return { canonical, status: 'ok' };
  }

  static _applyIdentifier(tagName, tagIdentifier) {
    if (!tagIdentifier || tagIdentifier.mode === 'none') return tagName;
    if (tagIdentifier.mode === 'prefix') return (tagIdentifier.value || '') + tagName;
    if (tagIdentifier.mode === 'suffix') return tagName + (tagIdentifier.value || '');
    return tagName;
  }
}

module.exports = { TableSchema, TagAliasCache };
