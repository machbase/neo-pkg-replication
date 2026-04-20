'use strict';

/**
 * @fileoverview 수동 통합 테스트용 DB 상태 조회/정리 헬퍼
 *
 * 의도:
 * - shell runner가 반복적으로 쓰는 count/sample/cleanup 로직을 한 곳에 모은다.
 * - 테스트가 실패하더라도 같은 명령으로 잔여 테이블과 상태를 빠르게 확인할 수 있게 한다.
 *
 * 주의:
 * - 테스트 보조 도구이므로 커밋되는 로그/산출물은 만들지 않는다.
 * - 기본 접속은 127.0.0.1:5656 이며 필요하면 환경변수로 덮어쓴다.
 */

const process = require('process');
const { Client } = require('machcli');

function readEnv(name, fallback) {
  const value = process.env.get(name);
  return value == null || value === '' ? fallback : value;
}

function readEnvInt(name, fallback) {
  const value = readEnv(name, '');
  if (value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DB_OPTS = {
  host: readEnv('MANUAL_TEST_DB_HOST', '127.0.0.1'),
  port: readEnvInt('MANUAL_TEST_DB_PORT', 5656),
  user: readEnv('MANUAL_TEST_DB_USER', 'SYS'),
  password: readEnv('MANUAL_TEST_DB_PASSWORD', 'MANAGER'),
};

function withConn(fn) {
  const db = new Client(DB_OPTS);
  const conn = db.connect();
  try {
    return fn(conn);
  } finally {
    try { conn.close(); } catch (_) {}
    try { db.close(); } catch (_) {}
  }
}

function jsonOut(value) {
  console.println(JSON.stringify(value));
}

function upper(name) {
  const text = String(name || '').trim().toUpperCase();
  if (!text) throw new Error('table name is required');
  return text;
}

function metaTableName(tableName) {
  return `_${upper(tableName)}_META`;
}

function firstRow(conn, sql) {
  const rows = conn.query(sql);
  try {
    for (const row of rows) return row;
    return null;
  } finally {
    try { rows.close(); } catch (_) {}
  }
}

function queryAll(conn, sql) {
  const rows = conn.query(sql);
  const result = [];
  try {
    for (const row of rows) result.push(row);
    return result;
  } finally {
    try { rows.close(); } catch (_) {}
  }
}

function countValue(conn, sql, field) {
  const row = firstRow(conn, sql);
  return row == null || row[field] == null ? 0 : Number(row[field]);
}

function dropTableIfExists(conn, tableName) {
  try { conn.exec(`DROP TABLE ${upper(tableName)}`); } catch (_) {}
}

function cmdCleanup(args) {
  const tables = args.map(upper);
  withConn((conn) => {
    for (const table of tables) dropTableIfExists(conn, table);
  });
  jsonOut({ ok: true, action: 'cleanup', tables });
}

function cmdCounts(srcTableArg, dstTableArg) {
  const srcTable = upper(srcTableArg);
  const dstTable = upper(dstTableArg);
  const result = withConn((conn) => ({
    ok: true,
    action: 'counts',
    source: {
      table: srcTable,
      rows: countValue(conn, `SELECT COUNT(*) CNT FROM ${srcTable}`, 'CNT'),
      meta: countValue(conn, `SELECT COUNT(*) CNT FROM ${metaTableName(srcTable)}`, 'CNT'),
    },
    target: {
      table: dstTable,
      rows: countValue(conn, `SELECT COUNT(*) CNT FROM ${dstTable}`, 'CNT'),
      meta: countValue(conn, `SELECT COUNT(*) CNT FROM ${metaTableName(dstTable)}`, 'CNT'),
    },
  }));
  jsonOut(result);
}

function cmdSample(tableArg, limitArg) {
  const table = upper(tableArg);
  const limit = Math.max(1, parseInt(String(limitArg || '5'), 10) || 5);
  const result = withConn((conn) => ({
    ok: true,
    action: 'sample',
    table,
    rows: queryAll(conn, `SELECT NAME, TIME, VALUE FROM ${table} ORDER BY TIME DESC LIMIT ${limit}`),
    meta: queryAll(conn, `SELECT _ID, NAME FROM ${metaTableName(table)} ORDER BY _ID DESC LIMIT ${limit}`),
  }));
  jsonOut(result);
}

function cmdTailByName(tableArg, nameArg, limitArg) {
  const table = upper(tableArg);
  const name = String(nameArg || '').trim();
  const limit = Math.max(1, parseInt(String(limitArg || '5'), 10) || 5);
  if (!name) throw new Error('name is required');
  const escaped = name.replace(/'/g, "''");
  const result = withConn((conn) => ({
    ok: true,
    action: 'tailByName',
    table,
    name,
    rows: queryAll(conn, `SELECT NAME, TIME, VALUE FROM ${table} WHERE NAME = '${escaped}' ORDER BY TIME DESC LIMIT ${limit}`),
  }));
  jsonOut(result);
}

const command = String(process.argv[2] || '').trim().toLowerCase();
const args = process.argv.slice(3);

try {
  if (command === 'cleanup') cmdCleanup(args);
  else if (command === 'counts') cmdCounts(args[0], args[1]);
  else if (command === 'sample') cmdSample(args[0], args[1]);
  else if (command === 'tail-by-name') cmdTailByName(args[0], args[1], args[2]);
  else throw new Error(`unknown command '${command}'`);
} catch (err) {
  jsonOut({ ok: false, reason: err.message });
  process.exit(1);
}
