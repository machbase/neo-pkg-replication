'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const service = require('service');
const { MachbaseClient } = require('../db/client.js');

const _argv = process.argv[1];
const ROOT = _argv.slice(0, _argv.lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const APP_ROOT = path.dirname(ROOT);
const CONF_DIR = path.join(ROOT, 'conf.d');
const RUN_DIR  = path.join(ROOT, 'run');
const DATA_DIR = path.join(ROOT, 'data');

class CGI {

  // ── conf.d CRUD ─────────────────────────────────────────────────────────────

  static configPath(name) {
    return path.join(CONF_DIR, `${name}.json`);
  }

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
      const raw = fs.readFileSync(CGI.configPath(name), 'utf8');
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  static normalizeTableName(value) {
    if (typeof value !== 'string') return value;
    const table = value.trim();
    return table ? table.toUpperCase() : table;
  }

  static normalizeConfigForSave(config) {
    if (!config || typeof config !== 'object') return config;

    const normalized = { ...config };
    if (config.source && typeof config.source === 'object') {
      normalized.source = { ...config.source };
      normalized.source.table = CGI.normalizeTableName(normalized.source.table);
    }
    if (config.target && typeof config.target === 'object') {
      normalized.target = { ...config.target };
      normalized.target.table = CGI.normalizeTableName(normalized.target.table);
    }
    return normalized;
  }

  static writeConfig(name, config) {
    const normalized = CGI.normalizeConfigForSave(config);
    const filePath = CGI.configPath(name);
    const tmpPath = `${filePath}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  static deleteConfig(name) {
    try { fs.unlinkSync(CGI.configPath(name)); } catch (_) {}
  }

  static deletePid(name) {
    try { fs.unlinkSync(path.join(RUN_DIR, `${name}.pid`)); } catch (_) {}
  }

  static removePath(targetPath) {
    let stat;
    try {
      stat = fs.statSync(targetPath);
    } catch (_) {
      return;
    }

    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(targetPath);
      } catch (_) {}
      for (const entry of entries) {
        CGI.removePath(path.join(targetPath, entry));
      }
      try { fs.rmdirSync(targetPath); } catch (_) {}
      return;
    }

    try { fs.unlinkSync(targetPath); } catch (_) {}
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
      // TODO : enable, neo-regress pass를 위해 disalbe 처리함.
      //const len = parseInt(process.env.get('CONTENT_LENGTH') || '0', 10);
      //if (!len) return {};
      //const raw = process.stdin.read(len);
      const raw = process.stdin.read();
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

  // ── service 제어 ────────────────────────────────────────────────────────────

  static serviceName(name) {
    return name;
  }

  static getNeoHome() {
    const execPath = process.execPath || process.argv[0] || '';
    if (!execPath || !path.isAbsolute(execPath)) {
      return '';
    }
    return path.dirname(execPath);
  }

  static getServiceDirectoryCandidates() {
    const result = [];
    const seen = {};
    const push = (value) => {
      if (typeof value !== 'string') return;
      const dirPath = value.trim();
      if (!dirPath || seen[dirPath]) return;
      seen[dirPath] = true;
      result.push(dirPath);
    };

    push('/etc/services');

    const neoHome = CGI.getNeoHome();
    if (neoHome) {
      push(path.join(neoHome, 'etc', 'services'));
    }

    return result;
  }

  static getServiceDirectory() {
    for (const dir of CGI.getServiceDirectoryCandidates()) {
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory()) {
          return dir;
        }
      } catch (_) {}
    }
    return CGI.getServiceDirectoryCandidates()[0] || '';
  }

  static getServiceDefinitionPaths(name) {
    const result = [];
    const seen = {};
    for (const serviceDir of CGI.getServiceDirectoryCandidates()) {
      const filePath = path.join(serviceDir, `${CGI.serviceName(name)}.json`);
      if (!seen[filePath]) {
        seen[filePath] = true;
        result.push(filePath);
      }
    }
    return result;
  }

  static getServiceDefinitionPath(name) {
    const paths = CGI.getServiceDefinitionPaths(name);
    return paths.length > 0 ? paths[0] : '';
  }

  static hasInstalledService(name) {
    for (const filePath of CGI.getServiceDefinitionPaths(name)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  static deleteServiceDefinition(name) {
    for (const filePath of CGI.getServiceDefinitionPaths(name)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }

  static getReplicationScriptPath() {
    return path.join(ROOT, 'replication.js');
  }

  static getServiceWorkingDir() {
    return APP_ROOT;
  }

  static buildServiceInstallConfig(name) {
    const executable = CGI.getReplicationScriptPath();
    if (!executable) {
      throw new Error('replication.js path is not available');
    }
    return {
      name: CGI.serviceName(name),
      enable: false,
      working_dir: CGI.getServiceWorkingDir(),
      executable,
      args: [CGI.configPath(name)],
    };
  }

  static callService(method, args, callback) {
    if (!service || typeof service[method] !== 'function') {
      callback(new Error(`service.${method}() is not available`));
      return;
    }
    try {
      const callArgs = Array.isArray(args) ? args.slice() : [];
      callArgs.push(callback);
      service[method].apply(service, callArgs);
    } catch (err) {
      callback(err);
    }
  }

  static installService(name, callback) {
    CGI.callService('install', [CGI.buildServiceInstallConfig(name)], callback);
  }

  static getServiceStatus(name, callback) {
    CGI.callService('status', [CGI.serviceName(name)], callback);
  }

  static uninstallService(name, callback) {
    CGI.callService('uninstall', [CGI.serviceName(name)], callback);
  }

  static startService(name, callback) {
    CGI.callService('start', [CGI.serviceName(name)], callback);
  }

  static stopService(name, callback) {
    CGI.callService('stop', [CGI.serviceName(name)], callback);
  }

  static isMissingServiceError(err) {
    const message = err && err.message ? String(err.message) : '';
    return message.indexOf('does not exist') >= 0;
  }

  static isServiceRunningStatus(serviceInfo) {
    const status = serviceInfo && serviceInfo.status ? String(serviceInfo.status).toUpperCase() : '';
    return status === 'RUNNING';
  }

  static restartServiceIfRunning(name, callback) {
    CGI.getServiceStatus(name, (err, serviceInfo) => {
      if (err) {
        callback(err);
        return;
      }
      if (!CGI.isServiceRunningStatus(serviceInfo)) {
        callback(null, false);
        return;
      }
      CGI.stopService(name, (stopErr) => {
        if (stopErr) {
          callback(stopErr);
          return;
        }
        CGI.startService(name, (startErr) => {
          if (startErr) {
            callback(startErr);
          } else {
            callback(null, true);
          }
        });
      });
    });
  }

  static stopServiceIfRunning(name, callback) {
    CGI.getServiceStatus(name, (err, serviceInfo) => {
      if (err) {
        if (CGI.isMissingServiceError(err)) {
          callback(null, false);
        } else {
          callback(err);
        }
        return;
      }
      if (!CGI.isServiceRunningStatus(serviceInfo)) {
        callback(null, false);
        return;
      }
      CGI.stopService(name, (stopErr) => {
        if (stopErr) {
          callback(stopErr);
        } else {
          callback(null, true);
        }
      });
    });
  }

  // ── 실행 상태 / 체크포인트 ──────────────────────────────────────────────────

  static isRunning(name) {
    return fs.existsSync(path.join(RUN_DIR, `${name}.pid`));
  }

  /**
   * runtime이 사용하는 기본 replicator id
   * @param {object} config
   * @returns {string}
   */
  static defaultReplicatorId(config) {
    if (!config) return '';
    const sourceTable = config.source?.table || '';
    const targetTable = config.target?.table || sourceTable;
    if (!sourceTable || !targetTable) return '';
    return config.id || `${sourceTable}_${targetTable}`;
  }

  static listCheckpointDirs(name, config) {
    const result = [];
    const seen = {};
    const push = (value) => {
      if (typeof value !== 'string') return;
      const dirName = value.trim();
      if (!dirName || seen[dirName]) return;
      seen[dirName] = true;
      result.push(path.join(DATA_DIR, dirName));
    };
    push(name);
    push(config?.id);
    push(CGI.defaultReplicatorId(config));
    return result;
  }

  static deleteCheckpoints(name, config) {
    for (const dir of CGI.listCheckpointDirs(name, config)) {
      CGI.removePath(dir);
    }
  }

  static mergeCheckpointsFromDir(dir, records) {
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch (_) {
      return;
    }
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const dataTable = d.source?.dataTable;
        const lastSuccessRid = d.checkpoint?.lastSuccessRid;
        if (!dataTable || lastSuccessRid === undefined) {
          continue;
        }
        const updatedAt = d.checkpoint?.updatedAt || '';
        const initializedOnly = d.checkpoint?.initializedOnly === true;
        const ridText = String(lastSuccessRid);
        const isNegativeRid = /^-/.test(ridText);
        const hasMore = !initializedOnly && !isNegativeRid && d.checkpoint?.hasMore === true;
        const prev = records[dataTable];
        if (!prev || updatedAt >= prev.updatedAt) {
          records[dataTable] = {
            lastSuccessRid: initializedOnly || isNegativeRid ? '' : ridText,
            hasMore,
            updatedAt,
          };
        }
      } catch (_) {}
    }
  }

  static listSourcePartitions(config) {
    const result = [];
    const seen = {};
    const push = (value) => {
      if (typeof value !== 'string') return;
      const dataTable = value.trim();
      if (!dataTable || seen[dataTable]) return;
      seen[dataTable] = true;
      result.push(dataTable);
    };

    const source = config?.source;
    const logicalTable = source?.table;
    if (!source || !logicalTable) {
      return result;
    }

    let client = null;
    try {
      const normalizedTable = String(logicalTable).toUpperCase();
      const normalizedSource = { ...source, table: normalizedTable };
      client = new MachbaseClient(normalizedSource);
      client.connect();
      const tableType = client.selectTableType(normalizedTable).type;
      if (tableType === 'TAG') {
        const parts = client.selectTagDataTables(normalizedTable);
        for (const part of parts) {
          push(part?.data_table);
        }
      } else if (tableType === 'LOG') {
        push(normalizedTable);
      }
    } catch (_) {
      // checkpoint 조회는 best-effort로 동작한다.
    } finally {
      try {
        client && client.close();
      } catch (_) {}
    }

    return result;
  }

  /**
   * checkpoint 디렉토리들을 훑어 파티션별 checkpoint 상태를 반환한다.
   * checkpoint 파일이 없는 파티션도 빈 값으로 포함한다.
   * @param {string} name - replicator name
   * @param {object} config - replicator config
   * @returns {{ [dataTable: string]: { lastSuccessRid: string, hasMore: boolean } }}
   */
  static readCheckpoints(name, config) {
    const records = {};
    const result = {};
    for (const dataTable of CGI.listSourcePartitions(config)) {
      result[dataTable] = { lastSuccessRid: '', hasMore: false };
    }
    for (const dir of CGI.listCheckpointDirs(name, config)) {
      CGI.mergeCheckpointsFromDir(dir, records);
    }
    for (const dataTable in records) {
      result[dataTable] = {
        lastSuccessRid: records[dataTable].lastSuccessRid,
        hasMore: records[dataTable].hasMore === true,
      };
    }
    return result;
  }
}

module.exports = CGI;
