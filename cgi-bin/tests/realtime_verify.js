/*
 * Realtime replication verification helper for manual test runs.
 *
 * Usage:
 *   machbase-neo jsh cgi-bin/tests/realtime_verify.js reset_real
 *   machbase-neo jsh cgi-bin/tests/realtime_verify.js drop_recreate_rdst
 *   machbase-neo jsh cgi-bin/tests/realtime_verify.js delete_tag_real
 *   machbase-neo jsh cgi-bin/tests/realtime_verify.js count TAG_RDST
 *   machbase-neo jsh cgi-bin/tests/realtime_verify.js max_rids
 *   machbase-neo jsh cgi-bin/tests/realtime_verify.js expected_after_rid 6299
 *   machbase-neo jsh cgi-bin/tests/realtime_verify.js verify_after_rid 6299
 *   machbase-neo jsh cgi-bin/tests/realtime_verify.js expected_after_cp '{"_TAG_REAL_DATA_0":149,"_TAG_REAL_DATA_1":149,"_TAG_REAL_DATA_2":149,"_TAG_REAL_DATA_3":149}'
 *   machbase-neo jsh cgi-bin/tests/realtime_verify.js verify_after_cp '{"_TAG_REAL_DATA_0":149,"_TAG_REAL_DATA_1":149,"_TAG_REAL_DATA_2":149,"_TAG_REAL_DATA_3":149}'
 *   machbase-neo jsh cgi-bin/tests/realtime_verify.js verify_real_full
 *
 * Notes:
 *   - This script is fixed to the local test DB at 127.0.0.1:5656.
 *   - It assumes TAG_REAL uses 4 physical partitions:
 *     _TAG_REAL_DATA_0 .. _TAG_REAL_DATA_3.
 *   - Output is JSON except for count/expected_* commands, which print a number.
 */

const process = require('process');
const { Client } = require('machcli');

const DB_OPTS = {
  host: '127.0.0.1',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

const TAG_REAL_PARTITIONS = [
  '_TAG_REAL_DATA_0',
  '_TAG_REAL_DATA_1',
  '_TAG_REAL_DATA_2',
  '_TAG_REAL_DATA_3',
];

function withConn(fn) {
  const db = new Client(DB_OPTS);
  const conn = db.connect();
  try {
    return fn(conn);
  } finally {
    conn.close();
    db.close();
  }
}

function firstValue(conn, sql, field) {
  for (const row of conn.query(sql)) {
    return row[field];
  }
  return null;
}

function jsonOut(obj) {
  console.println(JSON.stringify(obj));
}

function key(name, time) {
  return String(name) + '|' + String(time);
}

function sortedNumeric(values) {
  return values.slice().sort((a, b) => a - b);
}

function compareMaps(expectedMap, actualMap) {
  const keys = Object.keys(expectedMap).sort();
  let mismatchGroups = 0;

  for (const k of keys) {
    const a = sortedNumeric(expectedMap[k]);
    const b = sortedNumeric(actualMap[k] || []);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      mismatchGroups++;
    }
  }

  const pickIndexes = [0, Math.floor(keys.length / 4), Math.floor(keys.length / 2), Math.floor(keys.length * 3 / 4), keys.length - 1]
    .filter((v, i, arr) => v >= 0 && arr.indexOf(v) === i);

  const samples = pickIndexes.map((idx) => {
    const k = keys[idx];
    const parts = k.split('|');
    const expected = sortedNumeric(expectedMap[k]);
    const actual = sortedNumeric(actualMap[k] || []);
    return {
      NAME: parts[0],
      TIME: parts[1],
      expectedSample: expected.slice(0, 8),
      dstSample: actual.slice(0, 8),
      expectedCount: expected.length,
      dstCount: actual.length,
      match: JSON.stringify(expected) === JSON.stringify(actual),
    };
  });

  return { mismatchGroups, samples };
}

function loadTargetMap(conn, tableName) {
  const out = {};
  for (const row of conn.query(`select NAME, TIME, VALUE from ${tableName}`)) {
    const k = key(row.NAME, row.TIME);
    (out[k] || (out[k] = [])).push(Number(row.VALUE));
  }
  return out;
}

function loadMetaIdMap(conn, metaTable) {
  const out = {};
  for (const row of conn.query(`select _ID, NAME from ${metaTable}`)) {
    out[String(row._ID)] = row.NAME;
  }
  return out;
}

function countTable(tableName) {
  return withConn((conn) => Number(firstValue(conn, `select count(*) CNT from ${tableName}`, 'CNT')) || 0);
}

function resetReal() {
  withConn((conn) => {
    try { conn.exec('DROP TABLE TAG_REAL'); } catch (_) {}
    try { conn.exec('DROP TABLE TAG_RDST'); } catch (_) {}
    conn.exec('CREATE TAG TABLE TAG_REAL (NAME VARCHAR(60) PRIMARY KEY, TIME DATETIME BASETIME, VALUE INTEGER SUMMARIZED)');
    conn.exec('CREATE TAG TABLE TAG_RDST (NAME VARCHAR(60) PRIMARY KEY, TIME DATETIME BASETIME, VALUE INTEGER SUMMARIZED)');
  });
}

function dropRecreateRdst() {
  withConn((conn) => {
    try { conn.exec('DROP TABLE TAG_RDST'); } catch (_) {}
    conn.exec('CREATE TAG TABLE TAG_RDST (NAME VARCHAR(60) PRIMARY KEY, TIME DATETIME BASETIME, VALUE INTEGER SUMMARIZED)');
  });
}

function deleteTagReal() {
  withConn((conn) => {
    conn.exec('DELETE FROM TAG_REAL');
  });
}

function maxRids() {
  return withConn((conn) => {
    const out = {};
    for (const tableName of TAG_REAL_PARTITIONS) {
      out[tableName] = Number(firstValue(conn, `select max(_RID) MR from ${tableName}`, 'MR')) || -1;
    }
    return out;
  });
}

function minMaxRids() {
  return withConn((conn) => {
    const out = {};
    for (const tableName of TAG_REAL_PARTITIONS) {
      const sql = `select min(_RID) MN, max(_RID) MX from ${tableName}`;
      for (const r of conn.query(sql)) {
        out[tableName] = {
          min: r.MN == null ? null : Number(r.MN),
          max: r.MX == null ? null : Number(r.MX),
        };
        break;
      }
    }
    return out;
  });
}

function expectedCountAfterRid(ridAfter) {
  return withConn((conn) => {
    let total = 0;
    for (const tableName of TAG_REAL_PARTITIONS) {
      total += Number(firstValue(conn, `select count(*) CNT from ${tableName} where _RID >= ${ridAfter}`, 'CNT')) || 0;
    }
    return total;
  });
}

function verifyAfterRid(ridAfter) {
  return withConn((conn) => {
    const meta = loadMetaIdMap(conn, '_TAG_REAL_META');
    const expectedMap = {};

    for (const tableName of TAG_REAL_PARTITIONS) {
      for (const r of conn.query(`select NAME, TIME, VALUE from ${tableName} where _RID >= ${ridAfter}`)) {
        const name = meta[String(r.NAME)] || String(r.NAME);
        const k = key(name, r.TIME);
        (expectedMap[k] || (expectedMap[k] = [])).push(Number(r.VALUE));
      }
    }

    const dstMap = loadTargetMap(conn, 'TAG_RDST');
    const result = compareMaps(expectedMap, dstMap);

    let expectedCount = 0;
    for (const k of Object.keys(expectedMap)) expectedCount += expectedMap[k].length;

    return {
      title: 'rid_after_mid',
      ridAfter: String(ridAfter),
      expectedCount,
      dstCount: Number(firstValue(conn, 'select count(*) CNT from TAG_RDST', 'CNT')) || 0,
      mismatchGroups: result.mismatchGroups,
      samples: result.samples,
    };
  });
}

function expectedCountAfterCp(cp) {
  return withConn((conn) => {
    let total = 0;
    for (const table of Object.keys(cp)) {
      total += Number(firstValue(conn, `select count(*) CNT from ${table} where _RID > ${cp[table]}`, 'CNT')) || 0;
    }
    return total;
  });
}

function verifyAfterCp(cp) {
  return withConn((conn) => {
    const meta = loadMetaIdMap(conn, '_TAG_REAL_META');
    const expectedMap = {};

    for (const table of Object.keys(cp)) {
      for (const r of conn.query(`select NAME, TIME, VALUE from ${table} where _RID > ${cp[table]}`)) {
        const name = meta[String(r.NAME)] || String(r.NAME);
        const k = key(name, r.TIME);
        (expectedMap[k] || (expectedMap[k] = [])).push(Number(r.VALUE));
      }
    }

    const dstMap = loadTargetMap(conn, 'TAG_RDST');
    const result = compareMaps(expectedMap, dstMap);

    let expectedCount = 0;
    for (const k of Object.keys(expectedMap)) expectedCount += expectedMap[k].length;

    return {
      title: 'now_mid',
      cp,
      expectedCount,
      dstCount: Number(firstValue(conn, 'select count(*) CNT from TAG_RDST', 'CNT')) || 0,
      mismatchGroups: result.mismatchGroups,
      samples: result.samples,
    };
  });
}

function verifyRealFull() {
  return withConn((conn) => {
    const srcMap = loadTargetMap(conn, 'TAG_REAL');
    const dstMap = loadTargetMap(conn, 'TAG_RDST');
    const result = compareMaps(srcMap, dstMap);

    return {
      title: 'nonzero_rid_full',
      srcCount: Number(firstValue(conn, 'select count(*) CNT from TAG_REAL', 'CNT')) || 0,
      dstCount: Number(firstValue(conn, 'select count(*) CNT from TAG_RDST', 'CNT')) || 0,
      mismatchGroups: result.mismatchGroups,
      minRid: minMaxRids(),
      samples: result.samples.map((sample) => ({
        NAME: sample.NAME,
        TIME: sample.TIME,
        srcSample: sample.expectedSample,
        dstSample: sample.dstSample,
        srcCount: sample.expectedCount,
        dstCount: sample.dstCount,
        match: sample.match,
      })),
    };
  });
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === 'reset_real') {
  resetReal();
  jsonOut({ ok: true });
} else if (cmd === 'drop_recreate_rdst') {
  dropRecreateRdst();
  jsonOut({ ok: true });
} else if (cmd === 'delete_tag_real') {
  deleteTagReal();
  jsonOut({ ok: true });
} else if (cmd === 'count') {
  console.println(String(countTable(argv[1])));
} else if (cmd === 'max_rids') {
  jsonOut(maxRids());
} else if (cmd === 'expected_after_rid') {
  console.println(String(expectedCountAfterRid(argv[1])));
} else if (cmd === 'verify_after_rid') {
  jsonOut(verifyAfterRid(argv[1]));
} else if (cmd === 'expected_after_cp') {
  console.println(String(expectedCountAfterCp(JSON.parse(argv[1]))));
} else if (cmd === 'verify_after_cp') {
  jsonOut(verifyAfterCp(JSON.parse(argv[1])));
} else if (cmd === 'verify_real_full') {
  jsonOut(verifyRealFull());
} else {
  console.println(JSON.stringify({
    ok: false,
    reason: 'unknown command',
    argv,
  }));
}
