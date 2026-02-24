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
  static async readAfterRid(conn, dataTable, startRid, limit = 1000) {
    // RID_RANGE 힌트는 반개방 구간 [startRid, endRid)
    // endRid = min(startRid + limit, MAX(_RID) + 1)
    //   - RID가 조밀한 경우: startRid + limit이 스캔 범위를 좁게 유지
    //   - RID가 희소한 경우: MAX(_RID) + 1이 상한선 역할 (실제 존재 범위를 벗어나지 않음)
    let endRid = startRid + BigInt(limit);
    try {
      const maxRows = await conn.query(`SELECT MAX(_RID) as max_rid FROM ${dataTable}`);
      const rawMax = maxRows?.[0]?.max_rid;
      if (rawMax !== null && rawMax !== undefined) {
        const maxRidPlusOne = BigInt(rawMax) + 1n;
        if (maxRidPlusOne < endRid) endRid = maxRidPlusOne;
      }
    } catch (e) {
      console.warn(JSON.stringify({ level: 'warn', stage: 'source_reader', msg: `MAX(_RID) query failed for ${dataTable}, using startRid+limit as endRid: ${e.message}` }));
    }
    if (endRid < startRid) endRid = startRid;
    // RID_RANGE 힌트는 SQL 파라미터화 불가 — 내부 시스템 값이므로 직접 보간
    const sql = `SELECT /*+ RID_RANGE(${dataTable}, ${startRid}, ${endRid}) */ _RID, name, time, value FROM ${dataTable} WHERE _RID >= ${startRid} LIMIT ${limit}`;
    try {
      const rows = await conn.query(sql);
      const result = [];
      for (const r of (rows || [])) {
        if (r._RID == null) {
          console.warn(JSON.stringify({ level: 'warn', stage: 'source_reader', msg: `row with null _RID skipped in ${dataTable}` }));
          continue;
        }
        result.push({
          rid: BigInt(r._RID),
          tagId: r.name,
          time: r.time,
          value: r.value,
        });
      }
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
