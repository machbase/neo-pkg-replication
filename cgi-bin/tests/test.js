'use strict';

/**
 * @fileoverview 경량 jsh 테스트 프레임워크
 *
 * 사용 예:
 *   const { suite, test, assert, run } = require('./test.js');
 *   suite('MyModule', () => {
 *     test('it works', () => { assert.ok(true); });
 *   });
 *   run();
 */

const process = require('process');
const path = require('path');

// cgi-bin/ 루트 경로
// argv[1] = 'cgi-bin/tests/test.js' (상대경로) -> resolve -> /work/cgi-bin/tests
// ROOT = /work/cgi-bin
const ROOT = path.resolve(path.dirname(process.argv[1]), '..');

/**
 * src/ 하위 경로를 절대경로로 변환한다.
 * @param {string} p
 * @returns {string}
 */
function src(p)   { return path.join(ROOT, 'src', p); }

/**
 * tests/ 하위 경로를 절대경로로 변환한다.
 * @param {string} p
 * @returns {string}
 */
function tests(p) { return path.join(ROOT, 'tests', p); }

/** @type {Array<{ name: string, tests: Array }>} */
let _suites = [];
/** @type {{ name: string, tests: Array }|null} */
let _currentSuite = null;

/**
 * 테스트 스위트를 등록한다.
 * @param {string} name - 스위트 이름
 * @param {function(): void} fn - 스위트 본문 (test() 호출 포함)
 */
function suite(name, fn) {
  const s = { name, tests: [] };
  _suites.push(s);
  const prev = _currentSuite;
  _currentSuite = s;
  fn();
  _currentSuite = prev;
}

/**
 * 현재 스위트에 테스트 케이스를 등록한다.
 * @param {string} name - 테스트 이름
 * @param {function(): void|Promise<void>} fn - 테스트 본문
 */
function test(name, fn) {
  if (!_currentSuite) throw new Error('test() must be called inside suite()');
  _currentSuite.tests.push({ name, fn });
}

/**
 * 등록된 모든 스위트와 테스트를 순서대로 실행하고 결과를 출력한다.
 * 실패한 테스트가 있으면 process.exit(1)을 호출한다.
 * @returns {Promise<void>}
 */
async function run() {
  let totalPass = 0;
  let totalFail = 0;

  const suitesToRun = _suites.splice(0);

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

/**
 * 단언(assertion) 유틸리티
 * @namespace assert
 */
const assert = {
  /**
   * val이 truthy인지 확인한다.
   * @param {*} val
   * @param {string} [msg]
   */
  ok(val, msg) {
    if (!val) throw new Error(msg || `Expected truthy, got: ${val}`);
  },
  /**
   * actual === expected 인지 확인한다.
   * @param {*} actual
   * @param {*} expected
   * @param {string} [msg]
   */
  equal(actual, expected, msg) {
    if (actual !== expected)
      throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  },
  /**
   * actual !== expected 인지 확인한다.
   * @param {*} actual
   * @param {*} expected
   * @param {string} [msg]
   */
  notEqual(actual, expected, msg) {
    if (actual === expected)
      throw new Error(msg || `Expected not equal to ${JSON.stringify(expected)}`);
  },
  /**
   * actual과 expected를 JSON 직렬화하여 동등한지 확인한다.
   * @param {*} actual
   * @param {*} expected
   * @param {string} [msg]
   */
  deepEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
      throw new Error(msg || `Expected ${e}, got ${a}`);
  },
  /**
   * fn이 예외를 던지는지 확인한다.
   * @param {function(): void} fn
   * @param {string} [msg]
   */
  throws(fn, msg) {
    try { fn(); } catch (_) { return; }
    throw new Error(msg || 'Expected function to throw');
  },
  /**
   * fn이 Promise를 reject하는지 확인한다.
   * @param {function(): Promise<void>} fn
   * @param {string} [msg]
   */
  async rejects(fn, msg) {
    try { await fn(); } catch (_) { return; }
    throw new Error(msg || 'Expected async function to reject');
  },
};

module.exports = { suite, test, assert, run, src, tests, ROOT };
