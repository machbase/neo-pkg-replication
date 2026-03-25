'use strict';

// 테스트용 DB 접속 정보
const SRC = {
  host: '192.168.1.183',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

const DST = {
  host: '192.168.1.183',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

// 테스트용 테이블명 (실제 DB에 존재해야 함)
const SRC_TABLE  = 'TAG';
const DST_TABLE  = 'TAG_TEST_COPY';

module.exports = { SRC, DST, SRC_TABLE, DST_TABLE };
