'use strict';

/**
 * 대상 테이블에서 tag + time 기준 row 존재 여부 확인
 * STARTUP_INTEGRITY 단계에서만 사용
 *
 * @machbase/ts-client는 conn.query() 호출마다 서버 statement ID를 소비하며
 * 서버는 connection당 1024개 한도를 가진다.
 * 이를 피하기 위해 배치 단위로 일괄 조회한다.
 */
class IntegrityChecker {
  /**
   * 단건 존재 여부 확인 (태그명 + 시각)
   * 단순 이스케이프로 SQL 인젝션 방지:
   *   - canonicalTag: 작은따옴표 → '' (Machbase SQL 표준)
   *   - timeNs: BigInt 정수값 직접 보간
   */
  static async existsByTagAndTime(conn, table, canonicalTag, timeNs) {
    const safeTag = String(canonicalTag).replace(/'/g, "''");
    const safeTime = BigInt(timeNs);
    const sql = `SELECT 1 FROM ${table} WHERE name = '${safeTag}' AND time = ${safeTime} LIMIT 1`;
    try {
      const rows = await conn.query(sql);
      return { exists: (rows && rows.length > 0), err: null };
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'integrity_checker', table, msg: err.message }));
      return { exists: false, err };
    }
  }

  /**
   * 배치 존재 여부 확인
   * rows: Array<{ canonical: string, time: bigint|string }>
   * 반환: { existSet: Set<string>, err: Error|null }
   *   existSet: "canonical\x00time" 형태의 key Set (존재하는 행만 포함)
   */
  static async batchExists(conn, table, rows) {
    if (!rows || rows.length === 0) return { existSet: new Set(), err: null };

    // UNION ALL 방식으로 일괄 조회
    // SELECT name, time FROM table WHERE (name='...' AND time=...) OR ...
    // Machbase는 OR 조건을 지원하므로 하나의 쿼리로 처리
    const conditions = rows.map(r => {
      const safeTag = String(r.canonical).replace(/'/g, "''");
      const safeTime = BigInt(r.time);
      return `(name = '${safeTag}' AND time = ${safeTime})`;
    });
    const sql = `SELECT name, time FROM ${table} WHERE ${conditions.join(' OR ')}`;
    try {
      const result = await conn.query(sql);
      const existSet = new Set();
      for (const row of (result || [])) {
        existSet.add(`${row.name}\x00${BigInt(row.time)}`);
      }
      return { existSet, err: null };
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'integrity_checker', table, msg: err.message }));
      return { existSet: new Set(), err };
    }
  }

  /**
   * batchExists의 key 생성 헬퍼
   */
  static existKey(canonical, timeNs) {
    return `${canonical}\x00${BigInt(timeNs)}`;
  }
}

module.exports = IntegrityChecker;
