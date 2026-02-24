'use strict';

const { columntypeof } = require('./machbase.js');

class TargetWriter {
  constructor() {
    this.stream = null;
    /** @type {Array<{ name: string, type: string }>} */
    this.writeColumns = [];
    /** @type {Array<string>} 대상 컬럼명 순서 */
    this.targetColumnNames = [];
    /** @type {Set<string>} 원본에도 있는 컬럼명 */
    this.sourceColumnSet = new Set();
  }

  /**
   * appendOpen 스트림 초기화 (mapping 시작 시 1회 호출)
   * @param {MachbaseClient} conn - target MachbaseClient
   * @param {string} table - 대상 논리 테이블명
   * @param {Array<{ name: string, type: number }>} sourceColumns - 원본 컬럼 목록
   * @returns {Error|null}
   */
  async open(conn, table, sourceColumns) {
    try {
      // 1. 대상 테이블 컬럼 조회
      const sql = `
        SELECT c.NAME, c.TYPE
        FROM M$SYS_COLUMNS c, M$SYS_TABLES t
        WHERE c.TABLE_ID = t.ID AND t.NAME = ?
          AND c.ID >= 0 AND c.ID < 65534
        ORDER BY c.ID ASC
      `.trim();
      const rows = await conn.query(sql, [table]);
      const targetColumns = (rows || []).map(r => ({ name: r.NAME, type: r.TYPE }));

      // 2. 원본 컬럼명 Set 구성
      const srcNames = new Set((sourceColumns || []).map(c => c.name));
      this.sourceColumnSet = srcNames;

      // 3. 대상 컬럼 기준으로 writeColumns 구성
      //    - 원본에 있는 컬럼 → 그대로 포함
      //    - 원본에 없는 컬럼 → null 패딩 대상으로 포함
      this.writeColumns = targetColumns.map(c => ({
        name: c.name,
        type: columntypeof(c.type),
      }));
      this.targetColumnNames = targetColumns.map(c => c.name);

      // 4. appendOpen — conn.conn이 실제 @machbase/ts-client connection
      this.stream = await conn.conn.appendOpen(table, this.writeColumns);
      console.debug(JSON.stringify({ level: 'debug', stage: 'target_writer', table, msg: `appendOpen: ${this.writeColumns.length} columns` }));
      return null;
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'target_writer', table, msg: `open failed: ${err.message}` }));
      return err;
    }
  }

  /**
   * 배치 데이터 append (mapping의 모든 Worker가 공유)
   * @param {Array<object>} rows - { tagId, time, value, ... } 형태 또는 컬럼명 기준 객체
   * @returns {Error|null}
   */
  async append(rows) {
    if (!rows || rows.length === 0) return null;
    try {
      // rows를 대상 컬럼 순서에 맞는 2차원 배열로 변환
      // 원본에 없는 컬럼 → null 패딩
      const matrix = rows.map(row => {
        if (Array.isArray(row)) return row; // 이미 배열 형태면 그대로
        return this.writeColumns.map(col => {
          if (!this.sourceColumnSet.has(col.name)) return null; // null 패딩
          const val = row[col.name];
          if (val === null || val === undefined) return null;
          // int64 컬럼은 BigInt로 변환 (문자열/number → BigInt)
          if (col.type === 'int64') return BigInt(val);
          return val;
        });
      });
      await this.stream.append(matrix);
      return null;
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'target_writer', msg: `append failed: ${err.message}` }));
      return err;
    }
  }

  /**
   * 스트림 닫기
   * @returns {Error|null}
   */
  async close() {
    if (!this.stream) return null;
    try {
      await this.stream.close();
      console.debug(JSON.stringify({ level: 'debug', stage: 'target_writer', msg: 'stream closed' }));
      return null;
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'target_writer', msg: `close failed: ${err.message}` }));
      return err;
    }
  }
}

module.exports = TargetWriter;
