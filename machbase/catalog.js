'use strict';

// M$SYS_TABLES.TYPE 값
const TABLE_TYPE_LOG = 0;
const TABLE_TYPE_TAG = 6;

// integer 계열 타입 코드 (TAG 컬럼 첫 번째: tag_id 여야 함)
const INTEGER_TYPE_CODES = new Set([4, 104, 8, 108, 12, 112]);
// int64 계열 타입 코드 (TAG 컬럼 두 번째: time 이어야 함 — long=12, datetime=6 포함)
const TIME_TYPE_CODES = new Set([12, 6]);

class CatalogClient {
  /**
   * 논리 테이블 타입 조회
   * @returns {{ type: 'TAG'|'LOG'|'UNSUPPORTED' }}
   */
  static async getLogicalTableType(conn, table) {
    try {
      const rows = await conn.query(
        'SELECT TYPE FROM M$SYS_TABLES WHERE NAME = ?',
        [table]
      );
      if (!rows || rows.length === 0) return { type: 'UNSUPPORTED' };
      const typeCode = rows[0].TYPE;
      if (typeCode === TABLE_TYPE_TAG) return { type: 'TAG' };
      if (typeCode === TABLE_TYPE_LOG) return { type: 'LOG' };
      return { type: 'UNSUPPORTED' };
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'catalog', table, msg: `getLogicalTableType DB error: ${err.message}` }));
      return { type: 'UNSUPPORTED' };
    }
  }

  /**
   * TAG 테이블의 data 파티션 목록 조회
   * @returns {Array<{ data_table: string, table_id: number }>}
   */
  static async listTagDataTables(conn, logicalTable) {
    const pattern = `_${logicalTable}_DATA_%`;
    const sql = `
      SELECT m.NAME AS data_table, m.ID AS table_id
      FROM V$STORAGE_TAG_TABLES v, M$SYS_TABLES m
      WHERE v.ID = m.ID AND m.NAME LIKE ?
      ORDER BY m.NAME
    `.trim();
    const rows = await conn.query(sql, [pattern]);
    return (rows || []).map(r => ({ data_table: r.data_table, table_id: Number(r.table_id) }));
  }

  /**
   * 테이블 컬럼 정보 조회
   * @returns {Array<{ name: string, type: number, id: number }>}
   */
  static async getColumns(conn, tableId) {
    const sql = `
      SELECT c.NAME, c.TYPE, c.ID
      FROM M$SYS_COLUMNS c
      WHERE c.TABLE_ID = ? AND c.ID >= 1 AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim();
    const rows = await conn.query(sql, [tableId]);
    return (rows || []).map(r => ({ name: r.NAME, type: r.TYPE, id: r.ID }));
  }

  /**
   * TAG 테이블 컬럼 규칙 검증
   * - 1번째 컬럼: integer 계열 (tag_id)
   * - 2번째 컬럼: int64 (time)
   * @param {Array<{ name: string, type: number }>} columns
   * @returns {boolean}
   */
  static validateTagColumns(columns) {
    if (!columns || columns.length < 2) return false;
    const firstType = columns[0].type;
    const secondType = columns[1].type;
    if (!INTEGER_TYPE_CODES.has(firstType)) {
      console.error(JSON.stringify({ level: 'error', stage: 'catalog', msg: `TAG column[0] must be integer type, got ${firstType}` }));
      return false;
    }
    if (!TIME_TYPE_CODES.has(secondType)) {
      console.error(JSON.stringify({ level: 'error', stage: 'catalog', msg: `TAG column[1] must be time type (type=12 or 6), got ${secondType}` }));
      return false;
    }
    return true;
  }

}

module.exports = CatalogClient;
