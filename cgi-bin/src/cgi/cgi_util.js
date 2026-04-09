'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const service = require('service');
const { MachbaseClient } = require('../db/client.js');
const { FLAG_METADATA, FLAG_PRIMARY, FLAG_BASETIME } = require('../db/types.js');

const SERVICE_NAME_PREFIX = '_rpl_';

const APP_DIR = process.cwd();
const CONF_DIR = path.join(APP_DIR, 'conf.d');
const DATA_DIR = path.join(APP_DIR, 'data');

class CGI {

  static read(name) {

  }

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
      normalized.target.autoCreate = CGI.isAutoCreateEnabled(normalized.target.autoCreate);
    }
    return normalized;
  }

  static writeConfig(name, config) {
    const normalized = CGI.normalizeConfigForSave(config);
    const filePath = CGI.configPath(name);
    fs.mkdirSync(CONF_DIR, { recursive: true });
    const tmpPath = `${filePath}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  static normalizeColumnName(value) {
    if (typeof value !== 'string') return value;
    const col = value.trim();
    return col ? col.toUpperCase() : col;
  }

  static dataColumnsByOrder(client, tableName) {
    return client.selectColumnsByTableName(tableName)
      .filter((c) => !c.NAME.startsWith('_') && !(c.FLAG & FLAG_METADATA));
  }

  static validateColumnOrderTypes(config) {
    const normalized = CGI.normalizeConfigForSave(config);
    const source = normalized?.source;
    const target = normalized?.target;
    const autoCreateEnabled = CGI.isAutoCreateEnabled(target?.autoCreate);
    if (!source || !target) {
      throw new Error('source/target config is required');
    }
    if (!source.table) {
      throw new Error('source.table is required');
    }
    const effectiveTargetTable = CGI.normalizeTableName(target.table) || CGI.normalizeTableName(source.table);
    if (!effectiveTargetTable) {
      throw new Error('target.table is required');
    }

    let srcClient = null;
    let dstClient = null;
    try {
      srcClient = new MachbaseClient(source);
      dstClient = new MachbaseClient(target);
      srcClient.connect();
      dstClient.connect();

      const sourceCols = CGI.dataColumnsByOrder(srcClient, source.table);
      const sourceType = srcClient.selectTableType(source.table).type;
      const targetType = dstClient.selectTableType(effectiveTargetTable).type;
      let targetCols;

      if (targetType === 'UNSUPPORTED') {
        if (autoCreateEnabled) {
          targetCols = sourceCols.slice();
        } else {
          throw new Error(`target table '${effectiveTargetTable}' not found`);
        }
      } else {
        targetCols = CGI.dataColumnsByOrder(dstClient, effectiveTargetTable);
      }

      if (sourceCols.length === 0) {
        throw new Error(`source table '${source.table}' has no data columns`);
      }
      if (targetCols.length === 0) {
        throw new Error(`target table '${effectiveTargetTable}' has no data columns`);
      }

      const sourceByName = {};
      for (const col of sourceCols) {
        sourceByName[col.NAME] = col;
      }

      let effectiveSourceCols;
      if (Array.isArray(source.columns) && source.columns.length > 0) {
        effectiveSourceCols = source.columns.map(CGI.normalizeColumnName);
        const unknown = effectiveSourceCols.filter((name) => !sourceByName[name]);
        if (unknown.length > 0) {
          throw new Error(`source.columns contains unknown columns: ${unknown.join(', ')}`);
        }
        if (sourceType === 'TAG') {
          const requiredCols = sourceCols
            .filter((c) => (c.FLAG & FLAG_METADATA) === 0 && ((c.FLAG & FLAG_PRIMARY) || (c.FLAG & FLAG_BASETIME)))
            .map((c) => c.NAME);
          const missing = requiredCols.filter((c) => !effectiveSourceCols.includes(c));
          if (missing.length > 0) {
            throw new Error(`source.columns missing required TAG key columns: ${missing.join(', ')}`);
          }
        }
      } else {
        effectiveSourceCols = sourceCols.map((c) => c.NAME);
      }

      if (effectiveSourceCols.length !== targetCols.length) {
        throw new Error(
          `column count mismatch: source(${effectiveSourceCols.length}) != target(${targetCols.length})`
        );
      }

      for (let i = 0; i < targetCols.length; i++) {
        const sourceName = effectiveSourceCols[i];
        const sourceCol = sourceByName[sourceName];
        const targetCol = targetCols[i];
        if (sourceCol.TYPE !== targetCol.TYPE) {
          throw new Error(
            `column type mismatch at index ${i}: source.${sourceName}(TYPE=${sourceCol.TYPE}) != target.${targetCol.NAME}(TYPE=${targetCol.TYPE})`
          );
        }
      }
    } finally {
      try { srcClient && srcClient.close(); } catch (_) {}
      try { dstClient && dstClient.close(); } catch (_) {}
    }
  }

  static deleteConfig(name) {
    return CGI.deleteFile(CGI.configPath(name));
  }

  static configExists(name) {
    try {
      return fs.statSync(CGI.configPath(name)).isFile();
    } catch (_) {
      return false;
    }
  }

  static isMissingFsError(err) {
    if (err && err.code === 'ENOENT') {
      return true;
    }
    const message = err && err.message ? String(err.message) : String(err || '');
    return message.indexOf('no such file') >= 0
      || message.indexOf('cannot find the file') >= 0
      || message.indexOf('cannot find the path') >= 0;
  }

  static deleteFile(filePath) {
    try {
      fs.unlinkSync(filePath);
      return null;
    } catch (err) {
      if (CGI.isMissingFsError(err)) {
        return null;
      }
      return err;
    }
  }

  static isAutoCreateEnabled(value) {
    if (value === true || value === 1) {
      return true;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1';
    }
    return false;
  }

  static removePath(targetPath) {
    if (typeof fs.rmSync === 'function') {
      try {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } catch (_) {}
      return;
    }

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
        if (entry === '.' || entry === '..') continue;
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
    const serviceName = String(name || '');
    if (serviceName.startsWith(SERVICE_NAME_PREFIX)) {
      return serviceName;
    }
    return `${SERVICE_NAME_PREFIX}${serviceName}`;
  }

  static serviceNames(name) {
    const rawName = String(name || '');
    const names = [];
    const seen = {};
    const push = (value) => {
      if (!value || seen[value]) return;
      seen[value] = true;
      names.push(value);
    };
    push(CGI.serviceName(rawName));
    if (rawName.startsWith(SERVICE_NAME_PREFIX)) {
      push(rawName.slice(SERVICE_NAME_PREFIX.length));
    } else {
      push(rawName);
    }
    return names;
  }

  static installedServiceNames(name) {
    const names = [];
    const seen = {};
    for (const serviceName of CGI.serviceNames(name)) {
      for (const serviceDir of CGI.getServiceDirectoryCandidates()) {
        const filePath = path.join(serviceDir, `${serviceName}.json`);
        try {
          if (fs.statSync(filePath).isFile() && !seen[serviceName]) {
            seen[serviceName] = true;
            names.push(serviceName);
          }
        } catch (_) {}
      }
    }
    return names;
  }

  static serviceNamesForControl(name) {
    const installed = CGI.installedServiceNames(name);
    if (installed.length > 0) {
      return installed;
    }
    return [CGI.serviceName(name)];
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
      for (const serviceName of CGI.serviceNames(name)) {
        const filePath = path.join(serviceDir, `${serviceName}.json`);
        if (!seen[filePath]) {
          seen[filePath] = true;
          result.push(filePath);
        }
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
    let firstErr = null;
    for (const filePath of CGI.getServiceDefinitionPaths(name)) {
      const err = CGI.deleteFile(filePath);
      if (!firstErr && err) {
        firstErr = err;
      }
    }
    return firstErr;
  }

  static getReplicationScriptPath() {
    return path.join(APP_DIR, 'replication.js');
  }

  static getServiceWorkingDir() {
    return APP_DIR;
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
    const names = CGI.serviceNamesForControl(name);
    const next = (index, lastErr) => {
      if (index >= names.length) {
        callback(lastErr || new Error(`service '${CGI.serviceName(name)}' does not exist`));
        return;
      }
      CGI.callService('status', [names[index]], (err, serviceInfo) => {
        if (err && CGI.isMissingServiceError(err)) {
          next(index + 1, err);
          return;
        }
        callback(err, serviceInfo);
      });
    };
    next(0, null);
  }

  static uninstallService(name, callback) {
    const names = CGI.serviceNamesForControl(name);
    const next = (index, firstErr) => {
      if (index >= names.length) {
        callback(firstErr);
        return;
      }
      CGI.callService('uninstall', [names[index]], (err) => {
        if (!err || CGI.isMissingServiceError(err)) {
          next(index + 1, firstErr);
          return;
        }
        next(index + 1, firstErr || err);
      });
    };
    next(0, null);
  }

  static startService(name, callback) {
    const names = CGI.serviceNamesForControl(name);
    const next = (index, lastErr) => {
      if (index >= names.length) {
        callback(lastErr || new Error(`service '${CGI.serviceName(name)}' does not exist`));
        return;
      }
      CGI.callService('start', [names[index]], (err) => {
        if (err && CGI.isMissingServiceError(err)) {
          next(index + 1, err);
          return;
        }
        callback(err);
      });
    };
    next(0, null);
  }

  static stopService(name, callback) {
    const names = CGI.serviceNamesForControl(name);
    const next = (index, lastErr) => {
      if (index >= names.length) {
        callback(lastErr || new Error(`service '${CGI.serviceName(name)}' does not exist`));
        return;
      }
      CGI.callService('stop', [names[index]], (err) => {
        if (err && CGI.isMissingServiceError(err)) {
          next(index + 1, err);
          return;
        }
        callback(err);
      });
    };
    next(0, null);
  }

  static isMissingServiceError(err) {
    const message = err && err.message ? String(err.message) : '';
    return message.indexOf('does not exist') >= 0
      || message.indexOf('not found') >= 0;
  }

  static isServiceRunningStatus(serviceInfo) {
    const status = serviceInfo && serviceInfo.status ? String(serviceInfo.status).toUpperCase() : '';
    return status === 'RUNNING';
  }

  static restartServiceIfRunning(name, callback) {
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
    return fs.existsSync(path.join(APP_DIR, `${name}.pid`));
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
