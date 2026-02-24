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
        batch_size_records: 5000,
        poll_interval_ms: 1000,
        start_mode: 'full',
        on_save_failure: 'continue',
        shutdown_timeout_ms: 30000,
      },
      mappings: [{
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
  config.replication.jobs[0].execution_defaults.batch_size_records = 1000;
  config.replication.jobs[0].execution_defaults.poll_interval_ms = 500;
  config.replication.jobs[0].mappings[0].source = {
    server: 'src',
    table: 'TAG',
    execution: { poll_interval_ms: 200 },   // source level: poll_interval_ms 덮어씀
  };
  config.replication.jobs[0].mappings[0].execution = {
    batch_size_records: 9999,               // mapping level: batch_size_records 덮어씀
  };
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  const exec = result.replication.jobs[0].mappings[0].execution;
  assert.equal(exec.batch_size_records, 9999);   // mapping wins
  assert.equal(exec.poll_interval_ms, 200);       // source wins over job
  assert.equal(exec.start_mode, 'full');           // job default
});

test('기본값 주입: batch_size_records=5000, shutdown_timeout_ms=30000', async () => {
  const config = structuredClone(BASE_CONFIG);
  delete config.replication.jobs[0].execution_defaults.batch_size_records;
  delete config.replication.jobs[0].shutdown_timeout_ms;
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  const exec = result.replication.jobs[0].mappings[0].execution;
  assert.equal(exec.batch_size_records, 5000);
  assert.equal(result.replication.jobs[0].shutdown_timeout_ms, 30000);
});

test('enabled=false job 처리', async () => {
  const config = structuredClone(BASE_CONFIG);
  config.replication.jobs[0].enabled = false;
  const filePath = await writeConfig(config);
  const result = await ConfigLoader.load(filePath);
  assert.equal(result.replication.jobs[0].enabled, false);
});
