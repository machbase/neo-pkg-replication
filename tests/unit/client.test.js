'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MachbaseClient } = require('../../src/db/client.js');

// fixDoubleEndian()은 MachbaseClient.query() 반환 직전에 적용됨.
// ts-client connection을 mock하여 손상된 값을 주입하고 복원 여부를 검증한다.

function makeMockClient(rows) {
  const client = new MachbaseClient({});
  // ts-client createConnection 결과를 mock으로 교체
  client.conn = {
    query: async () => [rows],
    end: async () => {},
  };
  return client;
}

// IEEE 754 LE→BE byte swap 헬퍼
function swapDoubleBE(value) {
  const buf = Buffer.allocUnsafe(8);
  buf.writeDoubleBE(value, 0);
  return buf.readDoubleLE(0); // LE로 읽으면 denormal
}

function swapFloatBE(value) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeFloatBE(value, 0);
  // ts-client가 4바이트 LE로 읽은 결과를 float32로 해석
  const tmp = Buffer.allocUnsafe(4);
  tmp.writeFloatLE(buf.readFloatLE(0), 0);
  return tmp.readFloatLE(0);
}

test('fixDoubleEndian: 정상 double 값은 변환되지 않음', async () => {
  const client = makeMockClient([{ value: 3200.0 }]);
  // 정상값은 denormal이 아니므로 그대로 통과
  const rows = await client.query('SELECT value FROM t');
  assert.equal(rows[0].value, 3200.0);
});

test('fixDoubleEndian: BE로 저장된 double → LE 오독 복원', async () => {
  const original = 3200.0;
  const corrupted = swapDoubleBE(original); // LE로 잘못 읽힌 denormal 값

  const client = makeMockClient([{ value: corrupted }]);
  const rows = await client.query('SELECT value FROM t');

  // 복원된 값이 원래 값과 충분히 가까워야 함
  assert.ok(Math.abs(rows[0].value - original) < 1e-6,
    `복원 실패: expected ~${original}, got ${rows[0].value}`);
});

test('fixDoubleEndian: 0, Infinity, NaN은 변환하지 않음', async () => {
  const client = makeMockClient([{ a: 0, b: Infinity, c: NaN, d: -Infinity }]);
  const rows = await client.query('SELECT * FROM t');
  assert.equal(rows[0].a, 0);
  assert.equal(rows[0].b, Infinity);
  assert.ok(Number.isNaN(rows[0].c));
  assert.equal(rows[0].d, -Infinity);
});

test('fixDoubleEndian: number 아닌 값은 변환하지 않음', async () => {
  const client = makeMockClient([{ name: 'sensor', time: 1000n, flag: true }]);
  const rows = await client.query('SELECT * FROM t');
  assert.equal(rows[0].name, 'sensor');
  assert.equal(rows[0].time, 1000n);
  assert.equal(rows[0].flag, true);
});
