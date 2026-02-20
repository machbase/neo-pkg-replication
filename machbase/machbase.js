const { createConnection, QueryError } = require('@machbase/ts-client');

const ColumnTypeShort    = 4
const ColumnTypeUShort   = 104
const ColumnTypeInteger  = 8
const ColumnTypeUInteger = 108
const ColumnTypeLong     = 12
const ColumnTypeULong    = 112
const ColumnTypeFloat    = 16
const ColumnTypeDouble   = 20
const ColumnTypeVarchar  = 5
const ColumnTypeText     = 49
const ColumnTypeClob     = 53
const ColumnTypeBlob     = 57
const ColumnTypeBinary   = 97
const ColumnTypeDatetime = 6
const ColumnTypeIPv4     = 32
const ColumnTypeIPv6     = 36
const ColumnTypeJSON     = 61

function columntypeof(type) {
  switch (type) {
    case ColumnTypeShort:
        return "int32"
    case ColumnTypeUShort:
        return "int32"
    case ColumnTypeInteger:
        return "int32"
    case ColumnTypeUInteger:
        return "int32"
    case ColumnTypeLong:
        return "int64"
    case ColumnTypeULong:
        return "int64"
    case ColumnTypeFloat:
        return "float64"
    case ColumnTypeDouble:
        return "float64"
    case ColumnTypeVarchar:
        return "varchar"
    case ColumnTypeText:
        return "varchar"
    case ColumnTypeClob:
        return "varchar"
    case ColumnTypeBlob:
        return "varchar"
    case ColumnTypeBinary:
        return "varchar"
    case ColumnTypeDatetime:
        return "int64"
    case ColumnTypeIPv4:
        return "varchar"
    case ColumnTypeIPv6:
        return "varchar"
    case ColumnTypeJSON:
        return "varchar"
    default:
      return "unknown";
  }
}

class MachbaseClient {
  constructor(config, table) {
    this.table = table
    this.conn = createConnection(config);
  }

  async connect() {
    await this.conn.connect();
    console.debug("machbase: connect")
  }

  async close() {
    await this.conn.end();
    console.debug("machbase: closed")
  }

  async query(sql, value) {
    console.debug("query: " + sql)
    const [rows] = await this.conn.query(sql, value);
    if (!rows || rows.length === 0) {
      console.warn("no rows");
      return [];
    }

    return rows;
  }

  // === TableExists ===
  async tableExists() {
    const sql = `SELECT * FROM ${this.table} LIMIT 1`;
    try {
      await this.query(sql);
      return true;
    } catch (err) {
      if (err instanceof QueryError && err.message.startsWith('MACH-ERR 2025')) {
        return false;
      }
      throw err;
    }
  }

  async lookupEndRIDS() {
    const sql = `
      SELECT m.NAME AS name, v.TABLE_END_RID AS rid
      FROM V$STORAGE_TAG_TABLES v, M$SYS_TABLES m
      WHERE v.ID = m.ID AND m.NAME LIKE ?
    `.trim();

    return await this.query(sql, [`_${this.table}_DATA_%`]);
  }

  async lookupColumns() {
    const sql = `
      SELECT distinct c.name, c.type
      FROM M$SYS_TABLES t, M$SYS_COLUMNS c
      WHERE c.TABLE_ID = t.ID
          AND c.ID > 0 AND c.ID < 65534
          AND c.type <> 112
          AND t.NAME IN (?, ?)
      ORDER BY c.ID ASC
    `.trim();

    return await this.query(sql, [`_${this.table}_META`, `_${this.table}_DATA_0`]);
  }

  // === LookupDataColumns ===
  async lookupDataColumns() {
    const sql = `
      SELECT c.name, c.type
      FROM M$SYS_TABLES t, M$SYS_COLUMNS c
      WHERE c.TABLE_ID = t.ID
        AND t.NAME = ?
        AND c.ID > 0 AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim();

    return await this.query(sql, [`_${this.table}_DATA_0`]);
  }

  // === LookupMetaColumns ===
  async lookupMetaColumns() {
    const sql = `
      SELECT c.name, c.type
      FROM M$SYS_TABLES t, M$SYS_COLUMNS c
      WHERE c.TABLE_ID = t.ID
        AND t.NAME = ?
        AND c.ID > 1 AND c.ID < 65534
      ORDER BY c.ID ASC
    `.trim();

    return await this.query(sql, [`_${this.table}_META`]);
  }

  async selectDataByRid(store, range, limit) {
    const sql = `
      SELECT /*+ RID_RANGE(${store.name} , ${store.rid}, ${store.rid+BigInt(range)}) */ d._RID, m.name, d.time, d.value
      FROM ${store.name} d, _${this.table}_META m WHERE d.name = m._ID
      LIMIT ?
    `.trim();

    return await this.query(sql, [limit]);
  }

  async stream() {
    return new MachbaseStream(this);
  }
}

class MachbaseStream {
  constructor(client) {
    this.client = client
  }
  
  async open() {
    await this.client.connect();
    this.cols = (await this.client.lookupColumns())
      .map(c => ({ ...c, type: columntypeof(c.type) }));

    console.debug("columns: ", this.cols);
    this.stream = await this.client.conn.appendOpen(this.client.table, this.cols);
    console.debug("machbase-stream: open");
  }

  async close() {
    await this.stream.close();
    console.debug("machbase-stream: closed");
    await this.client.close();
  }

  // v : [][]
  async append(v) {
    return await this.stream.append(v);
  }
}

module.exports = {
  MachbaseClient,
  MachbaseStream
};
