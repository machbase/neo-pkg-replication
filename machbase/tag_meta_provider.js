'use strict';

class TagMetaProvider {
  constructor() {
    /** @type {Map<number|bigint, string>} */
    this.map = new Map();
    this.logicalTable = null;
  }

  /**
   * Worker 시작 시 1회 호출 — 전체 META 로드
   * @param {MachbaseClient} conn
   * @param {string} logicalTable
   * @returns {Error|null}
   */
  async loadAll(conn, logicalTable) {
    this.logicalTable = logicalTable;
    const sql = `SELECT _ID, name FROM _${logicalTable}_META`;
    try {
      const rows = await conn.query(sql);
      this.map.clear();
      for (const row of (rows || [])) {
        this.map.set(BigInt(row._ID), row.name);
      }
      console.debug(JSON.stringify({ level: 'debug', stage: 'tag_meta_provider', msg: `loadAll: ${this.map.size} tags loaded` }));
      return null;
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'tag_meta_provider', msg: `loadAll failed: ${err.message}` }));
      return err;
    }
  }

  /**
   * tag_id → canonical 태그명 변환 (Read-through cache)
   * @param {MachbaseClient} conn
   * @param {number|bigint} tagId
   * @param {{ mode: 'prefix'|'suffix'|'none', value?: string }|null} tagIdentifier
   * @returns {{ canonical: string|null, status: 'ok'|'drop_not_found'|'retry_error' }}
   */
  async resolveTagCanonical(conn, tagId, tagIdentifier) {
    // 1. 캐시 조회 — 키를 BigInt로 통일
    const tagIdBig = BigInt(tagId);
    let tagName = this.map.get(tagIdBig);

    // 2. 캐시 miss → DB 단건 조회
    if (tagName === undefined) {
      try {
        const sql = `SELECT name FROM _${this.logicalTable}_META WHERE _ID = ?`;
        const rows = await conn.query(sql, [tagId]);
        if (!rows || rows.length === 0) {
          return { canonical: null, status: 'drop_not_found' };
        }
        tagName = rows[0].name;
        this.map.set(tagIdBig, tagName);
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', stage: 'tag_meta_provider', tag_id: String(tagId), msg: err.message }));
        return { canonical: null, status: 'retry_error' };
      }
    }

    // 3. tag_identifier 적용
    const canonical = TagMetaProvider._applyIdentifier(tagName, tagIdentifier);
    return { canonical, status: 'ok' };
  }

  static _applyIdentifier(tagName, tagIdentifier) {
    if (!tagIdentifier || tagIdentifier.mode === 'none') return tagName;
    if (tagIdentifier.mode === 'prefix') return (tagIdentifier.value || '') + tagName;
    if (tagIdentifier.mode === 'suffix') return tagName + (tagIdentifier.value || '');
    return tagName;
  }
}

module.exports = TagMetaProvider;
