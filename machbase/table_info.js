'use strict';

const { ColumnType } = require('./machbase.js');

/**
 * 테이블 컬럼 정보 + alias map 통합 클래스
 *
 * TAG/LOG 테이블의 컬럼 구조를 분석하여:
 *   - dataColumns: SELECT에 사용할 데이터 컬럼 (TIME, VALUE, 추가 컬럼)
 *   - metadataColumns: append 시 safe null로 패딩할 metadata 컬럼
 *   - writeColumns: appendOpen용 전체 컬럼 순서 (NAME + data + metadata)
 *   - aliasMap: TAG _ID → canonical name 매핑
 */
class TableInfo {
  constructor(tableType, logicalTable) {
    this.tableType = tableType;       // 'TAG' | 'LOG'
    this.logicalTable = logicalTable;

    /** @type {Array<{name: string, columnType: ColumnType, id: number, category: string}>} */
    this.dataColumns = [];

    /** @type {Array<{name: string, columnType: ColumnType, id: number, category: string}>} */
    this.metadataColumns = [];

    /** @type {Array<{name: string, columnType: ColumnType, id: number, category: string}>} */
    this.writeColumns = [];

    /** @type {Map<bigint, string>} TAG alias: _ID → name */
    this.aliasMap = new Map();
  }

  // ── 팩토리 메서드 ──────────────────────────────────────────────────────────

  /**
   * TAG 테이블용 TableInfo 생성
   *
   * Step 1: _{table}_META 컬럼 조회 → metadata columns 추출
   * Step 2: _{table}_DATA_{dataTableId} 컬럼 조회 → data columns 추출
   * Step 3: writeColumns = [NAME(varchar)] + dataColumns + metadataColumns
   * Step 4: alias map 로드
   *
   * @param {MachbaseClient} conn
   * @param {string} logicalTable - 논리 테이블명 (예: 'TAG')
   * @param {number} dataTableId - 첫 번째 데이터 파티션의 table_id (M$SYS_TABLES.ID)
   * @returns {Promise<TableInfo>}
   */
  static async buildTag(conn, logicalTable, dataTableId) {
    const info = new TableInfo('TAG', logicalTable);
    const metaTableName = `_${logicalTable}_META`;

    // Step 1: META 컬럼 조회 → metadata columns 추출
    const metaSql = `
      SELECT c.NAME, c.TYPE, c.ID
      FROM M$SYS_COLUMNS c, M$SYS_TABLES t
      WHERE c.TABLE_ID = t.ID AND t.NAME = ?
        AND c.ID > 0 AND c.ID < 65534
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
      info.metadataColumns.push({
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
      // TYPE=112 (ulong) = primary key 내부 타입 (NAME의 DATA 파티션 표현) → 제외
      if (r.TYPE === 112) continue;
      info.dataColumns.push({
        name: r.NAME,
        columnType: ColumnType.fromCode(r.TYPE),
        id: r.ID,
        category: 'data',
      });
    }

    // Step 3: writeColumns = [NAME] + dataColumns + metadataColumns
    info.writeColumns = [
      { name: 'NAME', columnType: ColumnType.VARCHAR, id: 0, category: 'key' },
      ...info.dataColumns,
      ...info.metadataColumns,
    ];

    // Step 4: alias map 로드
    await info.loadAliases(conn);

    return info;
  }

  /**
   * LOG 테이블용 TableInfo 생성
   *
   * LOG는 META/metadata 없음.
   * 전체 컬럼 = dataColumns = writeColumns
   *
   * @param {MachbaseClient} conn
   * @param {string} logicalTable - 논리 테이블명 (예: 'LOG_TABLE')
   * @returns {Promise<TableInfo>}
   */
  static async buildLog(conn, logicalTable) {
    const info = new TableInfo('LOG', logicalTable);

    const sql = `
      SELECT c.NAME, c.TYPE, c.ID
      FROM M$SYS_COLUMNS c, M$SYS_TABLES t
      WHERE c.TABLE_ID = t.ID AND t.NAME = ?
        AND c.ID >= 0 AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim();
    const rows = await conn.query(sql, [logicalTable]);

    for (const r of (rows || [])) {
      info.dataColumns.push({
        name: r.NAME,
        columnType: ColumnType.fromCode(r.TYPE),
        id: r.ID,
        category: 'data',
      });
    }

    // LOG: 전체 컬럼 = dataColumns = writeColumns (metadata 없음)
    info.writeColumns = [...info.dataColumns];

    return info;
  }

  // ── alias 관련 (TAG 전용) ──────────────────────────────────────────────────

  /**
   * _TAG_META 전체 로드 → aliasMap 구성
   * @param {MachbaseClient} conn
   * @returns {Error|null}
   */
  async loadAliases(conn) {
    if (this.tableType !== 'TAG') return null;
    const sql = `SELECT _ID, name FROM _${this.logicalTable}_META`;
    try {
      const rows = await conn.query(sql);
      this.aliasMap.clear();
      for (const row of (rows || [])) {
        this.aliasMap.set(BigInt(row._ID), row.name);
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
  async resolveTagCanonical(conn, tagId, tagIdentifier) {
    const tagIdBig = BigInt(tagId);
    let tagName = this.aliasMap.get(tagIdBig);

    // 캐시 miss → DB 단건 조회
    if (tagName === undefined) {
      try {
        const sql = `SELECT name FROM _${this.logicalTable}_META WHERE _ID = ?`;
        const rows = await conn.query(sql, [tagId]);
        if (!rows || rows.length === 0) {
          return { canonical: null, status: 'drop_not_found' };
        }
        tagName = rows[0].name;
        this.aliasMap.set(tagIdBig, tagName);
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', stage: 'table_info', tag_id: String(tagId), msg: err.message }));
        return { canonical: null, status: 'retry_error' };
      }
    }

    const canonical = TableInfo._applyIdentifier(tagName, tagIdentifier);
    return { canonical, status: 'ok' };
  }

  static _applyIdentifier(tagName, tagIdentifier) {
    if (!tagIdentifier || tagIdentifier.mode === 'none') return tagName;
    if (tagIdentifier.mode === 'prefix') return (tagIdentifier.value || '') + tagName;
    if (tagIdentifier.mode === 'suffix') return tagName + (tagIdentifier.value || '');
    return tagName;
  }

  // ── 헬퍼 ──────────────────────────────────────────────────────────────────

  /**
   * Reader SELECT용 컬럼명 배열 반환 (lowercase)
   * TAG: data columns의 name (예: ['time', 'value', 'quality'])
   * LOG: 모든 columns의 name 중 name/_RID 제외
   * @returns {string[]}
   */
  getSelectColumnNames() {
    return this.dataColumns.map(c => c.name.toLowerCase());
  }
}

module.exports = TableInfo;
