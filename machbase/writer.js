'use strict';


class Writer {
  /**
   * @param {TableSchema} schema - 대상 TableSchema (owned)
   */
  constructor(schema) {
    this.schema = schema;
    this.conn = null;
    this.stream = null;
    /** @type {Set<string>|null} 소스에 존재하는 컬럼명 Set (UPPERCASE) */
    this.srcNames = null;
  }

  /**
   * appendOpen 스트림 초기화 (mapping 시작 시 1회 호출)
   *
   * @param {MachbaseClient} conn - target MachbaseClient
   * @param {string} table - 대상 논리 테이블명
   * @param {TableSchema} srcSchema - 소스 TableSchema
   * @returns {Error|null}
   */
  async open(conn, table, srcSchema) {
    try {
      this.conn = conn;
      this.srcNames = new Set(srcSchema.columns.map(c => c.name));

      this.stream = await this.conn.appendOpen(
        table,
        this.schema.columns.map(c => ({ name: c.name, type: c.columnType.type }))
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
  _toInt64(col, val) {
    if (typeof val === 'bigint') return val;
    if (typeof val === 'number' && !Number.isInteger(val)) {
      console.warn(JSON.stringify({ level: 'warn', stage: 'writer', msg: `int64 column '${col.name}' received non-integer number ${val}, truncating` }));
      return BigInt(Math.trunc(val));
    }
    return BigInt(val);
  }

  _toCell(col, row) {
    if (!this.srcNames.has(col.name)) return col.columnType.safeNull;
    const val = row[col.name];
    if (val == null) return col.columnType.safeNull;
    if (col.columnType.type === 'int64') return this._toInt64(col, val);
    return val;
  }

  async append(rows) {
    if (!rows || rows.length === 0) return null;
    if (!this.stream) {
      return new Error('Writer.append called before open()');
    }
    try {
      const matrix = rows.map(row =>
        Array.isArray(row) ? row : this.schema.columns.map(col => this._toCell(col, row))
      );
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
    this.srcNames = null;
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
