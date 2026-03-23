'use strict';

const process = require('process');
const path = require('path');
const ROOT = process.cwd();

// 모든 테스트를 순서대로 실행
require(path.join(ROOT, 'tests', 'client.test.js'));
require(path.join(ROOT, 'tests', 'table.test.js'));
require(path.join(ROOT, 'tests', 'replication.test.js'));
