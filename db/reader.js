'use strict';

const { getInstance: getLogger } = require('../logger/logger.js');

const { MachbaseClient } = require('./client.js');
// ─── TagAliasCache ────────────────────────────────────────────────────────────

/**
 * TAG alias 동적 상태 전담 클래스
 *
 * tag_id (_ID) → canonical name 변환을 Read-through cache로 관리.
 * TableSchema가 불변인 반면, TagAliasCache는 실행 중에 항목이 추가될 수 있다.
 *
 * Worker별로 독립 인스턴스를 생성해 상태 격리를 보장한다.
 */
class TagAliasCache {
  constructor(logicalTable) {
    this.logicalTable = logicalTable;
    /** @type {Map<bigint, string>} TAG alias: _ID → name */
    this._map = new Map();
  }

  /** 현재 캐시 항목 수 */
  get size() { return this._map.size; }

  /**
   * _TAG_META 전체 로드 → aliasMap 구성
   *
   * 주의: META 테이블을 full scan 한다. TAG가 수십만 개인 대규모 환경에서는
   * Worker 시작 시 지연이 발생할 수 있음. 현재는 Worker당 1회 호출이므로 실용상 문제없음.
   *
   * @param {MachbaseClient} client
   * @returns {Error|null}
   */
  async load(client) {
    const sql = `SELECT _ID, name FROM _${this.logicalTable}_META`;
    try {
      const rows = await client.query(sql);
      this._map.clear();
      for (const row of (rows || [])) {
        this._map.set(BigInt(row._ID), row.name);
      }
      return null;
    } catch (err) {
      getLogger().error('reader', { msg: `loadAliases failed: ${err.message}` });
      return err;
    }
  }

  /**
   * tag_id → canonical 태그명 변환 (Read-through cache)
   * @param {MachbaseClient} client
   * @param {number|bigint} tagId
   * @param {{ mode: 'prefix'|'suffix'|'none', value?: string }|null} tagIdentifier
   * @returns {{ canonical: string|null, status: 'ok'|'drop_not_found'|'retry_error' }}
   */
  async resolve(client, tagId, tagIdentifier) {
    const tagIdBig = BigInt(tagId);
    let tagName = this._map.get(tagIdBig);

    // 캐시 miss → DB 단건 조회
    if (tagName === undefined) {
      try {
        const sql = `SELECT name FROM _${this.logicalTable}_META WHERE _ID = ?`;
        const rows = await client.query(sql, [tagId]);
        if (!rows || rows.length === 0) {
          return { canonical: null, status: 'drop_not_found' };
        }
        tagName = rows[0].name;
        this._map.set(tagIdBig, tagName);
      } catch (err) {
        getLogger().error('reader', { tag_id: String(tagId), msg: err.message });
        return { canonical: null, status: 'retry_error' };
      }
    }

    const canonical = TagAliasCache._applyIdentifier(tagName, tagIdentifier);
    return { canonical, status: 'ok' };
  }

  static _applyIdentifier(tagName, tagIdentifier) {
    if (!tagIdentifier || tagIdentifier.mode === 'none') return tagName;
    if (tagIdentifier.mode === 'prefix') return (tagIdentifier.value || '') + tagName;
    if (tagIdentifier.mode === 'suffix') return tagName + (tagIdentifier.value || '');
    return tagName;
  }
}

// ─── Reader ───────────────────────────────────────────────────────────────────

class Reader {
  /**
   * @param {TableSchema} schema - srcTableSchema (불변 컬럼 구조, owned)
   * @param {MachbaseClient} client - 소스 DB 연결 (owned)
   * @param {string} dataTable - 파티션 테이블명 (예: _TAG_DATA_0)
   * @param {string[]|null} sourceColumns - UPPERCASE 허용 컬럼명 배열. null이면 전체 컬럼.
   */
  constructor(schema, client, dataTable, sourceColumns = null) {
    if (!/^[A-Za-z0-9_]+$/.test(dataTable)) {
      throw new Error(`Reader: invalid dataTable name '${dataTable}' (must match /^[A-Za-z0-9_]+$/)`);
    }
    this.schema = schema;
    this.client = client;
    this.dataTable = dataTable;

    // SELECT 컬럼명 목록을 생성 시점에 확정 (lowercase)
    // metadata 컬럼(category='metadata')은 SELECT 대상에서 제외 — DATA 파티션에 존재하지 않음
    const cols = schema.columns.filter(c => c.category !== 'metadata');
    const filtered = sourceColumns
      ? cols.filter(c => sourceColumns.includes(c.name))
      : cols;
    this.selectColumnNames = filtered.map(c => c.name.toLowerCase());
    this.selectColumnNamesUpper = this.selectColumnNames.map(c => c.toUpperCase());
  }

  /**
   * 소유한 연결 닫기
   */
  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  /**
   * 연결 재생성 (statement ID 고갈 시)
   * @param {object} config - MachbaseClient 접속 설정
   */
  async refreshConnection(config) {
    const newConn = new MachbaseClient(config);
    await newConn.connect();
    if (this.client) await this.client.close().catch(() => {});
    this.client = newConn;
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
    const columnNames = this.selectColumnNames;
    const client = this.client;
    const dataTable = this.dataTable;

    if (!columnNames || columnNames.length === 0) {
      return { rows: [], err: new Error('readAfterRid: schema has no columns') };
    }

    const selectCols = ['_RID', ...columnNames];

    // RID_RANGE 힌트는 반개방 구간 [startRid, endRid)
    let endRid = startRid + BigInt(rangeSize);
    try {
      const maxRows = await client.query(`SELECT MAX(_RID) as max_rid FROM ${dataTable}`);
      const rawMax = maxRows?.[0]?.max_rid;
      if (rawMax !== null && rawMax !== undefined) {
        const maxRidPlusOne = BigInt(rawMax) + 1n;
        if (maxRidPlusOne < endRid) endRid = maxRidPlusOne;
      }
    } catch (e) {
      // MAX(_RID) 실패 시 startRid + rangeSize를 폴백으로 사용.
      // 일시적 오류라면 다음 배치에서 복구되고, RID_RANGE 힌트가 실제 범위를 초과해도
      // WHERE _RID >= startRid 조건으로 안전하게 빈 결과가 반환되므로 무한 루프 위험은 없음.
      getLogger().warn('reader', { msg: `MAX(_RID) query failed for ${dataTable}, using startRid+rangeSize as endRid: ${e.message}` });
    }
    if (endRid < startRid) endRid = startRid;

    const colList = selectCols.join(', ');
    const sql = `SELECT /*+ RID_RANGE(${dataTable}, ${startRid}, ${endRid}) */ ${colList} FROM ${dataTable} WHERE _RID >= ${startRid} LIMIT ${limit}`;
    try {
      const rows = await client.query(sql);
      const result = [];
      for (const row of (rows || [])) {
        if (row._RID == null) {
          getLogger().warn('reader', { msg: `row with null _RID skipped in ${dataTable}` });
          continue;
        }
        // data에 _RID 제외한 나머지 컬럼을 UPPERCASE key로 저장
        // Machbase query()는 컬럼명을 소문자로 반환하므로 미리 계산된 uppercase 배열 사용
        const data = {};
        for (let i = 0; i < columnNames.length; i++) {
          data[this.selectColumnNamesUpper[i]] = row[columnNames[i]];
        }
        result.push({
          rid: BigInt(row._RID),
          tagId: data.NAME ?? null,
          data,
        });
      }
      return { rows: result, err: null };
    } catch (err) {
      getLogger().error('reader', { data_table: dataTable, msg: err.message });
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
      const rows = await this.client.query(sql);
      const raw = rows?.[0]?.max_rid;
      // 빈 테이블: MAX() → null
      if (raw === null || raw === undefined) return { maxRid: 0n, err: null };
      return { maxRid: BigInt(raw), err: null };
    } catch (err) {
      getLogger().error('reader', { data_table: this.dataTable, msg: `getMaxRid failed: ${err.message}` });
      return { maxRid: null, err };
    }
  }
}

module.exports = { Reader, TagAliasCache };
