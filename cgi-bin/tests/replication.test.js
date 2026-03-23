'use strict';

const process = require('process');
const path = require('path');
const ROOT = process.cwd();

const { suite, test, assert, run } = require(path.join(ROOT, 'tests', 'test.js'));
const { MachbaseClient } = require(path.join(ROOT, 'src', 'db', 'client.js'));
const { Replicator } = require(path.join(ROOT, 'src', 'replication', 'replicator.js'));
const { SRC, DST, SRC_TABLE, DST_TABLE } = require(path.join(ROOT, 'tests', 'fixtures.js'));

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

// 체크포인트 파일 삭제 (SRC_TABLE 기준)
function dropCheckpoints() {
  const fs = require('fs');
  const dir = path.join(ROOT, 'data');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.startsWith(SRC_TABLE + '_'));
  for (const f of files) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
  }
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

  test('존재하지 않는 source 테이블 - discover 실패', () => {
    const r = new Replicator(makeConfig({
      source: { ...SRC, table: 'NO_SUCH_TABLE_XYZ' },
    }));
    const discovered = r.discover();
    assert.equal(discovered, null);
  });

});

suite('Replicator - replication', () => {

  test('전체 복제 후 dst 테이블에 데이터 존재', async () => {
    dropDstTable();
    dropCheckpoints();

    // src의 현재 최대 RID 파악
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
    // 첫 배치 복제 후 pollIntervalMs 대기 진입 시점에 shutdown
    setTimeout(() => { shutdownFlag.value = true; }, 5000);
    await startPromise;

    // dst에 데이터가 있는지 확인
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
    dropDstTable();

    const shutdownFlag = { value: false };
    const config = makeConfig({ startMode: 'now', integrity: false });
    const replicator = new Replicator(config, shutdownFlag);

    // discover+syncMeta 후 바로 shutdown (workers 진입 전)
    const startPromise = replicator.start();
    setTimeout(() => { shutdownFlag.value = true; }, 1000);
    await startPromise;

    // dst 테이블이 autoCreate로 생성됐는지 확인
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
