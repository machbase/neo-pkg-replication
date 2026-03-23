'use strict';

const process = require('process');
const path = require('path');

// /work (jsh cwd) 기준 절대경로 헬퍼
const ROOT = process.cwd();
function src(p) { return path.join(ROOT, 'src', p); }
function tests(p) { return path.join(ROOT, 'tests', p); }

/**
 * 경량 jsh 테스트 프레임워크
 *
 * 사용법:
 *   const { suite, test, assert } = require('./test.js');
 *   suite('MyModule', () => {
 *     test('something works', () => {
 *       assert.equal(1 + 1, 2);
 *     });
 *     test('async works', async () => {
 *       const result = await someAsyncFn();
 *       assert.ok(result);
 *     });
 *   });
 *   run();
 */

let _suites = [];
let _currentSuite = null;

function suite(name, fn) {
  const s = { name, tests: [] };
  _suites.push(s);
  const prev = _currentSuite;
  _currentSuite = s;
  fn();
  _currentSuite = prev;
}

function test(name, fn) {
  if (!_currentSuite) throw new Error('test() must be called inside suite()');
  _currentSuite.tests.push({ name, fn });
}

async function run() {
  let totalPass = 0;
  let totalFail = 0;

  const suitesToRun = _suites.splice(0); // 실행할 suite 가져오고 초기화 (중복 실행 방지)

  for (const s of suitesToRun) {
    console.println(`\n[${s.name}]`);
    for (const t of s.tests) {
      try {
        await t.fn();
        console.println(`  PASS  ${t.name}`);
        totalPass++;
      } catch (err) {
        console.error(`  FAIL  ${t.name}`);
        console.error(`        ${err.message}`);
        totalFail++;
      }
    }
  }

  console.println(`\n----------------------------------------`);
  console.println(`  Total: ${totalPass + totalFail}  Pass: ${totalPass}  Fail: ${totalFail}`);
  console.println(`----------------------------------------`);

  if (totalFail > 0) process.exit(1);
}

const assert = {
  ok(val, msg) {
    if (!val) throw new Error(msg || `Expected truthy, got: ${val}`);
  },
  equal(actual, expected, msg) {
    if (actual !== expected)
      throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  },
  notEqual(actual, expected, msg) {
    if (actual === expected)
      throw new Error(msg || `Expected not equal to ${JSON.stringify(expected)}`);
  },
  deepEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
      throw new Error(msg || `Expected ${e}, got ${a}`);
  },
  throws(fn, msg) {
    try { fn(); } catch (_) { return; }
    throw new Error(msg || 'Expected function to throw');
  },
  async rejects(fn, msg) {
    try { await fn(); } catch (_) { return; }
    throw new Error(msg || 'Expected async function to reject');
  },
};

module.exports = { suite, test, assert, run, src, tests, ROOT };
