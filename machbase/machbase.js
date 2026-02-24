'use strict';

const { createConnection, QueryError } = require('@machbase/ts-client');

const ColumnTypeShort    = 4;
const ColumnTypeUShort   = 104;
const ColumnTypeInteger  = 8;
const ColumnTypeUInteger = 108;
const ColumnTypeLong     = 12;
const ColumnTypeULong    = 112;
const ColumnTypeFloat    = 16;
const ColumnTypeDouble   = 20;
const ColumnTypeVarchar  = 5;
const ColumnTypeText     = 49;
const ColumnTypeClob     = 53;
const ColumnTypeBlob     = 57;
const ColumnTypeBinary   = 97;
const ColumnTypeDatetime = 6;
const ColumnTypeIPv4     = 32;
const ColumnTypeIPv6     = 36;
const ColumnTypeJSON     = 61;

function columntypeof(type) {
  switch (type) {
    case ColumnTypeShort:
    case ColumnTypeUShort:
    case ColumnTypeInteger:
    case ColumnTypeUInteger:
      return 'int32';
    case ColumnTypeLong:
    case ColumnTypeULong:
    case ColumnTypeDatetime:
      return 'int64';
    case ColumnTypeFloat:
    case ColumnTypeDouble:
      return 'float64';
    case ColumnTypeVarchar:
    case ColumnTypeText:
    case ColumnTypeClob:
    case ColumnTypeBlob:
    case ColumnTypeBinary:
    case ColumnTypeIPv4:
    case ColumnTypeIPv6:
    case ColumnTypeJSON:
      return 'varchar';
    default:
      return 'unknown';
  }
}

class MachbaseClient {
  constructor(config) {
    this.conn = createConnection(config);
  }

  async connect() {
    await this.conn.connect();
    console.debug('machbase: connected');
  }

  async close() {
    await this.conn.end();
    console.debug('machbase: closed');
  }

  async query(sql, values) {
    console.debug('query: ' + sql);
    const [rows] = await this.conn.query(sql, values);
    return rows || [];
  }
}

module.exports = { createConnection, QueryError, MachbaseClient, columntypeof };
