'use strict';

class SourceReader {
  /**
   * RID 범위 기반 데이터 읽기
   * @param {MachbaseClient} conn
   * @param {string} dataTable - 파티션 테이블명 (예: _TAG_DATA_0)
   * @param {BigInt} startRid
   * @param {number} limit
   * @returns {{ rows: Array<{ rid: BigInt, tagId: any, time: any, value: any }>, err: Error|null }}
   */
  static async readAfterRid(conn, dataTable, startRid, limit) {
    // RID_RANGE endRid: 현재 파티션의 최대 RID를 조회하여 스캔 범위 확보
    // 빈 테이블이면 endRid = startRid로 설정 (결과 0건)
    let endRid;
    try {
      const maxRows = await conn.query(`SELECT MAX(_RID) as max_rid FROM ${dataTable}`);
      const rawMax = maxRows?.[0]?.max_rid;
      endRid = (rawMax !== null && rawMax !== undefined) ? BigInt(rawMax) : startRid;
    } catch (_) {
      endRid = startRid + BigInt(limit) * 10n;
    }
    if (endRid < startRid) endRid = startRid;
    // RID_RANGE 힌트는 SQL 파라미터화 불가 — 내부 시스템 값이므로 직접 보간
    const sql = `SELECT /*+ RID_RANGE(${dataTable}, ${startRid}, ${endRid}) */ _RID, name, time, value FROM ${dataTable} WHERE _RID >= ${startRid} LIMIT ${limit}`;
    try {
      const rows = await conn.query(sql);
      const result = (rows || []).map(r => ({
        rid: BigInt(r._RID),
        tagId: r.name,
        time: r.time,
        value: r.value,
      }));
      return { rows: result, err: null };
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'source_reader', data_table: dataTable, msg: err.message }));
      return { rows: [], err };
    }
  }

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
      console.error(JSON.stringify({ level: 'error', stage: 'source_reader', data_table: dataTable, msg: `getMaxRid failed: ${err.message}` }));
      return { maxRid: 0n, err };
    }
  }
}

module.exports = SourceReader;
