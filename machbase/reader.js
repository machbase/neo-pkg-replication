'use strict';

class Reader {
  /**
   * @param {TableInfo} tableInfo - srcTableInfo (owned)
   * @param {MachbaseClient} conn - 소스 DB 연결
   * @param {string} dataTable - 파티션 테이블명 (예: _TAG_DATA_0)
   */
  constructor(tableInfo, conn, dataTable) {
    this.tableInfo = tableInfo;
    this.conn = conn;
    this.dataTable = dataTable;
  }

  /**
   * 연결 교체 (statement ID 고갈 시)
   * @param {MachbaseClient} newConn
   */
  replaceConnection(newConn) { this.conn = newConn; }

  // ── TableInfo 위임 ──────────────────────────────────────────────────────────

  get aliasMap() { return this.tableInfo.aliasMap; }

  async loadAliases(conn) { return this.tableInfo.loadAliases(conn || this.conn); }

  async resolveTagCanonical(conn, tagId, tagIdentifier) {
    return this.tableInfo.resolveTagCanonical(conn || this.conn, tagId, tagIdentifier);
  }

  // ── 인스턴스 메서드 ─────────────────────────────────────────────────────────

  /**
   * RID 범위 기반 데이터 읽기
   * @param {BigInt} startRid
   * @param {number} limit - 반환할 최대 행 수 (SQL LIMIT)
   * @param {number} rangeSize - RID_RANGE 힌트 스캔 범위 크기
   * @returns {{ rows: Array<{ rid: BigInt, tagId: any, data: object }>, err: Error|null }}
   */
  async readAfterRid(startRid, limit = 1000, rangeSize = 50000) {
    const columnNames = this.tableInfo.getSelectColumnNames();
    const conn = this.conn;
    const dataTable = this.dataTable;

    // SELECT할 추가 컬럼 결정 (name과 _RID는 항상 포함)
    const extraCols = columnNames && columnNames.length > 0
      ? columnNames.filter(c => c.toLowerCase() !== 'name')
      : ['time', 'value'];

    // RID_RANGE 힌트는 반개방 구간 [startRid, endRid)
    let endRid = startRid + BigInt(rangeSize);
    try {
      const maxRows = await conn.query(`SELECT MAX(_RID) as max_rid FROM ${dataTable}`);
      const rawMax = maxRows?.[0]?.max_rid;
      if (rawMax !== null && rawMax !== undefined) {
        const maxRidPlusOne = BigInt(rawMax) + 1n;
        if (maxRidPlusOne < endRid) endRid = maxRidPlusOne;
      }
    } catch (e) {
      console.warn(JSON.stringify({ level: 'warn', stage: 'reader', msg: `MAX(_RID) query failed for ${dataTable}, using startRid+limit as endRid: ${e.message}` }));
    }
    if (endRid < startRid) endRid = startRid;

    const colList = ['_RID', 'name', ...extraCols].join(', ');
    const sql = `SELECT /*+ RID_RANGE(${dataTable}, ${startRid}, ${endRid}) */ ${colList} FROM ${dataTable} WHERE _RID >= ${startRid} LIMIT ${limit}`;
    try {
      const rows = await conn.query(sql);
      const result = [];
      for (const row of (rows || [])) {
        if (row._RID == null) {
          console.warn(JSON.stringify({ level: 'warn', stage: 'reader', msg: `row with null _RID skipped in ${dataTable}` }));
          continue;
        }
        // data에 name/_RID 제외한 나머지 컬럼을 UPPERCASE key로 저장
        const data = {};
        for (const col of extraCols) {
          data[col.toUpperCase()] = row[col];
        }
        result.push({
          rid: BigInt(row._RID),
          tagId: row.name,
          data,
        });
      }
      return { rows: result, err: null };
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'reader', data_table: dataTable, msg: err.message }));
      return { rows: [], err };
    }
  }

  // ── static 메서드 (tableInfo 불필요) ────────────────────────────────────────

  /**
   * 파티션의 최대 RID 조회
   * @param {MachbaseClient} conn
   * @param {string} dataTable
   * @returns {{ maxRid: BigInt, err: Error|null }}
   */
  static async getMaxRid(conn, dataTable) {
    const sql = `SELECT MAX(_RID) as max_rid FROM ${dataTable}`;
    try {
      const rows = await conn.query(sql);
      const raw = rows?.[0]?.max_rid;
      // 빈 테이블: MAX() → null
      if (raw === null || raw === undefined) return { maxRid: 0n, err: null };
      return { maxRid: BigInt(raw), err: null };
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'reader', data_table: dataTable, msg: `getMaxRid failed: ${err.message}` }));
      return { maxRid: 0n, err };
    }
  }
}

module.exports = Reader;
