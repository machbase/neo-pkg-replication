'use strict';

/**
 * @fileoverview TAG metadata sync stress helper for manual replication tests.
 *
 * 목적:
 * - source TAG에 100개 안팎의 초기 tag/meta를 미리 넣고 실시간 append를 계속 발생시킨다.
 * - 실행 중 신규 tag + data 추가와 meta-only 추가를 섞어서 metadata sync gap 경로를 반복적으로 자극한다.
 * - replication stop/start 또는 process kill/restart 시나리오 후 source/target 정합성 점검에 쓸 수 있다.
 *
 * 사용 예:
 *   machbase-neo jsh cgi-bin/tests/tag_meta_stress.js reset TMS_SRC TMS_DST 100
 *   machbase-neo jsh cgi-bin/tests/tag_meta_stress.js generate TMS_SRC 120 24 200
 *   machbase-neo jsh cgi-bin/tests/tag_meta_stress.js summary TMS_SRC TMS_DST
 *   machbase-neo jsh cgi-bin/tests/tag_meta_stress.js verify TMS_SRC TMS_DST
 *
 * 인자:
 *   reset   <srcTable> <dstTable> [seedTagCount]
 *   generate <srcTable> [durationSec] [batchSize] [tickMs]
 *   summary <srcTable> <dstTable>
 *   verify  <srcTable> <dstTable>
 */

const process = require('process');
const { Client } = require('machcli');

const DB_OPTS = {
  host: '127.0.0.1',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

const DEFAULT_SRC_TABLE = 'TMS_SRC';
const DEFAULT_DST_TABLE = 'TMS_DST';
const DEFAULT_SEED_TAGS = 100;
const DEFAULT_DURATION_SEC = 120;
const DEFAULT_BATCH_SIZE = 24;
const DEFAULT_TICK_MS = 200;
const NEW_LIVE_TAG_EVERY_TICKS = 15;
const NEW_META_ONLY_EVERY_TICKS = 25;
const PROMOTE_PENDING_EVERY_TICKS = 35;
const PROGRESS_EVERY_TICKS = 25;

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

function jsonOut(value) {
  console.println(JSON.stringify(value));
}

function upper(name, fallback) {
  const text = String(name || fallback || '').trim().toUpperCase();
  if (!text) throw new Error('table name is required');
  return text;
}

function parseIntOr(value, fallback) {
  const num = parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(num) ? num : fallback;
}

function pad4(num) {
  let text = String(num);
  while (text.length < 4) text = '0' + text;
  return text;
}

function tagName(index) {
  return `TAG-${pad4(index)}`;
}

function metaTableName(tableName) {
  return `_${upper(tableName)}_META`;
}

function buildMeta(index, flavor) {
  const code = pad4(index);
  return {
    eqpid: `EQP-${code}`,
    eqpcnt: index,
  };
}

function insertMeta(conn, tableName, name, meta) {
  conn.exec(
    `INSERT INTO ${tableName} METADATA VALUES (?, ?, ?)`,
    name,
    meta.eqpid,
    meta.eqpcnt
  );
}

function insertRow(conn, tableName, name, time, value) {
  conn.exec(
    `INSERT INTO ${tableName} VALUES (?, ?, ?)`,
    name,
    time,
    value
  );
}

function buildValue(tagIndex, seq) {
  return tagIndex * 100000 + seq;
}

function dropTableIfExists(conn, tableName) {
  try { conn.exec(`DROP TABLE ${tableName}`); } catch (_) {}
}

function createStressTables(conn, srcTable, dstTable) {
  dropTableIfExists(conn, dstTable);
  dropTableIfExists(conn, srcTable);
  const ddl = `(NAME VARCHAR(80) PRIMARY KEY, TIME DATETIME BASETIME, VALUE DOUBLE) METADATA (EQPID VARCHAR(40), EQPCNT INTEGER)`;
  conn.exec(`CREATE TAG TABLE ${srcTable} ${ddl}`);
  conn.exec(`CREATE TAG TABLE ${dstTable} ${ddl}`);
}

function seedSource(conn, srcTable, seedTagCount) {
  const baseMs = Date.now() - 600000;
  for (let i = 1; i <= seedTagCount; i++) {
    const name = tagName(i);
    insertMeta(conn, srcTable, name, buildMeta(i, 'seed'));
    insertRow(conn, srcTable, name, new Date(baseMs + i * 1000), buildValue(i, 0));
  }
}

function cmdReset(srcTableArg, dstTableArg, seedTagCountArg) {
  const srcTable = upper(srcTableArg, DEFAULT_SRC_TABLE);
  const dstTable = upper(dstTableArg, DEFAULT_DST_TABLE);
  const seedTagCount = parseIntOr(seedTagCountArg, DEFAULT_SEED_TAGS);

  withConn((conn) => {
    createStressTables(conn, srcTable, dstTable);
    seedSource(conn, srcTable, seedTagCount);
  });

  jsonOut({
    ok: true,
    action: 'reset',
    sourceTable: srcTable,
    targetTable: dstTable,
    seedTagCount,
  });
}

function loadSourceMeta(conn, srcTable) {
  const rows = queryAll(conn, `SELECT _ID, NAME, EQPID, EQPCNT FROM ${metaTableName(srcTable)} ORDER BY _ID`);
  return rows.map((row) => ({
    id: Number(row._ID),
    name: row.NAME,
    lineNo: Number(row.EQPCNT),
  }));
}

function maxTagNumberFromMeta(rows) {
  let max = 0;
  for (const row of rows) {
    const match = /(\d+)$/.exec(String(row.name || ''));
    if (!match) continue;
    const num = parseInt(match[1], 10);
    if (Number.isFinite(num) && num > max) max = num;
  }
  return max;
}

function countValue(conn, sql, field) {
  const row = firstRow(conn, sql);
  return row == null || row[field] == null ? 0 : Number(row[field]);
}

function buildRowsByKey(conn, tableName) {
  const out = {};
  const rows = conn.query(`SELECT NAME, TIME, VALUE FROM ${tableName} ORDER BY NAME, TIME`);
  try {
    for (const row of rows) {
      const key = `${row.NAME}|${String(row.TIME)}|${Number(row.VALUE)}`;
      out[key] = (out[key] || 0) + 1;
    }
  } finally {
    try { rows.close(); } catch (_) {}
  }
  return out;
}

function buildNameSet(conn, tableName) {
  const out = {};
  const rows = conn.query(`SELECT NAME FROM ${metaTableName(tableName)} ORDER BY NAME`);
  try {
    for (const row of rows) out[row.NAME] = true;
  } finally {
    try { rows.close(); } catch (_) {}
  }
  return out;
}

function latestByTag(conn, tableName, limit) {
  const rows = conn.query(`
    SELECT NAME, MAX(TIME) AS LAST_TIME, COUNT(*) AS CNT
    FROM ${tableName}
    GROUP BY NAME
    ORDER BY LAST_TIME DESC
    LIMIT ${limit}
  `);
  const out = [];
  try {
    for (const row of rows) {
      out.push({
        name: row.NAME,
        lastTime: String(row.LAST_TIME),
        count: Number(row.CNT),
      });
    }
  } finally {
    try { rows.close(); } catch (_) {}
  }
  return out;
}

function cmdSummary(srcTableArg, dstTableArg) {
  const srcTable = upper(srcTableArg, DEFAULT_SRC_TABLE);
  const dstTable = upper(dstTableArg, DEFAULT_DST_TABLE);

  const result = withConn((conn) => {
    const srcRows = countValue(conn, `SELECT COUNT(*) CNT FROM ${srcTable}`, 'CNT');
    const dstRows = countValue(conn, `SELECT COUNT(*) CNT FROM ${dstTable}`, 'CNT');
    const srcMetaRows = countValue(conn, `SELECT COUNT(*) CNT FROM ${metaTableName(srcTable)}`, 'CNT');
    const dstMetaRows = countValue(conn, `SELECT COUNT(*) CNT FROM ${metaTableName(dstTable)}`, 'CNT');
    const srcMetaMax = firstRow(conn, `SELECT MAX(_ID) AS MX FROM ${metaTableName(srcTable)}`);
    const dstMetaMax = firstRow(conn, `SELECT MAX(_ID) AS MX FROM ${metaTableName(dstTable)}`);
    const srcNames = buildNameSet(conn, srcTable);
    const dstNames = buildNameSet(conn, dstTable);
    const missingTargetMeta = Object.keys(srcNames).filter((name) => !dstNames[name]);

    return {
      ok: true,
      action: 'summary',
      sourceTable: srcTable,
      targetTable: dstTable,
      source: {
        rowCount: srcRows,
        metaCount: srcMetaRows,
        metaMaxId: srcMetaMax && srcMetaMax.MX != null ? String(srcMetaMax.MX) : '',
        latestByTag: latestByTag(conn, srcTable, 8),
      },
      target: {
        rowCount: dstRows,
        metaCount: dstMetaRows,
        metaMaxId: dstMetaMax && dstMetaMax.MX != null ? String(dstMetaMax.MX) : '',
        latestByTag: latestByTag(conn, dstTable, 8),
      },
      diff: {
        rowCount: srcRows - dstRows,
        metaCount: srcMetaRows - dstMetaRows,
        missingTargetMetaCount: missingTargetMeta.length,
        missingTargetMetaSample: missingTargetMeta.slice(0, 12),
      },
    };
  });

  jsonOut(result);
}

function cmdVerify(srcTableArg, dstTableArg) {
  const srcTable = upper(srcTableArg, DEFAULT_SRC_TABLE);
  const dstTable = upper(dstTableArg, DEFAULT_DST_TABLE);

  const result = withConn((conn) => {
    const srcRows = buildRowsByKey(conn, srcTable);
    const dstRows = buildRowsByKey(conn, dstTable);
    const srcKeys = Object.keys(srcRows).sort();
    const dstKeys = Object.keys(dstRows).sort();

    const missingRows = [];
    const extraRows = [];
    for (const key of srcKeys) {
      if ((dstRows[key] || 0) !== srcRows[key]) {
        missingRows.push({ key, expected: srcRows[key], actual: dstRows[key] || 0 });
        if (missingRows.length >= 12) break;
      }
    }
    for (const key of dstKeys) {
      if ((srcRows[key] || 0) !== dstRows[key]) {
        extraRows.push({ key, expected: srcRows[key] || 0, actual: dstRows[key] });
        if (extraRows.length >= 12) break;
      }
    }

    const srcNames = buildNameSet(conn, srcTable);
    const dstNames = buildNameSet(conn, dstTable);
    const missingTargetMeta = Object.keys(srcNames).filter((name) => !dstNames[name]);
    const extraTargetMeta = Object.keys(dstNames).filter((name) => !srcNames[name]);

    return {
      ok: missingRows.length === 0 && extraRows.length === 0 && missingTargetMeta.length === 0 && extraTargetMeta.length === 0,
      action: 'verify',
      sourceTable: srcTable,
      targetTable: dstTable,
      sourceRowCount: srcKeys.length,
      targetRowCount: dstKeys.length,
      missingRows,
      extraRows,
      missingTargetMetaSample: missingTargetMeta.slice(0, 12),
      extraTargetMetaSample: extraTargetMeta.slice(0, 12),
      missingTargetMetaCount: missingTargetMeta.length,
      extraTargetMetaCount: extraTargetMeta.length,
    };
  });

  jsonOut(result);
  if (!result.ok) process.exit(1);
}

function cmdGenerate(srcTableArg, durationSecArg, batchSizeArg, tickMsArg) {
  const srcTable = upper(srcTableArg, DEFAULT_SRC_TABLE);
  const durationSec = parseIntOr(durationSecArg, DEFAULT_DURATION_SEC);
  const batchSize = parseIntOr(batchSizeArg, DEFAULT_BATCH_SIZE);
  const tickMs = parseIntOr(tickMsArg, DEFAULT_TICK_MS);

  const db = new Client(DB_OPTS);
  const conn = db.connect();
  const metaRows = loadSourceMeta(conn, srcTable);
  const state = {
    sourceTable: srcTable,
    durationSec,
    batchSize,
    tickMs,
    startedAt: new Date().toISOString(),
    baseMs: Date.now(),
    nextTagIndex: maxTagNumberFromMeta(metaRows) + 1,
    active: metaRows.map((row) => ({ name: row.name, index: row.lineNo || row.id })),
    pendingMetaOnly: [],
    roundRobinOffset: 0,
    globalSeq: 1,
    tick: 0,
    insertedRows: 0,
    insertedLiveTags: 0,
    insertedMetaOnlyTags: 0,
    promotedMetaOnlyTags: 0,
    skippedTicks: 0,
    busy: false,
  };

  function appendOne(tag) {
    const seq = state.globalSeq++;
    const time = new Date(state.baseMs + seq * 10 + tag.index);
    const value = buildValue(tag.index, seq);
    insertRow(conn, srcTable, tag.name, time, value);
    state.insertedRows++;
  }

  function addNewTag(mode) {
    const index = state.nextTagIndex++;
    const name = tagName(index);
    const flavor = mode === 'meta-only' ? 'pending' : 'live';
    insertMeta(conn, srcTable, name, buildMeta(index, flavor));
    if (mode === 'meta-only') {
      state.pendingMetaOnly.push({ name, index });
      state.insertedMetaOnlyTags++;
      return { name, index, mode };
    }
    const tag = { name, index };
    state.active.push(tag);
    appendOne(tag);
    state.insertedLiveTags++;
    return { name, index, mode };
  }

  function promotePendingMetaOnly() {
    if (state.pendingMetaOnly.length === 0) return null;
    const tag = state.pendingMetaOnly.shift();
    state.active.push(tag);
    appendOne(tag);
    state.promotedMetaOnlyTags++;
    return tag;
  }

  function progress(event, extra) {
    jsonOut({
      ok: true,
      action: 'generate',
      event,
      sourceTable: state.sourceTable,
      tick: state.tick,
      activeTags: state.active.length,
      pendingMetaOnly: state.pendingMetaOnly.length,
      insertedRows: state.insertedRows,
      insertedLiveTags: state.insertedLiveTags,
      insertedMetaOnlyTags: state.insertedMetaOnlyTags,
      promotedMetaOnlyTags: state.promotedMetaOnlyTags,
      skippedTicks: state.skippedTicks,
      ...(extra || {}),
    });
  }

  let timer = null;
  let stopTimer = null;

  function closeAll(exitCode) {
    try { if (timer) clearInterval(timer); } catch (_) {}
    try { if (stopTimer) clearTimeout(stopTimer); } catch (_) {}
    try { conn.close(); } catch (_) {}
    try { db.close(); } catch (_) {}
    process.exit(exitCode);
  }

  function finish(ok, reason) {
    try {
      while (state.pendingMetaOnly.length > 0) {
        promotePendingMetaOnly();
      }
      // 종료 시점에 tail tag 하나를 더 만들어 마지막 metadata-only gap도 뒤에서 덮을 수 있게 한다.
      addNewTag('live');
      progress('finished', {
        ok,
        reason,
        finishedAt: new Date().toISOString(),
      });
      closeAll(ok ? 0 : 1);
    } catch (err) {
      progress('finish_error', { ok: false, reason: err.message });
      closeAll(1);
    }
  }

  progress('started', {
    durationSec,
    batchSize,
    tickMs,
    initialActiveTags: state.active.length,
  });

  timer = setInterval(() => {
    if (state.busy) {
      state.skippedTicks++;
      return;
    }
    state.busy = true;
    try {
      state.tick++;
      const activeCount = state.active.length;
      if (activeCount > 0) {
        for (let i = 0; i < batchSize; i++) {
          const tag = state.active[state.roundRobinOffset % activeCount];
          state.roundRobinOffset++;
          appendOne(tag);
        }
      }

      if (state.tick % NEW_LIVE_TAG_EVERY_TICKS === 0) {
        const created = addNewTag('live');
        progress('new_live_tag', created);
      }
      if (state.tick % NEW_META_ONLY_EVERY_TICKS === 0) {
        const created = addNewTag('meta-only');
        progress('new_meta_only_tag', created);
      }
      if (state.tick % PROMOTE_PENDING_EVERY_TICKS === 0) {
        const promoted = promotePendingMetaOnly();
        if (promoted) progress('promote_meta_only_tag', promoted);
      }
      if (state.tick % PROGRESS_EVERY_TICKS === 0) {
        progress('progress');
      }
    } catch (err) {
      clearInterval(timer);
      finish(false, err.message);
      return;
    } finally {
      state.busy = false;
    }
  }, tickMs);

  stopTimer = setTimeout(() => {
    clearInterval(timer);
    finish(true, 'duration_reached');
  }, durationSec * 1000);
}

const args = process.argv.slice(2);
const command = String(args[0] || '').trim().toLowerCase();

try {
  if (command === 'reset') {
    cmdReset(args[1], args[2], args[3]);
  } else if (command === 'generate') {
    cmdGenerate(args[1], args[2], args[3], args[4]);
  } else if (command === 'summary') {
    cmdSummary(args[1], args[2]);
  } else if (command === 'verify') {
    cmdVerify(args[1], args[2]);
  } else {
    throw new Error(`unknown command '${command}'`);
  }
} catch (err) {
  jsonOut({ ok: false, reason: err.message });
  process.exit(1);
}
