'use strict';

const { getInstance: getLogger } = require('../logger/logger.js');

/**
 * 대상 테이블에서 tag + time 기준 row 존재 여부 확인
 * STARTUP_INTEGRITY 단계에서만 사용
 *
 * @machbase/ts-client는 client.query() 호출마다 서버 statement ID를 소비하며
 * 서버는 clientection당 1024개 한도를 가진다.
 * 이를 피하기 위해 배치 단위로 일괄 조회한다.
 */
class IntegrityChecker {
  /**
   * 배치 존재 여부 확인
   * rows: Array<{ canonical: string, time: bigint|string }>
   * 반환: { existSet: Set<string>, err: Error|null }
   *   existSet: "canonical\x00time" 형태의 key Set (존재하는 행만 포함)
   */
  static async batchExists(client, table, rows) {
    if (!rows || rows.length === 0) return { existSet: new Set(), err: null };

    if (rows.length > 500) {
      throw new Error(`batchExists called with ${rows.length} rows (>500). Caller must limit batch size to 500.`);
    }

    // UNION ALL 방식으로 일괄 조회
    // SELECT name, time FROM table WHERE (name='...' AND time=...) OR ...
    // Machbase는 OR 조건을 지원하므로 하나의 쿼리로 처리
    const conditions = rows.map(r => {
      if (r.canonical == null) {
        throw new Error(`batchExists: row has null/undefined canonical (time="${r.time}")`);
      }
      if (r.time === null || r.time === undefined) {
        throw new Error(`batchExists: row has null/undefined time (canonical="${r.canonical}")`);
      }
      // SQL 싱글쿼트 이스케이프: Machbase SQL 파서는 '' 을 리터럴 ' 로 해석 (ANSI SQL 표준)
      const safeTag = String(r.canonical).replace(/'/g, "''");
      const safeTime = BigInt(r.time);
      return `(name = '${safeTag}' AND time = ${safeTime})`;
    });
    const sql = `SELECT name, time FROM ${table} WHERE ${conditions.join(' OR ')}`;
    try {
      const result = await client.query(sql);
      const existSet = new Set();
      for (const row of (result || [])) {
        existSet.add(`${row.name}\x00${BigInt(row.time)}`);
      }
      return { existSet, err: null };
    } catch (err) {
      getLogger().error('integrity_checker', { table, msg: err.message });
      return { existSet: new Set(), err };
    }
  }

  /**
   * batchExists의 key 생성 헬퍼
   */
  static existKey(canonical, timeNs) {
    // separator \x00은 canonical에 포함되지 않아야 키 충돌이 없음
    if (canonical.includes('\x00')) {
      throw new Error(`canonical contains null byte: ${JSON.stringify(canonical)}`);
    }
    return `${canonical}\x00${BigInt(timeNs)}`;
  }
}

module.exports = IntegrityChecker;
