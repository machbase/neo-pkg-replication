'use strict';

const { ColumnType } = require('./machbase.js');

class Writer {
  /**
   * @param {TableInfo} dstTableInfo - 대상 TableInfo (owned)
   */
  constructor(dstTableInfo) {
    this.dstTableInfo = dstTableInfo;
    this.conn = null;
    this.stream = null;
    /** @type {Array<{ name: string, columnType: ColumnType, isSourceColumn: boolean }>} */
    this.appendColumns = [];
  }

  /**
   * appendOpen 스트림 초기화 (mapping 시작 시 1회 호출)
   *
   * @param {MachbaseClient} conn - target MachbaseClient
   * @param {string} table - 대상 논리 테이블명
   * @param {TableInfo} srcTableInfo - 소스 TableInfo
   * @returns {Error|null}
   */
  async open(conn, table, srcTableInfo) {
    try {
      this.conn = conn;

      // 소스 writeColumns에서 컬럼명 Set 구성
      const srcNames = new Set(srcTableInfo.writeColumns.map(c => c.name));

      // 대상 writeColumns 순회하며 appendColumns 구성
      this.appendColumns = this.dstTableInfo.writeColumns.map(c => ({
        name: c.name,
        columnType: c.columnType,
        isSourceColumn: srcNames.has(c.name),
      }));

      // appendOpen에 전체 컬럼 전달 (소스에 없는 컬럼은 safeNull로 패딩)
      this.stream = await this.conn.appendOpen(
        table,
        this.appendColumns.map(c => ({ name: c.name, type: c.columnType.type }))
      );
      return null;
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'writer', table, msg: `open failed: ${err.message}` }));
      return err;
    }
  }

  /**
   * 배치 데이터 append
   * @param {Array<object>} rows - { NAME: ..., TIME: ..., VALUE: ..., ... } 컬럼명 기준 객체
   * @returns {Error|null}
   */
  async append(rows) {
    if (!rows || rows.length === 0) return null;
    if (!this.stream) {
      return new Error('Writer.append called before open()');
    }
    try {
      const matrix = rows.map(row => {
        if (Array.isArray(row)) return row;
        return this.appendColumns.map(col => {
          if (!col.isSourceColumn) return col.columnType.safeNull;
          const val = row[col.name];
          if (val == null) return col.columnType.safeNull;
          if (col.columnType.type === 'int64') {
            return typeof val === 'bigint' ? val : BigInt(Math.trunc(Number(val)));
          }
          return val;
        });
      });
      await this.stream.append(matrix);
      return null;
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', stage: 'writer', msg: `append failed: ${err.message}` }));
      return err;
    }
  }

  /**
   * 스트림 닫기
   * @returns {Error|null}
   */
  async close() {
    let firstErr = null;
    if (this.stream) {
      try {
        await this.stream.close();
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', stage: 'writer', msg: `stream close failed: ${err.message}` }));
        firstErr = err;
      }
      this.stream = null;
    }
    if (this.conn) {
      try {
        await this.conn.close();
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', stage: 'writer', msg: `conn close failed: ${err.message}` }));
        if (!firstErr) firstErr = err;
      }
      this.conn = null;
    }
    return firstErr;
  }
}

module.exports = Writer;
