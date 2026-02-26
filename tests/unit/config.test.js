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
      enabled: true,
      checkpoint: { directory: './checkpoints' },
      execution_defaults: {
        query_limit: 5000,
        poll_interval_ms: 1000,
        start_mode: 'full',
        on_save_failure: 'continue',
        shutdown_timeout_ms: 30000,
      },
      mappings: [{
        mapping_id: 'map-1',
        source: { server: 'src', table: 'TAG' },
        target: { server: 'dst', table: 'TAG2' },
      }],
    }],
  },
};

test('정상 config 로드', async () => {
  const filePath = await writeConfig(BASE_CONFIG);
  const config = await ConfigLoader.load(filePath);
  assert.equal(config.version, 3);
  assert.equal(config.replication.jobs.length, 1);
  assert.equal(config.replication.jobs[0].mappings.length, 1);
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

test('존재하지 않는 source server → 해당 mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].source.server = 'unknown';
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('start_mode=rid_after + rid_after 없음 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].execution = { start_mode: 'rid_after' };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('start_mode=rid_after + rid_after 있음 → 정상 로드', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].execution = { start_mode: 'rid_after', rid_after: '0' };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 1);
  assert.equal(result.replication.jobs[0].mappings[0].execution.start_mode, 'rid_after');
});

test('execution 필드 레벨 merge: mapping > source > job_defaults', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution_defaults.query_limit = 1000;
  config.replication.jobs[0].execution_defaults.poll_interval_ms = 500;
  config.replication.jobs[0].mappings[0].source = {
    server: 'src',
    table: 'TAG',
    execution: { poll_interval_ms: 200 },   // source level: poll_interval_ms 덮어씀
  };
  config.replication.jobs[0].mappings[0].execution = {
    query_limit: 9999,               // mapping level: query_limit 덮어씀
  };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  const exec = result.replication.jobs[0].mappings[0].execution;
  assert.equal(exec.query_limit, 9999);   // mapping wins
  assert.equal(exec.poll_interval_ms, 200);       // source wins over job
  assert.equal(exec.start_mode, 'full');           // job default
});

test('기본값 주입: query_limit=5000, rid_range_size=50000, shutdown_timeout_ms=30000', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].execution_defaults.query_limit;
  delete config.replication.jobs[0].shutdown_timeout_ms;
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  const exec = result.replication.jobs[0].mappings[0].execution;
  assert.equal(exec.query_limit, 5000);
  assert.equal(exec.rid_range_size, 50000);
  assert.equal(result.replication.jobs[0].shutdown_timeout_ms, 30000);
});

test('rid_range_size 사용자 설정 및 merge 우선순위', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].execution_defaults.rid_range_size = 20000;
  config.replication.jobs[0].mappings[0].execution = { rid_range_size: 99999 };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  const exec = result.replication.jobs[0].mappings[0].execution;
  assert.equal(exec.rid_range_size, 99999, 'mapping level rid_range_size wins');
});

test('rid_range_size 비정수 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].execution = { rid_range_size: 0 };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('enabled=false job 처리', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].enabled = false;
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].enabled, false);
});

// === 검증 강화 테스트 ===

test('mapping.source 없음 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].mappings[0].source;
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('mapping.target 없음 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].mappings[0].target;
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('source.table 빈 문자열 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].source.table = '';
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('target.table 없음 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].mappings[0].target.table;
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('query_limit 비정수 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].execution = { query_limit: 'abc' };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('poll_interval_ms 0 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].execution = { poll_interval_ms: 0 };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('retry가 배열 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].execution = { retry: [1, 2, 3] };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('retry.strategy 잘못된 값 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].execution = { retry: { strategy: 'random' } };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('retry.max_attempts 음수 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].execution = { retry: { max_attempts: -1 } };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('integrity 비객체 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].execution = { integrity: 'yes' };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('integrity.enabled 비불리언 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].execution = { integrity: { enabled: 1 } };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
});

test('tag_identifier.value 비문자열 → mapping 스킵', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].mappings[0].source.tag_identifier = { mode: 'prefix', value: 123 };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].mappings.length, 0);
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
