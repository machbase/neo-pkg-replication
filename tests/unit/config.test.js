'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { Config } = require('../../src/config/config.js');

async function writeConfig(obj) {
  const filePath = path.join(os.tmpdir(), `config_test_${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(obj));
  return filePath;
}

const BASE_CONFIG = {
  version: 3,
  servers: [
    { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    { name: 'dst', host: '127.0.0.1', port: 5657, user: 'SYS', password: 'MANAGER' },
  ],
  replication: {
    jobs: [{
      id: 'job-1',
      source: { server: 'src', table: 'TAG' },
      target: { server: 'dst', table: 'TAG2' },
      queryLimit: 5000,
      pollIntervalMs: 1000,
      startMode: 'full',
      onSaveFailure: 'continue',
    }],
  },
};

test('정상 config 로드', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);
  assert.equal(config.version, 3);
  assert.equal(config.replication.jobs.length, 1);
  assert.ok(config.replication.jobs[0].source);
  assert.ok(config.replication.jobs[0].target);
  assert.ok(config.replication.jobs[0].queryLimit);
});

test('version != 3 → 오류', async () => {
  const filePath = await writeConfig({ ...BASE_CONFIG, version: 2 });
  await assert.rejects(() => Config.load(filePath), /version/i);
});

test('servers 없음 → 오류', async () => {
  const { servers: _, ...noServers } = BASE_CONFIG;
  const filePath = await writeConfig(noServers);
  await assert.rejects(() => Config.load(filePath), /servers/i);
});

test('replication.jobs 없음 → 오류', async () => {
  const filePath = await writeConfig({ ...BASE_CONFIG, replication: {} });
  await assert.rejects(() => Config.load(filePath), /jobs/i);
});

test('존재하지 않는 source server → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.server = 'unknown';
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /unknown source server/i);
});

test('startMode=ridAfter + ridAfter 없음 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].startMode = 'ridAfter';
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /ridAfter/i);
});

test('startMode=ridAfter + ridAfter 있음 → 정상 로드', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].startMode = 'ridAfter';
  config.replication.jobs[0].ridAfter = '0';
  const filePath = await writeConfig(config);
  const result = await Config.load(filePath);
  assert.equal(result.replication.jobs[0].startMode, 'ridAfter');
});

test('job 필드 직접 지정: queryLimit, pollIntervalMs', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].queryLimit = 9999;
  config.replication.jobs[0].pollIntervalMs = 200;
  const filePath = await writeConfig(config);
  const result = await Config.load(filePath);
  const job = result.replication.jobs[0];
  assert.equal(job.queryLimit, 9999);
  assert.equal(job.pollIntervalMs, 200);
  assert.equal(job.startMode, 'full');
});

test('기본값 주입: queryLimit=5000, ridRangeSize=50000, shutdownTimeoutMs=30000', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].queryLimit;
  delete config.replication.jobs[0].shutdownTimeoutMs;
  const filePath = await writeConfig(config);
  const result = await Config.load(filePath);
  const job = result.replication.jobs[0];
  assert.equal(job.queryLimit, 5000);
  assert.equal(job.ridRangeSize, 50000);
  assert.equal(job.shutdownTimeoutMs, 30000);
});

test('ridRangeSize 사용자 설정', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].ridRangeSize = 99999;
  const filePath = await writeConfig(config);
  const result = await Config.load(filePath);
  assert.equal(result.replication.jobs[0].ridRangeSize, 99999);
});

test('ridRangeSize 비정수 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].ridRangeSize = 0;
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /ridRangeSize/i);
});


// === 검증 강화 테스트 ===

test('job.source 없음 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].source;
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /source/i);
});

test('job.target 없음 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].target;
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /target/i);
});

test('source.table 빈 문자열 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.table = '';
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /source\.table/i);
});

test('target.table 없음 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].target.table;
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /target\.table/i);
});

test('queryLimit 비정수 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].queryLimit = 'abc';
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /queryLimit/i);
});

test('pollIntervalMs 0 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].pollIntervalMs = 0;
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /pollIntervalMs/i);
});

test('retry가 배열 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].retry = [1, 2, 3];
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /retry/i);
});

test('retry.strategy 잘못된 값 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].retry = { strategy: 'random' };
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /retry\.strategy/i);
});

test('retry.maxAttempts 음수 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].retry = { maxAttempts: -1 };
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /retry\.maxAttempts/i);
});

test('integrity 비객체 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].integrity = 'yes';
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /integrity/i);
});

test('integrity.enabled 비불리언 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].integrity = { enabled: 1 };
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /integrity\.enabled/i);
});

test('tagIdentifier.value 비문자열 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.tagIdentifier = { mode: 'prefix', value: 123 };
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /tagIdentifier\.value/i);
});

test('shutdownTimeoutMs 비정수 → warn 후 기본값 30000', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].shutdownTimeoutMs = 'bad';
  const filePath = await writeConfig(config);
  const result = await Config.load(filePath);
  assert.equal(result.replication.jobs[0].shutdownTimeoutMs, 30000);
});

test('JSON 파싱 실패 → 파일 경로 포함 에러', async () => {
  const filePath = path.join(os.tmpdir(), `config_test_invalid_${Date.now()}.json`);
  await fs.writeFile(filePath, 'NOT_VALID_JSON');
  await assert.rejects(() => Config.load(filePath), err => {
    assert.ok(err.message.includes(filePath), `Expected filePath in error: ${err.message}`);
    return true;
  });
});

// === source.columns 허용 목록 테스트 ===

test('source.columns 미지정 → columns: null', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const result = await Config.load(filePath);
  assert.equal(result.replication.jobs[0].source.columns, null);
});

test('source.columns: ["TIME", "VALUE"] → UPPERCASE 정규화 후 ["TIME", "VALUE"]', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.columns = ['TIME', 'VALUE'];
  const filePath = await writeConfig(config);
  const result = await Config.load(filePath);
  assert.deepEqual(result.replication.jobs[0].source.columns, ['TIME', 'VALUE']);
});

test('source.columns: ["time", "value"] (소문자) → ["TIME", "VALUE"]로 정규화', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.columns = ['time', 'value'];
  const filePath = await writeConfig(config);
  const result = await Config.load(filePath);
  assert.deepEqual(result.replication.jobs[0].source.columns, ['TIME', 'VALUE']);
});

test('source.columns: [] (빈 배열) → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.columns = [];
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /source\.columns/i);
});

test('source.columns: [123] (비문자열) → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.columns = [123];
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /source\.columns/i);
});

// === Config 인스턴스 메서드 테스트 ===

test('addJob: 새 job 추가 후 replication.jobs에 포함됨', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  const newJob = {
    id: 'job-new',
    source: { server: 'src', table: 'TAG' },
    target: { server: 'dst', table: 'TAG2' },
    startMode: 'full',
    pollIntervalMs: 1000,
    queryLimit: 5000,
    onSaveFailure: 'continue',
  };

  const jobConfig = config.addJob(newJob);
  assert.equal(jobConfig.id, 'job-new');
  assert.equal(config.replication.jobs.length, 2);
  assert.equal(config.replication.jobs[1].id, 'job-new');
});

test('addJob: 유효하지 않은 server → 오류 throw', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  const badJob = {
    id: 'job-bad',
    source: { server: 'nonexistent', table: 'TAG' },
    target: { server: 'dst', table: 'TAG2' },
    startMode: 'full',
  };

  assert.throws(() => config.addJob(badJob), /unknown source server/i);
});

test('updateJob: 기존 job 내용 교체', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  const updatedJob = {
    id: 'job-1',
    source: { server: 'src', table: 'TAG' },
    target: { server: 'dst', table: 'TAG3' },
    startMode: 'now',
    pollIntervalMs: 2000,
    queryLimit: 1000,
    onSaveFailure: 'continue',
  };

  const jobConfig = config.updateJob('job-1', updatedJob);
  assert.equal(jobConfig.id, 'job-1');
  assert.equal(jobConfig.target.table, 'TAG3');
  assert.equal(jobConfig.startMode, 'now');
  assert.equal(config.replication.jobs.length, 1);
  assert.equal(config.replication.jobs[0].target.table, 'TAG3');
});

test('removeJob: job 제거 후 replication.jobs에서 삭제됨', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  assert.equal(config.replication.jobs.length, 1);
  config.removeJob('job-1');
  assert.equal(config.replication.jobs.length, 0);
});

test('removeJob: 존재하지 않는 id → 오류 없이 무시', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  config.removeJob('nonexistent');
  assert.equal(config.replication.jobs.length, 1, '존재하지 않는 id 제거 → jobs 그대로');
});

test('addServer: 정상 추가 → servers에 포함됨', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  assert.equal(config.servers.length, 2);
  const srv = config.addServer({ name: 'new', host: '10.0.0.1', port: 5656, user: 'SYS', password: 'PASS' });
  assert.equal(config.servers.length, 3);
  assert.equal(srv.name, 'new');
  assert.equal(srv.host, '10.0.0.1');
});

test('addServer: 중복 name → throw already exists', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  assert.throws(
    () => config.addServer({ name: 'src', host: '10.0.0.1', port: 5656, user: 'SYS', password: 'PASS' }),
    /already exists/i
  );
});

test('addServer: host 없음 → valid() throw', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  assert.throws(
    () => config.addServer({ name: 'new', port: 5656, user: 'SYS', password: 'PASS' }),
    /host/i
  );
});

test('updateServer: host 변경 → servers[idx] 교체', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  const srv = config.updateServer('src', { host: '192.168.1.1', port: 5656, user: 'SYS', password: 'PASS' });
  assert.equal(srv.host, '192.168.1.1');
  assert.equal(config.servers.find(s => s.name === 'src').host, '192.168.1.1');
});

test('updateServer: 존재하지 않는 name → throw not found', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  assert.throws(
    () => config.updateServer('nonexistent', { host: '10.0.0.1', port: 5656, user: 'SYS', password: 'PASS' }),
    /not found/i
  );
});

test('removeServer: 정상 삭제 → servers에서 제거됨', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  assert.equal(config.servers.length, 2);
  config.removeServer('src');
  assert.equal(config.servers.length, 1);
  assert.equal(config.servers[0].name, 'dst');
});

test('removeServer: 존재하지 않는 name → throw not found', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  assert.throws(() => config.removeServer('nonexistent'), /not found/i);
});

// === target.autoCreate 테스트 ===

test('target.autoCreate: true + table: "" → valid 통과', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].target = { server: 'dst', table: '', autoCreate: true };
  const filePath = await writeConfig(config);
  const result = await Config.load(filePath);
  assert.equal(result.replication.jobs[0].target.table, '');
  assert.equal(result.replication.jobs[0].target.autoCreate, true);
});

test('target.autoCreate: false + table: "" → config 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].target = { server: 'dst', table: '', autoCreate: false };
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /autoCreate/i);
});

test('target.autoCreate: true + table: "TAG_COPY" → valid 통과', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].target = { server: 'dst', table: 'TAG_COPY', autoCreate: true };
  const filePath = await writeConfig(config);
  const result = await Config.load(filePath);
  assert.equal(result.replication.jobs[0].target.table, 'TAG_COPY');
  assert.equal(result.replication.jobs[0].target.autoCreate, true);
});

test('target.autoCreate 미지정 + table: "" → config 오류 (autoCreate 기본 false)', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].target = { server: 'dst', table: '' };
  const filePath = await writeConfig(config);
  await assert.rejects(() => Config.load(filePath), /autoCreate/i);
});

test('save: 파일에 쓰고 다시 로드 가능', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await Config.load(filePath);

  config.addJob({
    id: 'job-saved',
    source: { server: 'src', table: 'TAG' },
    target: { server: 'dst', table: 'TAG2' },
    startMode: 'full',
    pollIntervalMs: 1000,
    queryLimit: 5000,
    onSaveFailure: 'continue',
  });

  await config.save();

  const reloaded = await Config.load(filePath);
  assert.equal(reloaded.replication.jobs.length, 2);
  assert.equal(reloaded.replication.jobs[1].id, 'job-saved');
});
