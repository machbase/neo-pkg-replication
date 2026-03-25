'use strict';

const process = require('process');
const path = require('path');
const TESTS_DIR = path.resolve(path.dirname(process.argv[1]));

// 모든 테스트를 순서대로 실행
require(TESTS_DIR + '/client.test.js');
require(TESTS_DIR + '/table.test.js');
require(TESTS_DIR + '/replication.test.js');
