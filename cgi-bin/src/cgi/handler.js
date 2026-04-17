'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const service = require('service');
const { MachbaseClient, ColumnType } = require('../db/client.js');
const { createQueryClient, MqttPublishClient } = require('../db/remote.js');
const { FLAG_METADATA, FLAG_PRIMARY, FLAG_BASETIME, FLAG_SUMMARIZED } = require('../db/types.js');
const {
  APP_DIR,
  CONF_DIR,
  DATA_DIR,
  SERVER_CONF_DIR,
  SERVICE_NAME_PREFIX,
  DEFAULT_LOG_DIR,
  normalizeTableName,
  normalizeColumnName,
  normalizeServerProfileForSave,
  sanitizeServerProfile,
  normalizeReplicatorConfigForSave,
  resolveEndpointConnection,
  resolveReplicatorRuntimeConfig,
  sanitizeReplicatorConfig,
} = require('./config.js');
const {
  prepareReplicatorConfig,
  validateServerProfile,
} = require('./validation.js');

const SERVICE_RETRY_DELAY_MS = 1000;
const SERVICE_RETRY_MAX_ATTEMPTS = 3;

/**
 * CGI 핸들러 — replicator 설정/서비스 생명주기 관리
 *
 * conf.d/ CRUD, service install/start/stop/uninstall, checkpoint 조회를 담당한다.
 * 모든 메서드는 static이다.
 */
class Handler {

  // ── 파일 유틸 ──────────────────────────────────────────────────────────────

  /**
   * 파일이 존재하는지 확인한다.
   * @param {string} filePath
   * @returns {boolean}
   */
  static exists(filePath) {
    try {
      return fs.statSync(filePath).isFile();
    } catch (_) {
      return false;
    }
  }

  /**
   * JSON 파일을 읽어 파싱한다. 실패하면 null을 반환한다.
   * @param {string} filePath
   * @returns {object|null}
   */
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

  /**
   * 로그 디렉토리 경로를 반환한다.
   * @returns {string}
   */
  static getLogDir() {
    return DEFAULT_LOG_DIR;
  }

  /**
   * log API에서 사용할 파일명을 검증하고 절대경로로 변환한다.
   * 경로 탐색은 허용하지 않는다.
   * @param {string} name
   * @returns {string}
   */
  static resolveLogFilePath(name) {
    const fileName = String(name || '').trim();
    if (!fileName) throw new Error('name is required');
    if (fileName !== path.basename(fileName)) {
      throw new Error('invalid log file name');
    }
    return path.join(Handler.getLogDir(), fileName);
  }

  /**
   * 텍스트의 라인 수를 계산한다.
   * @param {string} text
   * @returns {number}
   */
  static countLines(text) {
    if (!text) return 0;
    let count = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) count++;
    }
    if (text.charCodeAt(text.length - 1) === 10) count--;
    return count;
  }

  // ── conf.d CRUD ─────────────────────────────────────────────────────────────

  /**
   * conf.d/ 디렉토리의 JSON 설정 파일 이름 목록을 반환한다.
   * @returns {string[]}
   */
  static getConfigList() {
    try {
      return fs.readdirSync(CONF_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''));
    } catch (_) {
      return [];
    }
  }

  /**
   * 이름으로 설정 파일을 읽어 반환한다. 없으면 null을 반환한다.
   * @param {string} name
   * @returns {object|null}
   */
  static getConfig(name) {
    const filePath = path.join(CONF_DIR, `${name}.json`);
    return Handler._read(filePath);
  }

  /**
   * 설정을 정규화하여 파일에 저장한다.
   * @param {string} name
   * @param {object} config
   */
  static writeConfig(name, config) {
    const filePath = path.join(CONF_DIR, `${name}.json`);
    const normalized = normalizeReplicatorConfigForSave(config);
    const data = JSON.stringify(normalized, null, 2);
    Handler._write(filePath, data);
  }

  /**
   * 설정 파일을 삭제한다.
   * @param {string} name
   * @returns {Error|null}
   */
  static removeConfig(name) {
    const filePath = path.join(CONF_DIR, `${name}.json`);
    return Handler._delete(filePath);
  }

  /**
   * 설정 파일이 존재하는지 확인한다.
   * @param {string} name
   * @returns {boolean}
   */
  static existsConfig(name) {
    const filePath = path.join(CONF_DIR, `${name}.json`);
    return Handler.exists(filePath);
  }

  /**
   * server profile 목록을 반환한다.
   * @returns {string[]}
   */
  static getServerConfigList() {
    try {
      return fs.readdirSync(SERVER_CONF_DIR)
        .filter((fileName) => fileName.endsWith('.json'))
        .map((fileName) => fileName.replace(/\.json$/, ''));
    } catch (_) {
      return [];
    }
  }

  /**
   * server profile을 읽어 반환한다.
   * @param {string} name
   * @returns {object|null}
   */
  static getServerConfig(name) {
    const filePath = path.join(SERVER_CONF_DIR, `${name}.json`);
    return Handler._read(filePath);
  }

  /**
   * server profile을 저장한다.
   * @param {string} name
   * @param {object} profile
   */
  static writeServerConfig(name, profile) {
    fs.mkdirSync(SERVER_CONF_DIR, { recursive: true });
    const filePath = path.join(SERVER_CONF_DIR, `${name}.json`);
    const normalized = normalizeServerProfileForSave(profile);
    Handler._write(filePath, JSON.stringify(normalized, null, 2));
  }

  /**
   * server profile을 삭제한다.
   * @param {string} name
   * @returns {Error|null}
   */
  static removeServerConfig(name) {
    const filePath = path.join(SERVER_CONF_DIR, `${name}.json`);
    return Handler._delete(filePath);
  }

  /**
   * server profile 존재 여부를 반환한다.
   * @param {string} name
   * @returns {boolean}
   */
  static existsServerConfig(name) {
    const filePath = path.join(SERVER_CONF_DIR, `${name}.json`);
    return Handler.exists(filePath);
  }

  /**
   * 저장/실행용 replication config를 준비하고 검증한다.
   * @param {object} config
   * @returns {{ storedConfig: object, runtimeConfig: object, sourceInfo: object, targetInfo: object, warnings: string[] }}
   */
  static async prepareReplicatorConfig(config) {
    return prepareReplicatorConfig(config, (serverName) => Handler.getServerConfig(serverName));
  }

  /**
   * server profile을 정규화/검증한다.
   * @param {object} profile
   * @returns {object}
   */
  static validateServerProfile(profile) {
    return validateServerProfile(profile);
  }

  /**
   * 저장 전 connection test용 server profile을 검증한다.
   * name은 없어도 된다.
   * @param {object} profile
   * @returns {object}
   */
  static validateServerProfileForTest(profile) {
    return validateServerProfile(profile, { requireName: false });
  }

  /**
   * server type이 target 전용인지 반환한다.
   * @param {string} type
   * @returns {boolean}
   */
  static isTargetOnlyServerType(type) {
    const normalized = String(type || 'native').trim().toLowerCase();
    return normalized === 'mqtt-api' || normalized === 'mqtt-publish';
  }

  /**
   * replication create용 기본 config 템플릿을 반환한다.
   * @returns {object}
   */
  static buildDefaultReplicatorConfig() {
    return {
      id: '',
      source: {
        server: '',
        table: '',
        columns: null,
        meta: null,
        rep_target_cond: {
          column: null,
          op: 'ALL',
          value: [],
        },
        transform: [],
      },
      target: {
        server: '',
        table: '',
        columns: null,
        meta: null,
      },
      startMode: 'full',
      ridAfter: null,
      queryLimit: 5000,
      pollIntervalMs: 1000,
      shutdownTimeoutMs: 30000,
      onSaveFailure: 'continue',
      retry: {
        maxAttempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 30000,
      },
      logging: {
        level: 'info',
        maxFiles: 10,
      },
    };
  }

  /**
   * replication 기본 템플릿의 참고용 guide/examples를 반환한다.
   * 저장 payload에는 포함되지 않는다.
   * @returns {object}
   */
  static buildDefaultReplicatorGuide() {
    return {
      requiredOnCreate: [
        'source.server',
        'source.table',
        'target.server',
        'target.table',
      ],
      examples: {
        rep_target_cond: [
          { column: null, op: 'ALL', value: [] },
          { column: 'NAME', op: 'IN', value: ['TAG-01', 'TAG-02'] },
          { column: 'NAME', op: 'LIKE', value: ['TAG-%'] },
        ],
        transform: [
          {
            criteria: { column: null, op: 'ALL', value: [] },
            expr: [
              { column: 'NAME', type: 'prefix', value: 'SRC.' },
            ],
          },
          {
            criteria: { column: null, op: 'ALL', value: [] },
            expr: [
              { column: 'VALUE', type: 'calc', bias: 0, multiplier: 1, calcOrder: 'bm' },
            ],
          },
          {
            criteria: { column: null, op: 'ALL', value: [] },
            expr: [
              { column: 'VALUE', type: 'filter', min: 0, max: 100 },
            ],
          },
        ],
      },
    };
  }

  /**
   * server create용 기본 profile 템플릿을 반환한다.
   * @param {string} type
   * @returns {object}
   */
  static buildDefaultServerProfile(type) {
    const normalizedType = String(type || '').trim().toLowerCase();
    if (!normalizedType) {
      throw new Error('type is required');
    }
    if (normalizedType === 'native') {
      return {
        name: '',
        type: 'native',
        host: '127.0.0.1',
        port: 5656,
        user: 'SYS',
        password: '',
        token: '',
        protocol: null,
        qos: null,
        retain: null,
      };
    }
    if (normalizedType === 'http') {
      return {
        name: '',
        type: 'http',
        host: '127.0.0.1',
        port: 5654,
        user: null,
        password: '',
        token: '',
        protocol: 'http',
        qos: null,
        retain: null,
      };
    }
    if (normalizedType === 'mqtt-api') {
      return {
        name: '',
        type: 'mqtt-api',
        host: '127.0.0.1',
        port: 5653,
        user: null,
        password: '',
        token: '',
        protocol: null,
        qos: 1,
        retain: null,
      };
    }
    if (normalizedType === 'mqtt-publish') {
      return {
        name: '',
        type: 'mqtt-publish',
        host: '127.0.0.1',
        port: 5653,
        user: null,
        password: '',
        token: '',
        protocol: null,
        qos: 1,
        retain: false,
      };
    }
    throw new Error(`type '${type}' is not supported`);
  }

  /**
   * replication 기본 템플릿을 반환한다.
   * @param {function(Error|null, object=): void} callback
   */
  static getDefaultReplicatorConfig(callback) {
    try {
      callback(null, {
        config: Handler.buildDefaultReplicatorConfig(),
        guide: Handler.buildDefaultReplicatorGuide(),
      });
    } catch (err) {
      callback(err);
    }
  }

  /**
   * server 기본 템플릿을 반환한다.
   * @param {string} type
   * @param {function(Error|null, object=): void} callback
   */
  static getDefaultServerProfile(type, callback) {
    try {
      const profile = Handler.buildDefaultServerProfile(type);
      callback(null, {
        profile,
        targetOnly: Handler.isTargetOnlyServerType(profile.type),
      });
    } catch (err) {
      callback(err);
    }
  }

  /**
   * server profile로 실제 연결 테스트를 수행한다.
   * query-capable target은 lightweight query, mqtt-publish는 connect만 수행한다.
   * @param {object} profile
   * @returns {Promise<{ type: string, targetOnly: boolean, probe: string }>}
   */
  static async probeServerConnection(profile) {
    const type = String(profile?.type || 'native').trim().toLowerCase();
    if (type === 'native') {
      const client = new MachbaseClient(profile);
      try {
        client.connect();
        const tables = client.selectVisibleTables();
        if (!Array.isArray(tables)) {
          throw new Error('connection test failed');
        }
        return { type, targetOnly: Handler.isTargetOnlyServerType(type), probe: 'query' };
      } finally {
        client.close();
      }
    }

    if (type === 'http' || type === 'mqtt-api') {
      const client = createQueryClient(profile);
      try {
        await client.connect();
        const tables = await client.selectVisibleTables();
        if (!Array.isArray(tables)) {
          throw new Error('connection test failed');
        }
        return { type, targetOnly: Handler.isTargetOnlyServerType(type), probe: 'query' };
      } finally {
        try { await client.close(); } catch (_) {}
      }
    }

    if (type === 'mqtt-publish') {
      const client = new MqttPublishClient(profile);
      try {
        await client.connect();
        return { type, targetOnly: true, probe: 'connect' };
      } finally {
        try { await client.close(); } catch (_) {}
      }
    }

    throw new Error(`server.type '${type}' is not supported`);
  }

  /**
   * replication config를 runtime 연결정보까지 해석한다.
   * @param {object} config
   * @returns {object}
   */
  static resolveRuntimeConfig(config) {
    return resolveReplicatorRuntimeConfig(config, (serverName) => Handler.getServerConfig(serverName));
  }

  /**
   * server profile을 참조하는 replication 이름 목록을 반환한다.
   * @param {string} serverName
   * @returns {string[]}
   */
  static findReplicatorsUsingServer(serverName) {
    const usedBy = [];
    for (const name of Handler.getConfigList()) {
      const config = Handler.getConfig(name);
      if (!config) continue;
      const sourceServer = config?.source?.server;
      const targetServer = config?.target?.server;
      if (sourceServer === serverName || targetServer === serverName) {
        usedBy.push(name);
      }
    }
    return usedBy;
  }

  // ── CGI I/O ──────────────────────────────────────────────────────────────

  /**
   * QUERY_STRING 환경변수를 파싱하여 키-값 객체로 반환한다.
   * @returns {Record<string, string>}
   */
  static parseQuery() {
    const qs = process.env.get('QUERY_STRING') || '';
    const result = {};
    for (const part of qs.split('&')) {
      const [k, v] = part.split('=');
      if (k) result[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    return result;
  }

  /**
   * stdin에서 요청 바디를 읽어 JSON으로 파싱한다. 실패 시 빈 객체를 반환한다.
   * @returns {object}
   */
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

  /**
   * CGI 응답을 JSON으로 stdout에 출력한다.
   * @param {object} data
   */
  static reply(data) {
    const body = JSON.stringify(data);
    process.stdout.write('Content-Type: application/json\r\n');
    process.stdout.write('\r\n');
    process.stdout.write(body);
  }

  // ── service 제어 (low-level) ──────────────────────────────────────────────

  /**
   * 이름에 `_rpl_` prefix를 붙여 service 이름으로 변환한다.
   * 이미 prefix가 있으면 그대로 반환한다.
   * @param {string} name
   * @returns {string}
   */
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

  /**
   * 실제로 설치된 service 이름 목록을 반환한다.
   * prefixed/bare 양쪽을 모두 탐색한다.
   * @param {string} name
   * @returns {string[]}
   */
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

  /**
   * name에 해당하는 service 정의 파일 경로 후보 목록을 반환한다.
   * @param {string} name
   * @returns {string[]}
   */
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

  /**
   * 설치된 service 정의 파일이 하나 이상 존재하는지 확인한다.
   * @param {string} name
   * @returns {boolean}
   */
  static hasInstalledService(name) {
    for (const filePath of Handler.getServiceDefinitionPaths(name)) {
      try {
        if (fs.statSync(filePath).isFile()) return true;
      } catch (_) {}
    }
    return false;
  }

  /**
   * name에 해당하는 service 정의 파일들을 삭제한다.
   * @param {string} name
   * @returns {Error|null}
   */
  static deleteServiceDefinition(name) {
    let firstErr = null;
    for (const filePath of Handler.getServiceDefinitionPaths(name)) {
      const err = Handler._delete(filePath);
      if (!firstErr && err) firstErr = err;
    }
    return firstErr;
  }

  /**
   * service install 설정 객체를 생성한다.
   * @param {string} name - replicator 이름
   * @returns {{ name: string, enable: boolean, working_dir: string, executable: string, args: string[] }}
   */
  static buildServiceInstallConfig(name) {
    return {
      name: Handler.serviceName(name),
      enable: false,
      working_dir: APP_DIR,
      executable: path.join(APP_DIR, 'replication.js'),
      args: [name],
    };
  }

  /**
   * service 모듈 메서드를 안전하게 호출한다.
   * @param {string} method - service 모듈 메서드명
   * @param {Array} args - 메서드 인자 (callback 제외)
   * @param {function(Error|null, any=): void} callback
   */
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

  /**
   * service 호출 옵션을 정규화한다.
   * @param {object=} options
   * @returns {{ retryOnMissingService: boolean, maxAttempts: number, delayMs: number }}
   */
  static normalizeServiceRetryOptions(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0
      ? opts.maxAttempts
      : SERVICE_RETRY_MAX_ATTEMPTS;
    const delayMs = Number.isInteger(opts.delayMs) && opts.delayMs >= 0
      ? opts.delayMs
      : SERVICE_RETRY_DELAY_MS;
    return {
      retryOnMissingService: opts.retryOnMissingService === true,
      maxAttempts,
      delayMs,
    };
  }

  /**
   * service 오류가 재시도 가능한지 판별한다.
   * 현재는 controller 반영 지연으로 인한 not found 계열만 재시도한다.
   * @param {string} method
   * @param {Error} err
   * @param {{ retryOnMissingService: boolean }} options
   * @returns {boolean}
   */
  static isRetryableServiceError(method, err, options) {
    if (!err) return false;
    const opts = Handler.normalizeServiceRetryOptions(options);
    if (opts.retryOnMissingService && Handler.isMissingServiceError(err)) {
      return true;
    }
    return false;
  }

  /**
   * service 모듈 메서드를 재시도와 함께 호출한다.
   * @param {string} method
   * @param {Array} args
   * @param {function(Error|null, any=): void} callback
   * @param {object=} options
   */
  static callServiceWithRetry(method, args, callback, options) {
    const opts = Handler.normalizeServiceRetryOptions(options);
    let attempt = 1;
    const invoke = () => {
      Handler.callService(method, args, (err, data) => {
        if (!err || !Handler.isRetryableServiceError(method, err, opts) || attempt >= opts.maxAttempts) {
          callback(err, data);
          return;
        }
        attempt += 1;
        setTimeout(invoke, opts.delayMs);
      });
    };
    invoke();
  }

  /**
   * service를 설치한다.
   * @param {string} name
   * @param {function(Error|null): void} callback
   */
  static installService(name, callback, options) {
    Handler.callServiceWithRetry('install', [Handler.buildServiceInstallConfig(name)], callback, options);
  }

  /**
   * service 상태를 조회한다. 설치된 이름이 여러 개면 순서대로 시도한다.
   * @param {string} name
   * @param {function(Error|null, object=): void} callback
   */
  static getServiceStatus(name, callback, options) {
    const names = Handler.serviceNamesForControl(name);
    const retryOptions = Handler.normalizeServiceRetryOptions(options);
    const next = (index, lastErr) => {
      if (index >= names.length) {
        callback(lastErr || new Error(`service '${Handler.serviceName(name)}' does not exist`));
        return;
      }
      Handler.callServiceWithRetry('status', [names[index]], (err, serviceInfo) => {
        if (err && Handler.isMissingServiceError(err)) {
          next(index + 1, err);
          return;
        }
        callback(err, serviceInfo);
      }, retryOptions);
    };
    next(0, null);
  }

  /**
   * service를 제거한다. 존재하지 않는 service는 오류 없이 건너뛴다.
   * @param {string} name
   * @param {function(Error|null): void} callback
   */
  static uninstallService(name, callback, options) {
    const names = Handler.serviceNamesForControl(name);
    const retryOptions = Handler.normalizeServiceRetryOptions(options);
    const next = (index, firstErr) => {
      if (index >= names.length) {
        callback(firstErr);
        return;
      }
      Handler.callServiceWithRetry('uninstall', [names[index]], (err) => {
        if (!err || Handler.isMissingServiceError(err)) {
          next(index + 1, firstErr);
          return;
        }
        next(index + 1, firstErr || err);
      }, retryOptions);
    };
    next(0, null);
  }

  /**
   * service를 시작한다.
   * @param {string} name
   * @param {function(Error|null): void} callback
   */
  static startService(name, callback, options) {
    const names = Handler.serviceNamesForControl(name);
    const retryOptions = Handler.normalizeServiceRetryOptions(options);
    const next = (index, lastErr) => {
      if (index >= names.length) {
        callback(lastErr || new Error(`service '${Handler.serviceName(name)}' does not exist`));
        return;
      }
      Handler.callServiceWithRetry('start', [names[index]], (err) => {
        if (err && Handler.isMissingServiceError(err)) {
          next(index + 1, err);
          return;
        }
        callback(err);
      }, retryOptions);
    };
    next(0, null);
  }

  /**
   * service를 종료한다.
   * @param {string} name
   * @param {function(Error|null): void} callback
   */
  static stopService(name, callback, options) {
    const names = Handler.serviceNamesForControl(name);
    const retryOptions = Handler.normalizeServiceRetryOptions(options);
    const next = (index, lastErr) => {
      if (index >= names.length) {
        callback(lastErr || new Error(`service '${Handler.serviceName(name)}' does not exist`));
        return;
      }
      Handler.callServiceWithRetry('stop', [names[index]], (err) => {
        if (err && Handler.isMissingServiceError(err)) {
          next(index + 1, err);
          return;
        }
        callback(err);
      }, retryOptions);
    };
    next(0, null);
  }

  /**
   * service가 존재하지 않아서 발생한 오류인지 판별한다.
   * @param {Error} err
   * @returns {boolean}
   */
  static isMissingServiceError(err) {
    const message = err && err.message ? String(err.message).toLowerCase() : '';
    return message.indexOf('does not exist') >= 0
      || message.indexOf('not found') >= 0;
  }

  /**
   * serviceInfo의 status가 RUNNING인지 확인한다.
   * @param {object} serviceInfo
   * @returns {boolean}
   */
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
    const retryOptions = { retryOnMissingService: true };
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
        }, retryOptions);
      }, retryOptions);
    }, retryOptions);
  }

  /**
   * service가 RUNNING 상태일 때만 stop을 수행한다.
   * service가 없거나 실행 중이 아니면 err 없이 false를 전달한다.
   * @param {string} name
   * @param {function(Error|null, boolean)} callback - (err, stopped)
   */
  static stopServiceIfRunning(name, callback) {
    const retryOptions = { retryOnMissingService: true };
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
      }, retryOptions);
    }, retryOptions);
  }

  // ── checkpoint ───────────────────────────────────────────────────────────

  /**
   * checkpoint 디렉토리들을 훑어 파티션별 checkpoint 상태를 반환한다.
   * checkpoint 파일이 없는 파티션도 빈 값으로 포함한다.
   * @param {string} name - replicator name
   * @param {object} config - replicator config
   * @returns {{ [dataTable: string]: { lastSuccessRid: string, totalRowsWritten: string, hasMore: boolean } }}
   */
  static async readCheckpoints(name, config) {
    const result = {};
    const ensureEntry = (dataTable) => {
      if (!dataTable || result[dataTable]) return;
      result[dataTable] = {
        lastSuccessRid: '',
        totalRowsWritten: '0',
        hasMore: false,
        max_rid: '',
      };
    };

    // source 파티션 목록으로 result 초기화
    const source = config?.source;
    const logicalTable = source?.table;
    if (source && logicalTable) {
      let client = null;
      try {
        const normalizedTable = String(logicalTable).toUpperCase();
        const sourceType = String(source.type || 'native').toLowerCase();
        client = sourceType === 'native'
          ? new MachbaseClient({ ...source, table: normalizedTable })
          : createQueryClient({ ...source, table: normalizedTable });
        await client.connect();
        const tableType = (await client.selectTableTypeQualified(normalizedTable)).type;
        const seen = {};
        const push = (value) => {
          if (typeof value !== 'string') return;
          const dataTable = value.trim();
          if (!dataTable || seen[dataTable]) return;
          seen[dataTable] = true;
          ensureEntry(dataTable);
        };
        if (tableType === 'TAG') {
          for (const part of (await client.selectTagDataTables(normalizedTable))) {
            push(part?.data_table);
          }
        } else if (tableType === 'LOG') {
          push(normalizedTable);
        }
        for (const dataTable of Object.keys(result)) {
          try {
            result[dataTable].max_rid = String(await client.selectMaxRid(dataTable));
          } catch (_) {}
        }
      } catch (_) {
        // checkpoint 조회는 best-effort로 동작한다.
      } finally {
        try { client && await client.close(); } catch (_) {}
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
          const totalRowsWritten = d.checkpoint?.totalRowsWritten;
          if (!dataTable || lastSuccessRid === undefined) continue;
          const updatedAt = d.checkpoint?.updatedAt || '';
          const initializedOnly = d.checkpoint?.initializedOnly === true;
          const ridText = String(lastSuccessRid);
          const totalRowsWrittenText = totalRowsWritten === undefined ? '0' : String(totalRowsWritten);
          const isNegativeRid = /^-/.test(ridText);
          const hasMore = !initializedOnly && !isNegativeRid && d.checkpoint?.hasMore === true;
          const prev = records[dataTable];
          if (!prev || updatedAt >= prev.updatedAt) {
            records[dataTable] = {
              lastSuccessRid: initializedOnly || isNegativeRid ? '' : ridText,
              totalRowsWritten: totalRowsWrittenText,
              hasMore,
              updatedAt,
            };
          }
        } catch (_) {}
      }
      for (const dataTable in records) {
        ensureEntry(dataTable);
        result[dataTable] = {
          lastSuccessRid: records[dataTable].lastSuccessRid,
          totalRowsWritten: records[dataTable].totalRowsWritten || '0',
          hasMore: records[dataTable].hasMore === true,
          max_rid: result[dataTable].max_rid || '',
        };
      }
    }

    return result;
  }

  // ── 비즈니스 로직 ─────────────────────────────────────────────────────────

  /**
   * 객체가 key를 직접 가지는지 확인한다.
   * @param {object} obj
   * @param {string} key
   * @returns {boolean}
   */
  static _hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /**
   * nextConfig에서 inline password가 누락되거나 비어 있으면 currentConfig 값을 유지한다.
   * @param {object} nextConfig
   * @param {object} currentConfig
   * @returns {object}
   */
  static _applyPasswordFallback(nextConfig, currentConfig) {
    if (!nextConfig || typeof nextConfig !== 'object') return nextConfig;

    const nextSource = nextConfig.source;
    const nextTarget = nextConfig.target;
    if (nextSource && typeof nextSource === 'object') {
      if (!nextSource.server && (!Handler._hasOwn(nextSource, 'password') || nextSource.password == null || nextSource.password === '') && Handler._hasOwn(currentConfig?.source, 'password')) {
        nextSource.password = currentConfig.source.password;
      }
      if (!nextSource.server && (!Handler._hasOwn(nextSource, 'token') || nextSource.token == null || nextSource.token === '') && Handler._hasOwn(currentConfig?.source, 'token')) {
        nextSource.token = currentConfig.source.token;
      }
    }
    if (nextTarget && typeof nextTarget === 'object') {
      if (!nextTarget.server && (!Handler._hasOwn(nextTarget, 'password') || nextTarget.password == null || nextTarget.password === '') && Handler._hasOwn(currentConfig?.target, 'password')) {
        nextTarget.password = currentConfig.target.password;
      }
      if (!nextTarget.server && (!Handler._hasOwn(nextTarget, 'token') || nextTarget.token == null || nextTarget.token === '') && Handler._hasOwn(currentConfig?.target, 'token')) {
        nextTarget.token = currentConfig.target.token;
      }
    }
    return nextConfig;
  }

  /**
   * server profile PUT 시 password가 누락/null/빈문자열이면 기존 값을 유지한다.
   * @param {object} nextProfile
   * @param {object} currentProfile
   * @returns {object}
   */
  static _applyServerPasswordFallback(nextProfile, currentProfile) {
    if (!nextProfile || typeof nextProfile !== 'object') return nextProfile;
    if ((!Handler._hasOwn(nextProfile, 'password') || nextProfile.password == null || nextProfile.password === '') && Handler._hasOwn(currentProfile, 'password')) {
      nextProfile.password = currentProfile.password;
    }
    if ((!Handler._hasOwn(nextProfile, 'token') || nextProfile.token == null || nextProfile.token === '') && Handler._hasOwn(currentProfile, 'token')) {
      nextProfile.token = currentProfile.token;
    }
    return nextProfile;
  }

  /**
   * server profile을 생성한다.
   * @param {object} body
   * @param {function(Error|null, { name: string }=): void} callback
   */
  static createServerProfile(body, callback) {
    if (!body || !body.name) { callback(new Error('name is required')); return; }
    if (Handler.getServerConfig(body.name)) { callback(new Error(`server '${body.name}' already exists`)); return; }
    try {
      const profile = Handler.validateServerProfile(body);
      Handler.writeServerConfig(profile.name, profile);
      callback(null, { name: profile.name });
    } catch (err) {
      callback(err);
    }
  }

  /**
   * server profile을 조회한다.
   * @param {string} name
   * @param {function(Error|null, object=): void} callback
   */
  static getServerProfile(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    const profile = Handler.getServerConfig(name);
    if (!profile) { callback(new Error(`server '${name}' not found`)); return; }
    callback(null, sanitizeServerProfile(profile));
  }

  /**
   * server profile을 수정한다.
   * @param {string} name
   * @param {object} body
   * @param {function(Error|null, { name: string }=): void} callback
   */
  static updateServerProfile(name, body, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    const currentProfile = Handler.getServerConfig(name);
    if (!currentProfile) { callback(new Error(`server '${name}' not found`)); return; }
    try {
      const nextProfile = Handler._applyServerPasswordFallback({ ...(body || {}), name }, currentProfile);
      const profile = Handler.validateServerProfile(nextProfile);
      Handler.writeServerConfig(name, profile);
      callback(null, { name });
    } catch (err) {
      callback(err);
    }
  }

  /**
   * server profile을 삭제한다.
   * @param {string} name
   * @param {function(Error|null): void} callback
   */
  static deleteServerProfile(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    if (!Handler.getServerConfig(name)) { callback(new Error(`server '${name}' not found`)); return; }
    const usedBy = Handler.findReplicatorsUsingServer(name);
    if (usedBy.length > 0) {
      callback(new Error(`server '${name}' is referenced by replicators: ${usedBy.join(', ')}`));
      return;
    }
    callback(Handler.removeServerConfig(name));
  }

  /**
   * server profile 목록을 반환한다.
   * @param {function(Error|null, Array=): void} callback
   */
  static listServerProfiles(callback) {
    const names = Handler.getServerConfigList();
    const data = [];
    for (const name of names) {
      const profile = Handler.getServerConfig(name);
      if (!profile) continue;
      data.push(sanitizeServerProfile(profile));
    }
    callback(null, data);
  }

  /**
   * 저장된 server 또는 미저장 profile 기준으로 연결 테스트를 수행한다.
   * body는 { name } 또는 { profile } 형식 중 하나여야 한다.
   * @param {object} body
   * @param {function(Error|null, object=): void} callback
   */
  static async testServerConnection(body, callback) {
    const hasName = !!(body && typeof body.name === 'string' && body.name.trim());
    const hasProfile = !!(body && body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile));
    if (hasName === hasProfile) {
      callback(new Error('exactly one of name or profile is required'));
      return;
    }

    let profile;
    let mode;
    let name = null;
    try {
      if (hasName) {
        name = String(body.name).trim();
        profile = Handler.getServerConfig(name);
        if (!profile) {
          callback(new Error(`server '${name}' not found`));
          return;
        }
        mode = 'saved';
      } else {
        profile = Handler.validateServerProfileForTest(body.profile);
        mode = 'profile';
      }

      const result = await Handler.probeServerConnection(profile);
      callback(null, {
        mode,
        name: mode === 'saved' ? name : undefined,
        type: result.type,
        targetOnly: result.targetOnly,
        probe: result.probe,
      });
    } catch (err) {
      callback(err);
    }
  }

  /**
   * replicator를 생성한다. config 저장 후 service를 설치한다.
   * @param {{ name: string, config: object }} body
   * @param {function(Error|null, { name: string }=): void} callback
   */
  static async createReplicator(body, callback) {
    if (!body.name) { callback(new Error('name is required')); return; }
    if (!body.config) { callback(new Error('config is required')); return; }
    if (Handler.getConfig(body.name)) { callback(new Error(`replicator '${body.name}' already exists`)); return; }
    try {
      const prepared = await Handler.prepareReplicatorConfig(body.config);
      Handler.writeConfig(body.name, prepared.storedConfig);
    } catch (err) {
      callback(err);
      return;
    }
    Handler.installService(body.name, (err) => {
      if (err) {
        Handler.removeConfig(body.name);
        callback(err);
      } else {
        callback(null, { name: body.name });
      }
    });
  }

  /**
   * dry-run 검증을 수행한다.
   * @param {object} body
   * @param {function(Error|null, object=): void} callback
   */
  static async dryRunReplicator(body, callback) {
    const config = body && body.config ? body.config : body;
    if (!config || typeof config !== 'object') {
      callback(new Error('config is required'));
      return;
    }
    try {
      const prepared = await Handler.prepareReplicatorConfig(config);
      callback(null, {
        source: {
          table: prepared.sourceInfo.table,
          tableType: prepared.sourceInfo.tableType,
          dataColumns: prepared.sourceInfo.dataColumns.map((column) => column.NAME),
          metaColumns: prepared.sourceInfo.metaColumns.map((column) => column.NAME),
        },
        target: {
          table: prepared.targetInfo.table,
          tableType: prepared.targetInfo.tableType,
          dataColumns: prepared.targetInfo.dataColumns.map((column) => column.NAME),
          metaColumns: prepared.targetInfo.metaColumns.map((column) => column.NAME),
        },
        normalized: sanitizeReplicatorConfig(prepared.storedConfig),
        warnings: Array.isArray(prepared.warnings) ? prepared.warnings.slice() : [],
      });
    } catch (err) {
      callback(err);
    }
  }

  /**
   * replicator 설정과 checkpoint 정보를 반환한다. password는 제거된다.
   * @param {string} name
   * @param {function(Error|null, { name: string, config: object, checkpoints: object }=): void} callback
   */
  static async getReplicator(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    const config = Handler.getConfig(name);
    if (!config) { callback(new Error(`replicator '${name}' not found`)); return; }
    const safeConfig = sanitizeReplicatorConfig(normalizeReplicatorConfigForSave(config));
    let runtimeConfig = null;
    try {
      runtimeConfig = Handler.resolveRuntimeConfig(config);
    } catch (_) {
      runtimeConfig = config;
    }
    const sourceTable = config.source?.table || '';
    const targetTable = config.target?.table || sourceTable;
    const replicatorId = config.id || (sourceTable && targetTable ? `${sourceTable}_${targetTable}` : '');
    const checkpoints = await Handler.readCheckpoints(replicatorId, runtimeConfig);
    callback(null, { name, config: safeConfig, checkpoints });
  }

  /**
   * replicator 설정을 업데이트한다. service가 실행 중이면 재시작한다.
   * @param {string} name
   * @param {object} body - 새 config
   * @param {function(Error|null, boolean=): void} callback
   */
  static async updateReplicator(name, body, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    const currentConfig = Handler.getConfig(name);
    if (!currentConfig) { callback(new Error(`replicator '${name}' not found`)); return; }
    const nextConfig = Handler._applyPasswordFallback(body, currentConfig);
    try {
      const prepared = await Handler.prepareReplicatorConfig(nextConfig);
      Handler.writeConfig(name, prepared.storedConfig);
    } catch (err) {
      callback(err);
      return;
    }
    Handler.restartServiceIfRunning(name, callback);
  }

  /**
   * replicator를 삭제한다. service 중지 → 제거 → 설정/PID/checkpoint 파일 정리 순으로 진행한다.
   * @param {string} name
   * @param {function(Error|null): void} callback
   */
  static deleteReplicator(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    const config = Handler.getConfig(name);
    if (!config) { callback(new Error(`replicator '${name}' not found`)); return; }
    const retryOptions = { retryOnMissingService: true };
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
      }, retryOptions);
    });
  }

  /**
   * 기존 config를 기반으로 service를 설치한다.
   * @param {string} name
   * @param {function(Error|null): void} callback
   */
  static installReplicator(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    if (!Handler.getConfig(name)) { callback(new Error(`replicator '${name}' not found`)); return; }
    if (Handler.hasInstalledService(name)) { callback(new Error(`replicator '${name}' already installed`)); return; }
    Handler.installService(name, callback, { retryOnMissingService: true });
  }

  /**
   * replicator service를 시작한다. 이미 실행 중이면 오류를 반환한다.
   * @param {string} name
   * @param {function(Error|null): void} callback
   */
  static startReplicator(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    if (!Handler.getConfig(name)) { callback(new Error(`replicator '${name}' not found`)); return; }
    const retryOptions = { retryOnMissingService: true };
    Handler.getServiceStatus(name, (err, serviceInfo) => {
      if (!err && Handler.isServiceRunningStatus(serviceInfo)) {
        callback(new Error(`replicator '${name}' is already running`));
        return;
      }
      Handler.startService(name, callback, retryOptions);
    }, retryOptions);
  }

  /**
   * replicator service를 종료하고 PID 파일을 삭제한다.
   * @param {string} name
   * @param {function(Error|null): void} callback
   */
  static stopReplicator(name, callback) {
    if (!name) { callback(new Error('name is required')); return; }
    if (!Handler.getConfig(name)) { callback(new Error(`replicator '${name}' not found`)); return; }
    Handler.stopService(name, (err) => {
      if (err) { callback(err); return; }
      const pidPath = path.join(APP_DIR, `${name}.pid`);
      Handler._delete(pidPath);
      callback(null);
    }, { retryOnMissingService: true });
  }

  /**
   * 등록된 replicator 목록과 각각의 installed/running 상태를 반환한다.
   * @param {function(Error|null, Array=): void} callback
   */
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
      }, { retryOnMissingService: installed });
    };
    next(0);
  }

  /**
   * 지정한 서버/테이블의 컬럼 정보를 조회한다.
   * @param {{ server?: string, host?: string, port?: number|string, user?: string, password?: string, type?: string, table: string }} body
   * @param {function(Error|null, { table: string, tableType: string, columns: Array, meta: Array }=): void} callback
   */
  static async getTableColumns(body, callback) {
    const { table } = body;
    if (!table)    { callback(new Error('table is required')); return; }
    let endpoint;
    try {
      endpoint = resolveEndpointConnection(body, (serverName) => Handler.getServerConfig(serverName), 'server');
    } catch (err) {
      callback(err);
      return;
    }

    const type = String(endpoint.type || 'native').toLowerCase();
    const client = type === 'native' ? new MachbaseClient(endpoint) : createQueryClient(endpoint);
    try {
      await client.connect();
      const qualified = client.splitQualifiedTableName(table);
      const { type: tableType } = await client.selectTableTypeQualified(table.toUpperCase());
      if (tableType === 'UNSUPPORTED') {
        callback(new Error(`table '${table}' not found`));
        return;
      }
      const rows = (await client.selectColumnsByQualifiedTableName(table.toUpperCase())).filter((r) => {
        if (tableType !== 'LOG') return true;
        return r.NAME !== '_ARRIVAL_TIME';
      });
      const describe = (r) => {
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
      };
      const columns = rows.filter((r) => !(r.FLAG & FLAG_METADATA)).map(describe);
      const meta = rows.filter((r) => !!(r.FLAG & FLAG_METADATA)).map(describe);
      callback(null, {
        table: qualified.owner ? `${qualified.owner}.${qualified.table}` : qualified.table,
        tableType,
        columns,
        meta,
      });
    } catch (err) {
      callback(err);
    } finally {
      try { await client.close(); } catch (_) {}
    }
  }

  /**
   * 지정한 서버에서 일반 사용자가 보는 TAG/LOG 논리 테이블 목록을 조회한다.
   * @param {{ server?: string, host?: string, port?: number|string, user?: string, password?: string, type?: string }} body
   * @param {function(Error|null, { tables: Array }=): void} callback
   */
  static async getTableList(body, callback) {
    let endpoint;
    try {
      endpoint = resolveEndpointConnection(body || {}, (serverName) => Handler.getServerConfig(serverName), 'server');
    } catch (err) {
      callback(err);
      return;
    }

    const type = String(endpoint.type || 'native').toLowerCase();
    const client = type === 'native' ? new MachbaseClient(endpoint) : createQueryClient(endpoint);
    try {
      await client.connect();
      const tables = (await client.selectVisibleTables()).map((row) => ({
        name: row.TABLE_NAME,
        tableType: row.TABLE_TYPE === 6 ? 'TAG' : 'LOG',
        owner: row.OWNER || '',
      }));
      callback(null, { tables });
    } catch (err) {
      callback(err);
    } finally {
      try { await client.close(); } catch (_) {}
    }
  }

  /**
   * 지정한 TAG 테이블의 이름 목록을 페이지 단위로 조회한다.
   * @param {{ server?: string, host?: string, port?: number|string, user?: string, password?: string, type?: string, table: string, page: number|string, size: number|string }} body
   * @param {function(Error|null, { total_tags: number, tags: Array<string> }=): void} callback
   */
  static async getTagList(body, callback) {
    const { table } = body || {};
    if (!table) { callback(new Error('table is required')); return; }

    const page = Number(body?.page);
    const size = Number(body?.size);
    if (!Number.isSafeInteger(page) || page < 1) {
      callback(new Error('page must be >= 1'));
      return;
    }
    if (!Number.isSafeInteger(size) || size < 1) {
      callback(new Error('size must be >= 1'));
      return;
    }

    let endpoint;
    try {
      endpoint = resolveEndpointConnection(body || {}, (serverName) => Handler.getServerConfig(serverName), 'server');
    } catch (err) {
      callback(err);
      return;
    }

    const type = String(endpoint.type || 'native').toLowerCase();
    const client = type === 'native' ? new MachbaseClient(endpoint) : createQueryClient(endpoint);
    try {
      await client.connect();
      const qualified = client.splitQualifiedTableName(table);
      const qualifiedTable = qualified.owner ? `${qualified.owner}.${qualified.table}` : qualified.table;
      const { type: tableType } = await client.selectTableTypeQualified(qualifiedTable);
      if (tableType === 'UNSUPPORTED') {
        callback(new Error(`table '${table}' not found`));
        return;
      }
      if (tableType !== 'TAG') {
        callback(new Error(`table '${table}' is not a TAG table`));
        return;
      }
      const offset = (page - 1) * size;
      const totalTags = await client.countTagNames(qualifiedTable);
      const rows = await client.selectTagNamesPaged(qualifiedTable, offset, size);
      callback(null, {
        total_tags: Number(totalTags) || 0,
        tags: (rows || []).map((row) => row.NAME != null ? row.NAME : row.name).filter((name) => name != null),
      });
    } catch (err) {
      callback(err);
    } finally {
      try { await client.close(); } catch (_) {}
    }
  }

  /**
   * 로그 파일 목록을 반환한다.
   * @param {{ name?: string }|null} query
   * @param {function(Error|null, { files: Array }=): void} callback
   */
  static getLogList(query, callback) {
    const logDir = Handler.getLogDir();
    const prefix = typeof query?.name === 'string' ? query.name.trim() : '';
    let names = [];
    try {
      names = fs.readdirSync(logDir);
    } catch (err) {
      callback(err);
      return;
    }

    const files = [];
    for (const name of names) {
      if (prefix && !name.startsWith(prefix)) continue;
      const filePath = path.join(logDir, name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (_) {
        continue;
      }
      if (!stat.isFile()) continue;
      const birthtimeMs = Number(stat.birthtimeMs);
      const createdAtMs = Number.isFinite(birthtimeMs) && birthtimeMs > 0
        ? birthtimeMs
        : (Number.isFinite(Number(stat.ctimeMs)) && Number(stat.ctimeMs) > 0
          ? Number(stat.ctimeMs)
          : Number(stat.mtimeMs) || 0);
      files.push({ name, size: stat.size, _createdAtMs: createdAtMs });
    }

    files.sort((a, b) => {
      if (b._createdAtMs !== a._createdAtMs) return b._createdAtMs - a._createdAtMs;
      return a.name.localeCompare(b.name);
    });
    callback(null, {
      files: files.map((file) => ({ name: file.name, size: file.size })),
    });
  }

  /**
   * 로그 파일 전체 내용을 반환한다.
   * @param {{ name?: string }} query
   * @param {function(Error|null, { name: string, content: string }=): void} callback
   */
  static getLogContentAll(query, callback) {
    let filePath;
    try {
      filePath = Handler.resolveLogFilePath(query && query.name);
    } catch (err) {
      callback(err);
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      callback(err);
      return;
    }
    if (!stat.isFile()) {
      callback(new Error(`log file '${query.name}' not found`));
      return;
    }

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      callback(err);
      return;
    }

    callback(null, { name: path.basename(filePath), content });
  }

  /**
   * 로그 파일 내용의 전체 또는 일부 라인을 반환한다.
   * @param {{ name?: string, start?: string|number, end?: string|number }} query
   * @param {function(Error|null, { name: string, start: number, end: number, totalLines: number, lines: string[] }=): void} callback
   */
  static getLogContent(query, callback) {
    let filePath;
    try {
      filePath = Handler.resolveLogFilePath(query && query.name);
    } catch (err) {
      callback(err);
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      callback(err);
      return;
    }
    if (!stat.isFile()) {
      callback(new Error(`log file '${query.name}' not found`));
      return;
    }

    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      callback(err);
      return;
    }

    const lines = text ? text.split(/\r?\n/) : [];
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    const totalLines = lines.length;

    const parseLineNumber = (value, fallback) => {
      if (value == null || value === '') return fallback;
      const parsed = parseInt(value, 10);
      if (!Number.isFinite(parsed)) throw new Error('start/end must be integers');
      return parsed;
    };

    let start;
    let end;
    try {
      start = parseLineNumber(query && query.start, 1);
      end = parseLineNumber(query && query.end, totalLines);
    } catch (err) {
      callback(err);
      return;
    }

    if (totalLines === 0) {
      callback(null, { name: path.basename(filePath), start: 0, end: 0, totalLines: 0, lines: [] });
      return;
    }

    if (start < 1) start = 1;
    if (end > totalLines) end = totalLines;
    if (end < start) {
      callback(new Error('end must be greater than or equal to start'));
      return;
    }

    callback(null, {
      name: path.basename(filePath),
      start,
      end,
      totalLines,
      lines: lines.slice(start - 1, end),
    });
  }
}

module.exports = Handler;
module.exports.CONF_DIR = CONF_DIR;
module.exports.DATA_DIR = DATA_DIR;
module.exports.SERVER_CONF_DIR = SERVER_CONF_DIR;
