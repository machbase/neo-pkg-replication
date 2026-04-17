'use strict';

const process = require('process');

function readEnv(name, fallback) {
  const value = process.env.get(name);
  return value == null || value === '' ? fallback : value;
}

function readEnvInt(name, fallback) {
  const value = readEnv(name, '');
  if (value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @fileoverview 테스트용 DB 접속 정보 및 테이블명 상수
 *
 * 기본값은 로컬 DB(127.0.0.1:5656)이며, 필요 시 환경변수로 덮어쓸 수 있다.
 */

/** @type {{ host: string, port: number, user: string, password: string }} 소스 DB 접속 정보 */
const SRC = {
  host: readEnv('RPL_TEST_SRC_HOST', '127.0.0.1'),
  port: readEnvInt('RPL_TEST_SRC_PORT', 5656),
  user: readEnv('RPL_TEST_SRC_USER', 'SYS'),
  password: readEnv('RPL_TEST_SRC_PASSWORD', 'MANAGER'),
};

/** @type {{ host: string, port: number, user: string, password: string }} 대상 DB 접속 정보 */
const DST = {
  host: readEnv('RPL_TEST_DST_HOST', SRC.host),
  port: readEnvInt('RPL_TEST_DST_PORT', SRC.port),
  user: readEnv('RPL_TEST_DST_USER', SRC.user),
  password: readEnv('RPL_TEST_DST_PASSWORD', SRC.password),
};

/** @type {string} 소스 테이블명 (기본값 `TAG`) */
const SRC_TABLE  = readEnv('RPL_TEST_SRC_TABLE', 'TAG');
/** @type {string} 대상 테이블명 (테스트 중 자동 생성/삭제됨) */
const DST_TABLE  = readEnv('RPL_TEST_DST_TABLE', 'TAG_TEST_COPY');

module.exports = { SRC, DST, SRC_TABLE, DST_TABLE };
