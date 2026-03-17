'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const RetryHandler = require('../../src/lib/retry.js');

// ─── shouldRetry ─────────────────────────────────────────────────────────────

test('shouldRetry: 일반 Error → true', () => {
  const rh = new RetryHandler();
  assert.equal(rh.shouldRetry(new Error('network error')), true);
});

test('shouldRetry: err.retryable=false → false', () => {
  const rh = new RetryHandler();
  const err = Object.assign(new Error('config'), { retryable: false });
  assert.equal(rh.shouldRetry(err), false);
});


// ─── nextDelay ────────────────────────────────────────────────────────────────

test('exponential: attempt=0 → base_delay_ms', () => {
  const rh = new RetryHandler({ strategy: 'exponential', base_delay_ms: 1000, multiplier: 2, jitter: false });
  assert.equal(rh.nextDelay(0), 1000);
});

test('exponential: attempt=1 → initial * multiplier^1', () => {
  const rh = new RetryHandler({ strategy: 'exponential', base_delay_ms: 1000, multiplier: 2, jitter: false });
  assert.equal(rh.nextDelay(1), 2000);
});

test('exponential: attempt=3 → 8000', () => {
  const rh = new RetryHandler({ strategy: 'exponential', base_delay_ms: 1000, multiplier: 2, jitter: false });
  assert.equal(rh.nextDelay(3), 8000);
});

test('linear: attempt=0 → base_delay_ms', () => {
  const rh = new RetryHandler({ strategy: 'linear', base_delay_ms: 500, jitter: false });
  assert.equal(rh.nextDelay(0), 500);
});

test('linear: attempt=2 → initial * 3', () => {
  const rh = new RetryHandler({ strategy: 'linear', base_delay_ms: 500, jitter: false });
  assert.equal(rh.nextDelay(2), 1500);
});

test('max_delay_ms 상한 적용', () => {
  const rh = new RetryHandler({ strategy: 'exponential', base_delay_ms: 1000, multiplier: 10, max_delay_ms: 5000, jitter: false });
  assert.equal(rh.nextDelay(5), 5000); // 1000 * 10^5 = 100000 → 5000으로 제한
});

test('jitter=true → delay < 원본 delay', () => {
  const rh = new RetryHandler({ strategy: 'exponential', base_delay_ms: 1000, multiplier: 2, max_delay_ms: 60000, jitter: true });
  const delays = Array.from({ length: 20 }, () => rh.nextDelay(3));
  // jitter가 있으면 8000보다 작아야 함 (Math.random() < 1)
  assert.ok(delays.every(d => d <= 8000));
  // 거의 대부분 8000 미만 (랜덤이므로 최소 1개는 8000보다 작을 것)
  assert.ok(delays.some(d => d < 8000));
});

// ─── isExhausted ─────────────────────────────────────────────────────────────

test('isExhausted: max_attempts=null → 항상 false', () => {
  const rh = new RetryHandler({ max_attempts: null });
  assert.equal(rh.isExhausted(9999), false);
});

test('isExhausted: attempt >= max_attempts → true', () => {
  const rh = new RetryHandler({ max_attempts: 3 });
  assert.equal(rh.isExhausted(3), true);
  assert.equal(rh.isExhausted(10), true);
});

test('isExhausted: attempt < max_attempts → false', () => {
  const rh = new RetryHandler({ max_attempts: 3 });
  assert.equal(rh.isExhausted(2), false);
  assert.equal(rh.isExhausted(0), false);
});

// ─── sleepOrShutdown ─────────────────────────────────────────────────────────

test('sleepOrShutdown: 타임아웃 → "timeout"', async () => {
  const rh = new RetryHandler();
  const flag = { value: false };
  const result = await rh.sleepOrShutdown(50, flag);
  assert.equal(result, 'timeout');
});

test('sleepOrShutdown: shutdown flag set → "shutdown"', async () => {
  const rh = new RetryHandler();
  const flag = { value: false };
  setTimeout(() => { flag.value = true; }, 30);
  const result = await rh.sleepOrShutdown(5000, flag);
  assert.equal(result, 'shutdown');
});

test('sleepOrShutdown: 이미 shutdown이면 즉시 반환', async () => {
  const rh = new RetryHandler();
  const flag = { value: true };
  const start = Date.now();
  const result = await rh.sleepOrShutdown(5000, flag);
  assert.equal(result, 'shutdown');
  assert.ok(Date.now() - start < 200);
});
