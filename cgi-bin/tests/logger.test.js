'use strict';

/**
 * @fileoverview Logger 포맷 테스트
 *
 * 사용법: jsh cgi-bin/tests/logger.test.js
 */

const process = require('process');
const path = require('path');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));
const ROOT = path.resolve(TESTS_DIR, '..');

const { suite, test, assert, run } = require(TESTS_DIR + '/test.js');
const { Logger } = require(ROOT + '/src/lib/logger.js');

function formatLocalTime(date) {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join(':');
}

suite('Logger', () => {

  test('_format uses local timestamp', () => {
    const logger = new Logger({ level: 'debug', disable: true });
    const before = new Date();
    const line = logger._format('info', 'stage', { msg: 'local time test' });
    const after = new Date();
    const timestamp = extractTimestamp(line, 'stage');
    const time = timestamp.slice(11, 19);

    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [A-Z]{3}$/.test(timestamp), 'timestamp format mismatch');
    assert.ok(time === formatLocalTime(before) || time === formatLocalTime(after), 'timestamp should match local wall-clock time');
  });

});

run();

function extractTimestamp(line, stage) {
  const prefix = '[INFO] ';
  const suffix = '  ' + stage + '  ';
  return line.slice(prefix.length, line.indexOf(suffix));
}
