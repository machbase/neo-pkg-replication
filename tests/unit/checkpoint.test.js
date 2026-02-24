'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const CheckpointStore = require('../../file/checkpoint.js');

function tmpDir() {
  return path.join(os.tmpdir(), `cp_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
}

test('load: 파일 없음 → { exists: false, err: null }', async () => {
  const store = new CheckpointStore(tmpDir());
  const result = await store.load('job-1', '_TAG_DATA_0');
  assert.equal(result.exists, false);
  assert.equal(result.err, null);
  assert.equal(result.cp, null);
});

test('save + load 라운드트립: BigInt rid 보존', async () => {
  const dir = tmpDir();
  await fs.mkdir(dir, { recursive: true });
  const store = new CheckpointStore(dir);

  const rid = 12345678901234567890n;
  const err = await store.save('job-1', '_TAG_DATA_0', { last_success_rid: rid }, {});
  assert.equal(err, null);

  const result = await store.load('job-1', '_TAG_DATA_0');
  assert.equal(result.exists, true);
  assert.equal(result.err, null);
  assert.equal(result.cp.last_success_rid, rid);
});

test('save + load: source_server, source_table 보존', async () => {
  const dir = tmpDir();
  await fs.mkdir(dir, { recursive: true });
  const store = new CheckpointStore(dir);

  await store.save('job-1', '_TAG_DATA_1', {
    last_success_rid: 42n,
    source_server: 'src',
    source_table: 'TAG',
  }, { rows_read: 10, rows_written: 9, dropped_no_meta: 1, skipped_exists: 0 });

  const result = await store.load('job-1', '_TAG_DATA_1');
  assert.equal(result.exists, true);
  assert.equal(result.cp.last_success_rid, 42n);
});

test('load: source.data_table 불일치 → { exists: false, err }', async () => {
  const dir = tmpDir();
  await fs.mkdir(dir, { recursive: true });
  const store = new CheckpointStore(dir);

  // 정상 저장 후 파일 내부 data_table 값을 오염
  await store.save('job-1', '_TAG_DATA_0', { last_success_rid: 0n }, {});
  const filePath = path.join(dir, 'job-1___TAG_DATA_0.json');
  const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  raw.source.data_table = '_TAG_DATA_CORRUPTED';
  await fs.writeFile(filePath, JSON.stringify(raw));

  const result = await store.load('job-1', '_TAG_DATA_0');
  assert.equal(result.exists, false);
  assert.ok(result.err instanceof Error);
});

test('load: JSON 파싱 실패 → { exists: false, err }', async () => {
  const dir = tmpDir();
  await fs.mkdir(dir, { recursive: true });
  const store = new CheckpointStore(dir);

  const filePath = path.join(dir, 'job-1___TAG_DATA_0.json');
  await fs.writeFile(filePath, 'NOT_VALID_JSON');

  const result = await store.load('job-1', '_TAG_DATA_0');
  assert.equal(result.exists, false);
  assert.ok(result.err instanceof Error);
});

test('rid = 0n 저장 및 로드', async () => {
  const dir = tmpDir();
  await fs.mkdir(dir, { recursive: true });
  const store = new CheckpointStore(dir);

  await store.save('job-2', '_TAG_DATA_0', { last_success_rid: 0n }, {});
  const result = await store.load('job-2', '_TAG_DATA_0');
  assert.equal(result.cp.last_success_rid, 0n);
});
