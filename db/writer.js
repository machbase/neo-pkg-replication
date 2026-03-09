'use strict';

const { getInstance: getLogger } = require('../logger/logger.js');
const { MachbaseStream, _toCell } = require('./stream.js');


class Writer {
  /**
   * @param {TableSchema} schema - 대상 TableSchema (owned)
   */
  constructor(schema) {
    this.schema = schema;
    this.stream = null;
    /** @type {Set<string>|null} 소스에 존재하는 컬럼명 Set (UPPERCASE) */
    this.srcNames = null;
  }

  /**
   * appendOpen 스트림 초기화 (mapping 시작 시 1회 호출)
   *
   * @param {MachbaseClient} client - target MachbaseClient (생명주기는 호출자 관리)
   * @param {string} table - 대상 논리 테이블명
   * @param {TableSchema} srcSchema - 소스 TableSchema
   * @returns {Error|null}
   */
  async open(client, table, srcSchema) {
    this.srcNames = new Set(srcSchema.columns.map(c => c.name));
    this.stream = new MachbaseStream();
    return this.stream.open(
      client,
      table,
      this.schema.columns.map(c => ({ name: c.name, type: c.columnType.type }))
    );
  }

  async append(rows) {
    if (!rows || rows.length === 0) return null;
    if (!this.stream) return new Error('Writer.append called before open()');
    const matrix = rows.map(row =>
      this.schema.columns.map(col => {
        if (!this.srcNames.has(col.name)) return col.columnType.safeNull;
        const val = row[col.name];
        if (col.columnType.type === 'int64' && typeof val === 'number' && !Number.isInteger(val))
          getLogger().warn('writer', { msg: `int64 column '${col.name}' received non-integer number ${val}, truncating` });
        else if (typeof val === 'number' && !isFinite(val))
          getLogger().warn('writer', { col: col.name, value: String(val), msg: `non-finite float value replaced with null` });
        return _toCell(col, val);
      })
    );
    return this.stream.append(matrix);
  }

  /**
   * 스트림 + client 닫기
   * @returns {Error|null}
   */
  async close() {
    this.srcNames = null;
    if (this.stream) {
      const err = await this.stream.close();
      this.stream = null;
      return err;
    }
    return null;
  }
}

module.exports = { Writer };
