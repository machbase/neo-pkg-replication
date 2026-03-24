'use strict';

const http = require('http');
const process = require('process');

/**
 * conf.d/server.json에서 internalPort 읽기
 * 없으면 null 반환
 * @returns {number|null}
 */
function readInternalPort() {
  try {
    const path = require('path');
    const fs = require('fs');
    const raw = fs.readFileSync(path.join(process.cwd(), 'conf.d', 'server.json'), 'utf8');
    return JSON.parse(raw).internalPort || null;
  } catch (_) {
    return null;
  }
}

/**
 * AdminHttpServer로 요청 포워딩
 * @param {number} port
 * @param {string} method
 * @param {string} path
 * @param {Object} [body]
 * @returns {Promise<{ status: number, body: Object }>}
 */
function forward(port, method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      host: '127.0.0.1', port, method, path,
      headers: { 'Content-Type': 'application/json' },
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', (err) => resolve({ status: 503, body: { ok: false, reason: err.message } }));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * QUERY_STRING에서 파라미터 파싱
 * @returns {Object.<string, string>}
 */
function parseQuery() {
  const qs = process.env.QUERY_STRING || '';
  const result = {};
  for (const part of qs.split('&')) {
    const [k, v] = part.split('=');
    if (k) result[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return result;
}

/**
 * stdin에서 JSON body 읽기
 * @returns {Object}
 */
function readBody() {
  try {
    const raw = require('fs').readFileSync('/dev/stdin', 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

/**
 * CGI 응답 출력
 * @param {number} status
 * @param {Object} data
 */
function reply(status, data) {
  const body = JSON.stringify(data);
  process.stdout.write(`Status: ${status}\r\n`);
  process.stdout.write('Content-Type: application/json\r\n');
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
  process.stdout.write('\r\n');
  process.stdout.write(body);
}

module.exports = { readInternalPort, forward, parseQuery, readBody, reply };
