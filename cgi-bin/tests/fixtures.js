'use strict';

/**
 * @fileoverview 테스트용 DB 접속 정보 및 테이블명 상수
 *
 * 실제 DB(192.168.1.183:5656)에 접속하여 통합 테스트를 수행한다.
 */

/** @type {{ host: string, port: number, user: string, password: string }} 소스 DB 접속 정보 */
const SRC = {
  host: '192.168.1.183',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

/** @type {{ host: string, port: number, user: string, password: string }} 대상 DB 접속 정보 */
const DST = {
  host: '192.168.1.183',
  port: 5656,
  user: 'SYS',
  password: 'MANAGER',
};

/** @type {string} 소스 테이블명 (실제 DB에 존재해야 함) */
const SRC_TABLE  = 'TAG';
/** @type {string} 대상 테이블명 (테스트 중 자동 생성/삭제됨) */
const DST_TABLE  = 'TAG_TEST_COPY';

module.exports = { SRC, DST, SRC_TABLE, DST_TABLE };
