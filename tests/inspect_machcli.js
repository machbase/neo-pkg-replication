'use strict';

// findFirstMissRow 전체 흐름 재현
// - src: _TAG_COPY_DATA_0 (NAME=tag_id 숫자) → canonical name으로 변환 후
// - dst: TAG_COPY (논리 테이블, NAME=varchar canonical name)과 JOIN
const { Client } = require('machcli');

const config = {
  host: '192.168.1.183',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

const db = new Client(config);
const conn = db.connect();

try {
  // 1) META 테이블에서 tag_id → canonical name 매핑
  const metaRows = conn.query('SELECT _ID, name FROM _TAG_COPY_META');
  const idToName = new Map();
  for (const r of metaRows) idToName.set(r._ID, r.name);
  metaRows.close();
  console.println(`meta cache: ${idToName.size} entries`);

  // 2) 파티션에서 3행 읽어서 canonical name으로 변환
  const rows = conn.query('SELECT _RID, NAME, TIME FROM _TAG_COPY_DATA_0 LIMIT 3');
  const resolved = [];
  for (const row of rows) {
    const canonical = idToName.get(row.NAME) || String(row.NAME);
    resolved.push({ canonical, time: row.TIME });
    console.println(`  tag_id=${row.NAME} → canonical='${canonical}'  TIME=${String(row.TIME)}`);
  }
  rows.close();

  // 3) VOLATILE TABLE에 canonical name + TIME 객체 ? 바인딩으로 INSERT
  const chk = '_repli_chk_test';
  const lkp = '_repli_lkp_test';

  conn.exec(`CREATE VOLATILE TABLE ${chk} (IDX INT, NAME VARCHAR(100), TIME DATETIME)`);
  conn.exec(`CREATE VOLATILE TABLE ${lkp} (NAME VARCHAR(100), TIME DATETIME)`);

  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    conn.exec(`INSERT INTO ${chk} (IDX, NAME, TIME) VALUES (?, ?, ?)`, i, r.canonical, r.time);
  }

  // 저장 확인
  console.println('\n=== stored in chk ===');
  const stored = conn.query(`SELECT IDX, NAME, TIME FROM ${chk} ORDER BY IDX`);
  for (const r of stored) {
    console.println(`  IDX=${r.IDX}  NAME='${r.NAME}'  TIME=${String(r.TIME)}`);
  }
  stored.close();

  // 4) TAG_COPY(논리 테이블)와 JOIN
  conn.exec(
    `INSERT INTO ${lkp} ` +
    `SELECT t.NAME, t.TIME FROM TAG_COPY t, ${chk} c ` +
    `WHERE t.NAME = c.NAME AND t.TIME = c.TIME`
  );

  // 5) miss 확인
  const missResult = conn.query(
    `SELECT IDX FROM (` +
      `SELECT c.IDX, t.NAME AS T_NAME ` +
      `FROM ${chk} c LEFT OUTER JOIN ${lkp} t ON c.NAME = t.NAME AND c.TIME = t.TIME` +
    `) WHERE T_NAME IS NULL ORDER BY IDX ASC LIMIT 1`
  );
  console.println('\n=== miss rows ===');
  let hasMiss = false;
  for (const r of missResult) {
    console.println(`  first miss IDX=${r.IDX}`);
    hasMiss = true;
  }
  if (!hasMiss) console.println('  no miss — all rows confirmed');
  missResult.close();

  conn.exec(`DROP TABLE ${chk}`);
  conn.exec(`DROP TABLE ${lkp}`);
} finally {
  conn.close();
  db.close();
}
