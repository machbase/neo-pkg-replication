'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const service = require('service');
const { MachbaseClient, ColumnType } = require('../db/client.js');
const { FLAG_METADATA, FLAG_PRIMARY, FLAG_BASETIME, FLAG_SUMMARIZED } = require('../db/types.js');

const SERVICE_NAME_PREFIX = '_rpl_';

const APP_DIR = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/'));
const CONF_DIR = path.join(APP_DIR, 'conf.d');
const DATA_DIR = path.join(APP_DIR, 'data');

class Handler {

  // ── 파일 유틸 ──────────────────────────────────────────────────────────────

  static exists(filePath) {
    try {
      return fs.statSync(filePath).isFile();
    } catch (_) {
      return false;
    }
  }

  static _read(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  /**
   * tmp 파일에 먼저 쓴 뒤 rename으로 교체한다 (atomic write).
   * @param {string} filePath
   * @param {string} data
   */
  static _write(filePath, data) {
    const tmpPath = `${filePath}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * 파일을 삭제한다. 삭제 성공 또는 파일이 이미 없으면 null, 그 외 오류는 err를 반환한다.
   * @param {string} filePath
   * @returns {Error|null}
   */
  static _delete(filePath) {
    try {
      fs.unlinkSync(filePath);
      return null;
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err || '');
      const isMissing = (err && err.code === 'ENOENT')
        || message.indexOf('no such file') >= 0
        || message.indexOf('cannot find the file') >= 0
        || message.indexOf('cannot find the path') >= 0;
      return isMissing ? null : err;
    }
  }

  // ── conf.d CRUD ─────────────────────────────────────────────────────────────

  static getConfigList() {
    try {
      return fs.readdirSync(CONF_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''));
    } catch (_) {
      return [];
    }
  }

  static getConfig(name) {
    const filePath = path.join(CONF_DIR, `${name}.json`);
    return Handler._read(filePath);
  }

  static writeConfig(name, config) {
    const filePath = path.join(CONF_DIR, `${name}.json`);
    const normalized = Handler.normalizeConfigForSave(config);
    const data = JSON.stringify(normalized, null, 2);
    Handler._write(filePath, data);
  }

  static removeConfig(name) {
    const filePath = path.join(CONF_DIR, `${name}.json`);
    return Handler._delete(filePath);
  }

  static existsConfig(name) {
    const filePath = path.join(CONF_DIR, `${name}.json`);
    return Handler.exists(filePath);
  }

  // ── 정규화 / 검증 ─────────────────────────────────────────────────────────

  static normalizeTableName(value) {
    if (typeof value !== 'string') return value;
    const table = value.trim();
    return table ? table.toUpperCase() : table;
  }

  static normalizeColumnName(value) {
    if (typeof value !== 'string') return value;
    const col = value.trim();
    return col ? col.toUpperCase() : col;
  }

  static normalizeConfigForSave(config) {
    if (!config || typeof config !== 'object') return config;

    const normalized = { ...config };
    if (config.source && typeof config.source === 'object') {
      normalized.source = { ...config.source };
      normalized.source.table = Handler.normalizeTableName(normalized.source.table);
    }
    if (config.target && typeof config.target === 'object') {
      normalized.target = { ...config.target };
      normalized.target.table = Handler.normalizeTableName(normalized.target.table);
      normalized.target.autoCreate = Handler.isAutoCreateEnabled(normalized.target.autoCreate);
    }
    return normalized;
  }

  static isAutoCreateEnabled(value) {
    if (value === true || value === 1) return true;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1';
    }
    return false;
  }

  /**
   * 내부 컬럼(_로 시작)과 메타데이터 컬럼을 제외한 데이터 컬럼을 순서대로 반환한다.
   * @param {MachbaseClient} client
   * @param {string} tableName
   * @returns {object[]}
   */
  static dataColumnsByOrder(client, tableName) {
    return client.selectColumnsByTableName(tableName)
      .filter((c) => !c.NAME.startsWith('_') && !(c.FLAG & FLAG_METADATA));
  }

  /**
   * source/target 데이터 컬럼을 순서 기준으로 타입을 검증한다. 불일치 시 throw한다.
   * @param {object} config - ReplicatorConfig
   * @throws {Error}
   */
  static validateColumnOrderTypes(config) {
    const normalized = Handler.normalizeConfigForSave(config);
    const source = normalized?.source;
    const target = normalized?.target;
    const autoCreateEnabled = Handler.isAutoCreateEnabled(target?.autoCreate);
    if (!source || !target) {
      throw new Error('source/target config is required');
    }
    if (!source.table) {
      throw new Error('source.table is required');
    }
    const effectiveTargetTable = Handler.normalizeTableName(target.table) || Handler.normalizeTableName(source.table);
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

      const sourceCols = Handler.dataColumnsByOrder(srcClient, source.table);
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
        targetCols = Handler.dataColumnsByOrder(dstClient, effectiveTargetTable);
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
        effectiveSourceCols = source.columns.map(Handler.normalizeColumnName);
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

  // ── CGI I/O ──────────────────────────────────────────────────────────────

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

  // ── service 제어 (low-level) ──────────────────────────────────────────────

  static serviceName(name) {
    const serviceName = String(name || '');
    if (serviceName.startsWith(SERVICE_NAME_PREFIX)) {
      return serviceName;
    }
    return `${SERVICE_NAME_PREFIX}${serviceName}`;
  }

  /**
   * prefixed(_rpl_xxx)와 bare(xxx) 양쪽 이름을 반환한다.
   * 설치 여부와 무관하게 양쪽 형태로 탐색할 때 사용한다.
   * @param {string} name
   * @returns {string[]}
   */
  static serviceNames(name) {
    const rawName = String(name || '');
    const names = [];
    const seen = {};
    const push = (value) => {
      if (!value || seen[value]) return;
      seen[value] = true;
      names.push(value);
    };
    push(Handler.serviceName(rawName));
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
    for (const serviceName of Handler.serviceNames(name)) {
      for (const serviceDir of Handler.getServiceDirectoryCandidates()) {
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

  /**
   * start/stop/status 등 제어에 쓸 service 이름 목록을 반환한다.
   * 실제 설치된 이름을 우선하고, 없으면 canonical prefixed 이름으로 폴백한다.
   * @param {string} name
   * @returns {string[]}
   */
  static serviceNamesForControl(name) {
    const installed = Handler.installedServiceNames(name);
    if (installed.length > 0) {
      return installed;
    }
    return [Handler.serviceName(name)];
  }

  /**
   * service 정의 파일을 탐색할 후보 디렉토리 목록을 반환한다.
   * /etc/services → {neoHome}/etc/services 순서로 중복 없이 반환한다.
   * @returns {string[]}
   */
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

    const execPath = process.execPath || process.argv[0] || '';
    if (execPath && path.isAbsolute(execPath)) {
      push(path.join(path.dirname(execPath), 'etc', 'services'));
    }

    return result;
  }

  static getServiceDefinitionPaths(name) {
    const result = [];
    const seen = {};
    for (const serviceDir of Handler.getServiceDirectoryCandidates()) {
      for (const serviceName of Handler.serviceNames(name)) {
        const filePath = path.join(serviceDir, `${serviceName}.json`);
        if (!seen[filePath]) {
          seen[filePath] = true;
          result.push(filePath);
        }
      }
    }
    return result;
  }

  static hasInstalledService(name) {
    for (const filePath of Handler.getServiceDefinitionPaths(name)) {
      try {
        if (fs.statSync(filePath).isFile()) return true;
      } catch (_) {}
    }
    return false;
  }

  static deleteServiceDefinition(name) {
    let firstErr = null;
    for (const filePath of Handler.getServiceDefinitionPaths(name)) {
      const err = Handler._delete(filePath);
      if (!firstErr && err) firstErr = err;
    }
    return firstErr;
  }

  static buildServiceInstallConfig(name) {
    return {
      name: Handler.serviceName(name),
      enable: false,
      working_dir: APP_DIR,
      executable: path.join(APP_DIR, 'cgi-bin', 'replication.js'),
      args: [name],
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
    Handler.callService('install', [Handler.buildServiceInstallConfig(name)], callback);
  }

  static getServiceStatus(name, callback) {
    const names = Handler.serviceNamesForControl(name);
    const next = (index, lastErr) => {
      if (index >= names.length) {
        callback(lastErr || new Error(`service '${Handler.serviceName(name)}' does not exist`));
        return;
      }
      Handler.callService('status', [names[index]], (err, serviceInfo) => {
        if (err && Handler.isMissingServiceError(err)) {
          next(index + 1, err);
          return;
        }
        callback(err, serviceInfo);
      });
    };
    next(0, null);
  }

  static uninstallService(name, callback) {
    const names = Handler.serviceNamesForControl(name);
    const next = (index, firstErr) => {
      if (index >= names.length) {
        callback(firstErr);
        return;
      }
      Handler.callService('uninstall', [names[index]], (err) => {
        if (!err || Handler.isMissingServiceError(err)) {
          next(index + 1, firstErr);
          return;
        }
        next(index + 1, firstErr || err);
      });
    };
    next(0, null);
  }

  static startService(name, callback) {
    const names = Handler.serviceNamesForControl(name);
    const next = (index, lastErr) => {
      if (index >= names.length) {
        callback(lastErr || new Error(`service '${Handler.serviceName(name)}' does not exist`));
        return;
      }
      Handler.callService('start', [names[index]], (err) => {
        if (err && Handler.isMissingServiceError(err)) {
          next(index + 1, err);
          return;
        }
        callback(err);
      });
    };
    next(0, null);
  }

  static stopService(name, callback) {
    const names = Handler.serviceNamesForControl(name);
    const next = (index, lastErr) => {
      if (index >= names.length) {
        callback(lastErr || new Error(`service '${Handler.serviceName(name)}' does not exist`));
        return;
      }
      Handler.callService('stop', [names[index]], (err) => {
        if (err && Handler.isMissingServiceError(err)) {
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

  /**
   * service가 RUNNING 상태일 때만 stop → start를 수행한다.
   * service가 없거나 실행 중이 아니면 err 없이 false를 전달한다.
   * @param {string} name
   * @param {function(Error|null, boolean)} callback - (err, restarted)
   */
  static restartServiceIfRunning(name, callback) {
    Handler.getServiceStatus(name, (err, serviceInfo) => {
      if (err) {
        callback(Handler.isMissingServiceError(err) ? null : err, false);
        return;
      }
      if (!Handler.isServiceRunningStatus(serviceInfo)) {
        callback(null, false);
        return;
      }
      Handler.stopService(name, (stopErr) => {
        if (stopErr) { callback(stopErr); return; }
        Handler.startService(name, (startErr) => {
          callback(startErr || null, !startErr);
        });
      });
    });
  }

  /**
   * service가 RUNNING 상태일 때만 stop을 수행한다.
   * service가 없거나 실행 중이 아니면 err 없이 false를 전달한다.
   * @param {string} name
   * @param {function(Error|null, boolean)} callback - (err, stopped)
   */
  static stopServiceIfRunning(name, callback) {
    Handler.getServiceStatus(name, (err, serviceInfo) => {
      if (err) {
        callback(Handler.isMissingServiceError(err) ? null : err, false);
        return;
      }
      if (!Handler.isServiceRunningStatus(serviceInfo)) {
        callback(null, false);
        return;
      }
      Handler.stopService(name, (stopErr) => {
        callback(stopErr || null, !stopErr);
      });
    });
  }

  // ── checkpoint ───────────────────────────────────────────────────────────

  /**
   * checkpoint 디렉토리들을 훑어 파티션별 checkpoint 상태를 반환한다.
   * checkpoint 파일이 없는 파티션도 빈 값으로 포함한다.
   * @param {string} name - replicator name
   * @param {object} config - replicator config
   * @returns {{ [dataTable: string]: { lastSuccessRid: string, hasMore: boolean } }}
   */
  static readCheckpoints(name, config) {
    const result = {};

    // source 파티션 목록으로 result 초기화
    const source = config?.source;
    const logicalTable = source?.table;
    if (source && logicalTable) {
      let client = null;
      try {
        const normalizedTable = String(logicalTable).toUpperCase();
        client = new MachbaseClient({ ...source, table: normalizedTable });
        client.connect();
        const tableType = client.selectTableType(normalizedTable).type;
        const seen = {};
        const push = (value) => {
          if (typeof value !== 'string') return;
          const dataTable = value.trim();
          if (!dataTable || seen[dataTable]) return;
          seen[dataTable] = true;
          result[dataTable] = { lastSuccessRid: '', hasMore: false };
        };
        if (tableType === 'TAG') {
          for (const part of client.selectTagDataTables(normalizedTable)) {
            push(part?.data_table);
          }
        } else if (tableType === 'LOG') {
          push(normalizedTable);
        }
      } catch (_) {
        // checkpoint 조회는 best-effort로 동작한다.
      } finally {
        try { client && client.close(); } catch (_) {}
      }
    }

    // checkpoint 파일 병합
    if (name && typeof name === 'string' && name.trim()) {
      const dirPath = path.join(DATA_DIR, name.trim());
      let files;
      try {
        files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
      } catch (_) {
        files = [];
      }
      const records = {};
      for (const f of files) {
        try {
          const filePath = path.join(dirPath, f);
          const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const dataTable = d.source?.dataTable;
          const lastSuccessRid = d.checkpoint?.lastSuccessRid;
          if (!dataTable || lastSuccessRid === undefined) continue;
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
      for (const dataTable in records) {
        result[dataTable] = {
          lastSuccessRid: records[dataTable].lastSuccessRid,
          hasMore: records[dataTable].hasMore === true,
        };
      }
    }

    return result;
  }

  // ── 비즈니스 로직 ─────────────────────────────────────────────────────────

  static _applyPasswordFallback(nextConfig, currentConfig) {
    if (!nextConfig || typeof nextConfig !== 'object') return nextConfig;

    const nextSource = nextConfig.source;
    const nextTarget = nextConfig.target;
    const hasOwn = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

    if (nextSource && typeof nextSource === 'object') {
      if ((!hasOwn(nextSource, 'password') || nextSource.password === '') && hasOwn(currentConfig?.source, 'password')) {
        nextSource.password = currentConfig.source.password;
      }
    }
    if (nextTarget && typeof nextTarget === 'object') {
      if ((!hasOwn(nextTarget, 'password') || nextTarget.password === '') && hasOwn(currentConfig?.target, 'password')) {
        nextTarget.password = currentConfig.target.password;
      }
    }
    return nextConfig;
  }

  static createReplicator(body, callback) {
    if (!body.name) { callback(new Error('name is required')); return; }
    if (!body.config) { callback(new Error('config is required')); return; }
    if (Handler.getConfig(body.name)) { callback(new Error(`replicator '${body.name}' already exists`)); return; }
    try {
      Handler.validateColumnOrderTypes(body.config);
    } catch (err) {
      callback(err);
      return;
    }
    Handler.writeConfig(body.name, body.config);
    Handler.installService(body.name, (err) => {
      if (err) {
        Handler.removeConfig(body.name);
        callback(err);
      } else {
        callback(null, { name: body.name });
      }
    });
  }

  static getReplicator(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    const config = Handler.getConfig(name);
    if (!config) { callback(new Error(`replicator '${name}' not found`)); return; }
    const safeSource = { ...config.source };
    delete safeSource.password;
    const safeTarget = { ...config.target };
    delete safeTarget.password;
    const safeConfig = { ...config, source: safeSource, target: safeTarget };
    const sourceTable = config.source?.table || '';
    const targetTable = config.target?.table || sourceTable;
    const replicatorId = config.id || (sourceTable && targetTable ? `${sourceTable}_${targetTable}` : '');
    const checkpoints = Handler.readCheckpoints(replicatorId, config);
    callback(null, { name, config: safeConfig, checkpoints });
  }

  static updateReplicator(name, body, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    const currentConfig = Handler.getConfig(name);
    if (!currentConfig) { callback(new Error(`replicator '${name}' not found`)); return; }
    const nextConfig = Handler._applyPasswordFallback(body, currentConfig);
    try {
      Handler.validateColumnOrderTypes(nextConfig);
    } catch (err) {
      callback(err);
      return;
    }
    Handler.writeConfig(name, nextConfig);
    Handler.restartServiceIfRunning(name, callback);
  }

  static deleteReplicator(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    const config = Handler.getConfig(name);
    if (!config) { callback(new Error(`replicator '${name}' not found`)); return; }
    Handler.stopServiceIfRunning(name, (stopErr) => {
      if (stopErr) { callback(stopErr); return; }
      Handler.uninstallService(name, (err) => {
        if (err && !Handler.isMissingServiceError(err)) { callback(err); return; }
        const serviceDefinitionErr = Handler.deleteServiceDefinition(name);
        const pidPath = path.join(APP_DIR, `${name}.pid`);
        const pidErr = Handler._delete(pidPath);
        const configErr = Handler.removeConfig(name);
        const sourceTable = config.source?.table || '';
        const targetTable = config.target?.table || sourceTable;
        const replicatorId = config.id || (sourceTable && targetTable ? `${sourceTable}_${targetTable}` : '');
        if (replicatorId && replicatorId.trim()) {
          const checkpointDir = path.join(DATA_DIR, replicatorId.trim());
          try { fs.rmSync(checkpointDir, { recursive: true, force: true }); } catch (_) {}
        }
        if (serviceDefinitionErr) { callback(serviceDefinitionErr); return; }
        if (pidErr) { callback(pidErr); return; }
        if (configErr) { callback(configErr); return; }
        if (Handler.existsConfig(name)) { callback(new Error(`failed to delete config '${name}'`)); return; }
        callback(null);
      });
    });
  }

  static installReplicator(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    if (!Handler.getConfig(name)) { callback(new Error(`replicator '${name}' not found`)); return; }
    if (Handler.hasInstalledService(name)) { callback(new Error(`replicator '${name}' already installed`)); return; }
    Handler.installService(name, callback);
  }

  static startReplicator(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    if (!Handler.getConfig(name)) { callback(new Error(`replicator '${name}' not found`)); return; }
    Handler.startService(name, callback);
  }

  static stopReplicator(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    if (!Handler.getConfig(name)) { callback(new Error(`replicator '${name}' not found`)); return; }
    Handler.stopService(name, (err) => {
      if (err) { callback(err); return; }
      const pidPath = path.join(APP_DIR, `${name}.pid`);
      Handler._delete(pidPath);
      callback(null);
    });
  }

  static listReplicators(callback) {
    const names = Handler.getConfigList();
    const data = [];
    const next = (index) => {
      if (index >= names.length) { callback(null, data); return; }
      const name = names[index];
      const installed = Handler.hasInstalledService(name);
      Handler.getServiceStatus(name, (err, serviceInfo) => {
        if (err) {
          const pidPath = path.join(APP_DIR, `${name}.pid`);
          data.push({ name, installed, running: installed ? Handler.exists(pidPath) : false });
        } else {
          data.push({ name, installed: true, running: Handler.isServiceRunningStatus(serviceInfo) });
        }
        next(index + 1);
      });
    };
    next(0);
  }

  static getTableColumns(body, callback) {
    const { host, port, user, password, table } = body;
    if (!host)     { callback(new Error('host is required')); return; }
    if (!port)     { callback(new Error('port is required')); return; }
    if (!user)     { callback(new Error('user is required')); return; }
    if (!password) { callback(new Error('password is required')); return; }
    if (!table)    { callback(new Error('table is required')); return; }
    const client = new MachbaseClient({ host, port: parseInt(port, 10), user, password });
    try {
      client.connect();
      const { type: tableType } = client.selectTableType(table.toUpperCase());
      if (tableType === 'UNSUPPORTED') {
        callback(new Error(`table '${table}' not found`));
        return;
      }
      const rows = client.selectColumnsByTableName(table.toUpperCase());
      const columns = rows.map(r => {
        const colType = ColumnType.fromCode(r.TYPE);
        const sqlType = colType.ddlType !== null ? colType.ddlType : `VARCHAR(${r.LENGTH})`;
        return {
          name:         r.NAME,
          type:         sqlType,
          isPrimary:    !!(r.FLAG & FLAG_PRIMARY),
          isBasetime:   !!(r.FLAG & FLAG_BASETIME),
          isSummarized: !!(r.FLAG & FLAG_SUMMARIZED),
          isMetadata:   !!(r.FLAG & FLAG_METADATA),
        };
      });
      callback(null, { table: table.toUpperCase(), tableType, columns });
    } catch (err) {
      callback(err);
    } finally {
      client.close();
    }
  }
}

module.exports = Handler;
module.exports.CONF_DIR = CONF_DIR;
module.exports.DATA_DIR = DATA_DIR;
