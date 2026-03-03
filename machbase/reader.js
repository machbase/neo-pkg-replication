'use strict';

const { MachbaseClient } = require('./machbase.js');

class Reader {
  /**
   * @param {TableSchema} schema - srcTableSchema (불변 컬럼 구조, owned)
   * @param {TagAliasCache|null} aliasCache - TAG alias 캐시 (TAG 전용, owned), LOG는 null
   * @param {MachbaseClient} conn - 소스 DB 연결 (owned)
   * @param {string} dataTable - 파티션 테이블명 (예: _TAG_DATA_0)
   */
  constructor(schema, aliasCache, conn, dataTable) {
    if (!/^[A-Za-z0-9_]+$/.test(dataTable)) {
      throw new Error(`Reader: invalid dataTable name '${dataTable}' (must match /^[A-Za-z0-9_]+$/)`);
    }
    this.schema = schema;
    this.aliasCache = aliasCache;
    this.conn = conn;
    this.dataTable = dataTable;
  }

  /**
   * 소유한 연결 닫기
   */
  async close() {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
  }

  /**
   * 연결 재생성 (statement ID 고갈 시)
   * @param {object} config - MachbaseClient 접속 설정
   */
  async refreshConnection(config) {
    const newConn = new MachbaseClient(config);
    await newConn.connect();
    if (this.conn) await this.conn.close().catch(() => {});
    this.conn = newConn;
  }

  // ── TagAliasCache 위임 ──────────────────────────────────────────────────────

  /** 현재 캐시 항목 수 (TAG 전용; LOG는 항상 0) */
  get aliasSize() { return this.aliasCache ? this.aliasCache.size : 0; }

  async loadAliases() {
    if (!this.aliasCache) return null;
    return this.aliasCache.load(this.conn);
  }

  async resolveTagCanonical(tagId, tagIdentifier) {
    return this.aliasCache.resolve(this.conn, tagId, tagIdentifier);
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
    const columnNames = this.schema.getSelectColumnNames();
    const conn = this.conn;
    const dataTable = this.dataTable;

    // SELECT할 추가 컬럼 결정 (name과 _RID는 colList에서 항상 별도 추가)
    // getSelectColumnNames()는 TAG의 경우 name을 포함하지 않지만,
    // LOG의 경우 포함할 수 있으므로 여기서 중복 방지를 위해 filter 처리
    if (!columnNames || columnNames.length === 0) {
      return { rows: [], err: new Error('readAfterRid: schema has no columns') };
    }
    const extraCols = columnNames.filter(c => c.toLowerCase() !== 'name');

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
      // MAX(_RID) 실패 시 startRid + rangeSize를 폴백으로 사용.
      // 일시적 오류라면 다음 배치에서 복구되고, RID_RANGE 힌트가 실제 범위를 초과해도
      // WHERE _RID >= startRid 조건으로 안전하게 빈 결과가 반환되므로 무한 루프 위험은 없음.
      console.warn(JSON.stringify({ level: 'warn', stage: 'reader', msg: `MAX(_RID) query failed for ${dataTable}, using startRid+rangeSize as endRid: ${e.message}` }));
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
        // Machbase query()는 컬럼명을 소문자로 반환하므로 toUpperCase()로 변환
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

  /**
   * 파티션의 최대 RID 조회 (인스턴스 메서드)
   * @returns {{ maxRid: BigInt|null, err: Error|null }}
   *   - 정상: { maxRid: BigInt, err: null } (빈 테이블이면 maxRid = 0n)
   *   - 오류: { maxRid: null, err: Error }
   */
  async getMaxRid() {
    const sql = `SELECT MAX(_RID) as max_rid FROM ${this.dataTable}`;
    try {
      const rows = await this.conn.query(sql);
      const raw = rows?.[0]?.max_rid;
      // 빈 테이블: MAX() → null
      if (raw === null || raw === undefined) return { maxRid: 0n, err: null };
      return { maxRid: BigInt(raw), err: null };
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'reader', data_table: this.dataTable, msg: `getMaxRid failed: ${err.message}` }));
      return { maxRid: null, err };
    }
  }
}

module.exports = Reader;
