'use strict';

// M$SYS_TABLES.TYPE 값
const TABLE_TYPE_LOG = 0;
const TABLE_TYPE_TAG = 6;

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
}

module.exports = CatalogClient;
