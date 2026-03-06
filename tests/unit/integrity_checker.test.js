'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const IntegrityChecker = require('../../db/integrity_checker.js');

// ─── batchExists ─────────────────────────────────────────────────────────────

test('batchExists: 빈 rows → existSet 비어있음, err=null', async () => {
  const { existSet, err } = await IntegrityChecker.batchExists(null, 'TAG', []);
  assert.equal(err, null);
  assert.equal(existSet.size, 0);
});

test('batchExists: rows > 500 → { err } 반환 (throw 아님)', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ canonical: `tag_${i}`, time: BigInt(i) }));
  // client는 호출되어서는 안 됨 — null 전달
  const result = await IntegrityChecker.batchExists(null, 'TAG', rows);
  assert.ok(result.err instanceof Error, 'err가 Error 인스턴스여야 함');
  assert.match(result.err.message, /501.*>500/);
  assert.equal(result.existSet.size, 0);
});

test('batchExists: 존재하는 row → existSet에 key 포함', async () => {
  const rows = [
    { canonical: 'sensor_a', time: 1000n },
    { canonical: 'sensor_b', time: 2000n },
  ];
  const mockClient = {
    query: async () => [
      { name: 'sensor_a', time: 1000n },
    ],
  };
  const { existSet, err } = await IntegrityChecker.batchExists(mockClient, 'TAG', rows);
  assert.equal(err, null);
  assert.ok(existSet.has(IntegrityChecker.existKey('sensor_a', 1000n)));
  assert.ok(!existSet.has(IntegrityChecker.existKey('sensor_b', 2000n)));
});

test('batchExists: canonical에 null byte → existKey에서 throw', () => {
  assert.throws(
    () => IntegrityChecker.existKey('bad\x00key', 1000n),
    /null byte/
  );
});
