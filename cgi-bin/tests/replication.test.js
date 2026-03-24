'use strict';

const fs = require('fs');
const process = require('process');
const path = require('path');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));
const ROOT = path.resolve(TESTS_DIR, '..');

const { suite, test, assert, run } = require(TESTS_DIR + '/test.js');
const { MachbaseClient } = require(ROOT + '/src/db/client.js');
const { Replicator } = require(ROOT + '/src/replication/replicator.js');
const { SRC, DST, SRC_TABLE, DST_TABLE } = require(TESTS_DIR + '/fixtures.js');

// 테스트용 config 기본값
function makeConfig(overrides = {}) {
  return {
    source: { ...SRC, table: SRC_TABLE, columns: null, filter: null, transform: null },
    target: { ...DST, table: DST_TABLE, autoCreate: true },
    startMode: 'full',
    queryLimit: 100,
    ridRangeSize: 50000,
    pollIntervalMs: 100,
    onSaveFailure: 'continue',
    shutdownTimeoutMs: 5000,
    integrity: false,
    retry: null,
    ...overrides,
  };
}

// DST_TABLE 초기화 (있으면 drop)
function dropDstTable() {
  const client = new MachbaseClient(DST);
  try {
    client.connect();
    const t = client.selectTableType(DST_TABLE);
    if (t.type !== 'UNSUPPORTED') {
      client.execute(`DROP TABLE ${DST_TABLE}`);
    }
  } finally {
    client.close();
  }
}

// replicator id 기준 체크포인트 디렉토리 삭제
// 체크포인트 경로: /work/data/{replicatorId}/{dataTable}.json
function dropCheckpoints(replicatorId) {
  const dir = ROOT + '/../data/' + replicatorId;
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    try { fs.unlinkSync(dir + '/' + f); } catch (_) {}
  }
  try { fs.rmdirSync(dir); } catch (_) {}
}

// makeConfig()에서 id 미설정 시 Replicator 자동 생성 규칙과 동일
function deriveId(overrides = {}) {
  const cfg = makeConfig(overrides);
  if (cfg.id) return cfg.id;
  const targetTable = cfg.target.table || cfg.source.table;
  return `${cfg.source.table}_${targetTable}`;
}

suite('Replicator - discover', () => {

  test('TAG 테이블 discover 성공', () => {
    const r = new Replicator(makeConfig());
    const discovered = r.discover();
    assert.ok(discovered, 'discover should succeed');
    assert.equal(discovered.tableType, 'TAG');
    assert.ok(discovered.dataTables.length > 0);
    assert.ok(discovered.srcSchema);
    assert.ok(discovered.dstSchema);
  });

  test('존재하지 않는 source 테이블 - discover null 반환', () => {
    const r = new Replicator(makeConfig({
      source: { ...SRC, table: 'NO_SUCH_TABLE_XYZ' },
    }));
    const discovered = r.discover();
    assert.equal(discovered, null);
  });

  test('autoCreate=false + 대상 테이블 없음 - discover null 반환', () => {
    dropDstTable();
    const r = new Replicator(makeConfig({ target: { ...DST, table: DST_TABLE, autoCreate: false } }));
    const discovered = r.discover();
    assert.equal(discovered, null);
  });

});

suite('Replicator - replication', () => {

  test('전체 복제 후 dst 테이블에 데이터 존재', async () => {
    const id = deriveId();
    dropDstTable();
    dropCheckpoints(id);

    const srcClient = new MachbaseClient(SRC);
    let maxRid;
    try {
      srcClient.connect();
      const parts = srcClient.selectTagDataTables(SRC_TABLE);
      maxRid = srcClient.selectMaxRid(parts[0].data_table);
    } finally {
      srcClient.close();
    }

    if (maxRid === 0n) {
      console.println('  SKIP: source table is empty');
      return;
    }

    // pollIntervalMs를 길게 설정해서 첫 배치 완료 후 poll 대기 중 shutdown
    const shutdownFlag = { value: false };
    const config = makeConfig({ startMode: 'full', integrity: false, pollIntervalMs: 60000 });
    const replicator = new Replicator(config, shutdownFlag);

    const startPromise = replicator.start();
    setTimeout(() => { shutdownFlag.value = true; }, 5000);
    await startPromise;

    const dstClient = new MachbaseClient(DST);
    try {
      dstClient.connect();
      const t = dstClient.selectTableType(DST_TABLE);
      assert.equal(t.type, 'TAG', 'dst table should be TAG');
      const parts = dstClient.selectTagDataTables(DST_TABLE);
      assert.ok(parts.length > 0, 'dst should have partitions');
      const dstMaxRid = dstClient.selectMaxRid(parts[0].data_table);
      assert.ok(dstMaxRid > 0n, 'dst should have rows');
    } finally {
      dstClient.close();
    }
  });

  test('startMode=now - dst 테이블 autoCreate 확인', async () => {
    const id = deriveId({ startMode: 'now' });
    dropDstTable();
    dropCheckpoints(id);

    const shutdownFlag = { value: false };
    const config = makeConfig({ startMode: 'now', integrity: false });
    const replicator = new Replicator(config, shutdownFlag);

    // discover+syncMeta 후 바로 shutdown
    const startPromise = replicator.start();
    setTimeout(() => { shutdownFlag.value = true; }, 1000);
    await startPromise;

    const dstClient = new MachbaseClient(DST);
    try {
      dstClient.connect();
      const t = dstClient.selectTableType(DST_TABLE);
      assert.equal(t.type, 'TAG');
    } finally {
      dstClient.close();
    }
  });

});

suite('Replicator - syncMeta', () => {

  test('TAG 테이블 syncMeta 성공', () => {
    const r = new Replicator(makeConfig());
    const discovered = r.discover();
    assert.ok(discovered);
    const result = r.syncMeta(discovered.srcSchema);
    assert.ok(result === true);
  });

});

run();
