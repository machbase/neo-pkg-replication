'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const ConfigLoader = require('../../config/config.js');

async function writeConfig(obj) {
  const filePath = path.join(os.tmpdir(), `config_test_${Date.now()}.json`);
  await fs.writeFile(filePath, JSON.stringify(obj));
  return filePath;
}

const BASE_CONFIG = {
  version: 3,
  servers: {
    src: { host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    dst: { host: '127.0.0.1', port: 5657, user: 'SYS', password: 'MANAGER' },
  },
  replication: {
    jobs: [{
      id: 'job-1',
      checkpoint: { directory: './checkpoints' },
      source: { server: 'src', table: 'TAG' },
      target: { server: 'dst', table: 'TAG2' },
      execution: {
        query_limit: 5000,
        poll_interval_ms: 1000,
        start_mode: 'full',
        on_save_failure: 'continue',
      },
    }],
  },
};

test('정상 config 로드', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await ConfigLoader.load(filePath);
  assert.equal(config.version, 3);
  assert.equal(config.replication.jobs.length, 1);
  assert.ok(config.replication.jobs[0].source);
  assert.ok(config.replication.jobs[0].target);
  assert.ok(config.replication.jobs[0].execution);
});

test('version != 3 → 오류', async () => {
  const filePath = await writeConfig({ ...BASE_CONFIG, version: 2 });
  await assert.rejects(() => ConfigLoader.load(filePath), /version/i);
});

test('servers 없음 → 오류', async () => {
  const { servers: _, ...noServers } = BASE_CONFIG;
  const filePath = await writeConfig(noServers);
  await assert.rejects(() => ConfigLoader.load(filePath), /servers/i);
});

test('replication.jobs 없음 → 오류', async () => {
  const filePath = await writeConfig({ ...BASE_CONFIG, replication: {} });
  await assert.rejects(() => ConfigLoader.load(filePath), /jobs/i);
});

test('존재하지 않는 source server → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.server = 'unknown';
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /unknown source server/i);
});

test('start_mode=rid_after + rid_after 없음 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, start_mode: 'rid_after' };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /rid_after/i);
});

test('start_mode=rid_after + rid_after 있음 → 정상 로드', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, start_mode: 'rid_after', rid_after: '0' };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].execution.start_mode, 'rid_after');
});

test('execution 필드 레벨 merge: job.execution > EXECUTION_DEFAULTS', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = {
    query_limit: 9999,
    poll_interval_ms: 200,
    start_mode: 'full',
    on_save_failure: 'continue',
  };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  const exec = result.replication.jobs[0].execution;
  assert.equal(exec.query_limit, 9999);    // job wins over default
  assert.equal(exec.poll_interval_ms, 200); // job wins over default
  assert.equal(exec.start_mode, 'full');
});

test('기본값 주입: query_limit=5000, rid_range_size=50000, shutdown_timeout_ms=30000', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].execution.query_limit;
  delete config.replication.jobs[0].shutdown_timeout_ms;
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  const exec = result.replication.jobs[0].execution;
  assert.equal(exec.query_limit, 5000);
  assert.equal(exec.rid_range_size, 50000);
  assert.equal(result.replication.jobs[0].shutdown_timeout_ms, 30000);
});

test('rid_range_size 사용자 설정', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, rid_range_size: 99999 };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  const exec = result.replication.jobs[0].execution;
  assert.equal(exec.rid_range_size, 99999, 'job level rid_range_size wins');
});

test('rid_range_size 비정수 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, rid_range_size: 0 };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /rid_range_size/i);
});


// === 검증 강화 테스트 ===

test('job.source 없음 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].source;
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /source/i);
});

test('job.target 없음 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].target;
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /target/i);
});

test('source.table 빈 문자열 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.table = '';
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /source\.table/i);
});

test('target.table 없음 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].target.table;
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /target\.table/i);
});

test('query_limit 비정수 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, query_limit: 'abc' };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /query_limit/i);
});

test('poll_interval_ms 0 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, poll_interval_ms: 0 };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /poll_interval_ms/i);
});

test('retry가 배열 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, retry: [1, 2, 3] };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /retry/i);
});

test('retry.strategy 잘못된 값 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, retry: { strategy: 'random' } };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /retry\.strategy/i);
});

test('retry.max_attempts 음수 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, retry: { max_attempts: -1 } };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /retry\.max_attempts/i);
});

test('integrity 비객체 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, integrity: 'yes' };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /integrity/i);
});

test('integrity.enabled 비불리언 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution = { ...config.replication.jobs[0].execution, integrity: { enabled: 1 } };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /integrity\.enabled/i);
});

test('tag_identifier.value 비문자열 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.tag_identifier = { mode: 'prefix', value: 123 };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /tag_identifier\.value/i);
});

test('shutdown_timeout_ms 비정수 → warn 후 기본값 30000', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].shutdown_timeout_ms = 'bad';
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].shutdown_timeout_ms, 30000);
});

test('checkpoint.directory 빈 문자열 → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].checkpoint = { directory: '' };
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /checkpoint\.directory/);
});

test('checkpoint = {} (directory 없음) → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].checkpoint = {};
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /checkpoint\.directory/);
});

test('JSON 파싱 실패 → 파일 경로 포함 에러', async () => {
  const filePath = path.join(os.tmpdir(), `config_test_invalid_${Date.now()}.json`);
  await fs.writeFile(filePath, 'NOT_VALID_JSON');
  await assert.rejects(() => ConfigLoader.load(filePath), err => {
    assert.ok(err.message.includes(filePath), `Expected filePath in error: ${err.message}`);
    return true;
  });
});

// === source.columns 허용 목록 테스트 ===

test('source.columns 미지정 → columns: null', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].source.columns, null);
});

test('source.columns: ["TIME", "VALUE"] → UPPERCASE 정규화 후 ["TIME", "VALUE"]', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.columns = ['TIME', 'VALUE'];
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.deepEqual(result.replication.jobs[0].source.columns, ['TIME', 'VALUE']);
});

test('source.columns: ["time", "value"] (소문자) → ["TIME", "VALUE"]로 정규화', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.columns = ['time', 'value'];
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.deepEqual(result.replication.jobs[0].source.columns, ['TIME', 'VALUE']);
});

test('source.columns: [] (빈 배열) → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.columns = [];
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /source\.columns/i);
});

test('source.columns: [123] (비문자열) → 오류', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].source.columns = [123];
  const filePath = await writeConfig(config);
  await assert.rejects(() => ConfigLoader.load(filePath), /source\.columns/i);
});
