'use strict';

/**
 * @fileoverview 전체 테스트 일괄 실행 진입점
 *
 * client.test.js → table.test.js → replication.test.js 순서로 실행한다.
 * 사용법: jsh cgi-bin/tests/run_all.js
 */

const process = require('process');
const path = require('path');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));

// 모든 테스트를 순서대로 실행
require(TESTS_DIR + '/client.test.js');
require(TESTS_DIR + '/table.test.js');
require(TESTS_DIR + '/replication.test.js');
