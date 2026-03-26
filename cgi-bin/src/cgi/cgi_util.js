'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');

const ROOT     = path.join(process.env.get('PWD'), 'cgi-bin');
const CONF_DIR = path.join(ROOT, 'conf.d');
const RUN_DIR  = path.join(ROOT, 'run');
const DATA_DIR = path.join(ROOT, 'data');

class CGI {

  // ── conf.d CRUD ─────────────────────────────────────────────────────────────

  static listConfigs() {
    try {
      return fs.readdirSync(CONF_DIR)
        .filter(f => f.endsWith('.json') && f !== 'server.json')
        .map(f => f.replace(/\.json$/, ''));
    } catch (_) {
      return [];
    }
  }

  static readConfig(name) {
    try {
      const raw = fs.readFileSync(path.join(CONF_DIR, `${name}.json`), 'utf8');
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  static writeConfig(name, config) {
    const filePath = path.join(CONF_DIR, `${name}.json`);
    const tmpPath = `${filePath}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  static deleteConfig(name) {
    try { fs.unlinkSync(path.join(CONF_DIR, `${name}.json`)); } catch (_) {}
  }

  // ── CGI 헬퍼 ──────────────────────────────────────────────────────────────

  static parseQuery() {
    const qs = process.env.get('QUERY_STRING') || '';
    const result = {};
    for (const part of qs.split('&')) {
      const [k, v] = part.split('=');
      if (k) result[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    return result;
  }

  static readBody() {
    try {
      const len = parseInt(process.env.get('CONTENT_LENGTH') || '0', 10);
      if (!len) return {};
      const raw = process.stdin.read(len);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  static reply(data) {
    const body = JSON.stringify(data);
    process.stdout.write('Content-Type: application/json\r\n');
    process.stdout.write('\r\n');
    process.stdout.write(body);
  }

  // ── 실행 상태 / 체크포인트 ──────────────────────────────────────────────────

  static isRunning(name) {
    return fs.existsSync(path.join(RUN_DIR, `${name}.pid`));
  }

  /**
   * 체크포인트 디렉토리에서 파티션별 lastSuccessRid 반환
   * @param {string} configId - config.id 또는 `{source.table}_{target.table}`
   * @returns {{ [dataTable: string]: string }}
   */
  static readCheckpoints(configId) {
    const dir = path.join(DATA_DIR, configId);
    const result = {};
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch (_) {
      return result;
    }
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (d.source?.dataTable && d.checkpoint?.lastSuccessRid !== undefined) {
          result[d.source.dataTable] = d.checkpoint.lastSuccessRid;
        }
      } catch (_) {}
    }
    return result;
  }
}

module.exports = CGI;
