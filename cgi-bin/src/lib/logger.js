'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_LOG_DIR } = require('../cgi/config.js');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const LEVELS = { trace: -1, debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABEL = { trace: 'TRACE', debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };

/**
 * Logger — 크기 기반 로테이션, file 출력 + 선택적 stdout 미러링
 *
 * 출력 디렉토리: /work/public/neo-pkg-replication/logs  (고정)
 * 파일명: {serviceName}.log, {serviceName}_YYYYMMDD_HHMMSS.log, ...
 * 파일당 최대 크기: 10 MB
 *
 * 포맷: [LEVEL] YYYY-MM-DD HH:MM:SS.sss TZ  stage  message  (key=value ...)
 *
 * 설정 (config.logging):
 *   level    : "trace"|"debug"|"info"|"warn"|"error"  (기본 "info")
 *   maxFiles : number                                  (기본 10, 최대 파일 개수)
 */
class Logger {
  constructor(loggingConfig = {}, runtimeOptions = {}) {
    this._disabled = loggingConfig.disable === true;
    this._minLevel = LEVELS[loggingConfig.level] ?? LEVELS.info;
    this._maxFiles = (loggingConfig.maxFiles > 0 ? loggingConfig.maxFiles : 10);
    this._fileDir = DEFAULT_LOG_DIR;
    this._fileStem = _sanitizeFileStem(runtimeOptions.fileStem || 'repli');

    this._filePath = null;
    this._fileSize = 0;

    if (!this._disabled) {
      try {
        fs.mkdirSync(this._fileDir, { recursive: true });
      } catch (err) {
        console.error(`[Logger] failed to create log directory: ${err.message}`);
      }
    }
  }

  /** @param {string} stage @param {object} fields */
  trace(stage, fields) { this._write('trace', stage, fields); }
  /** @param {string} stage @param {object} fields */
  debug(stage, fields) { this._write('debug', stage, fields); }
  /** @param {string} stage @param {object} fields */
  info(stage, fields)  { this._write('info',  stage, fields); }
  /** @param {string} stage @param {object} fields */
  warn(stage, fields)  { this._write('warn',  stage, fields); }
  /** @param {string} stage @param {object} fields */
  error(stage, fields) { this._write('error', stage, fields); }
  /** @param {string} level @param {string} stage @param {object} fields */
  stdout(level, stage, fields) {
    console.println(this._format(level, stage, fields || {}));
  }

  /**
   * 구분선과 함께 배너 메시지를 파일에 출력한다.
   * @param {string} msg
   */
  banner(msg) {
    if (this._disabled) return;
    const ts = _formatLocalTimestamp(new Date());
    const line = '-'.repeat(72);
    const text = `${line}\n  ${ts}  ${msg}\n${line}`;
    this._appendToFile(text + '\n');
  }

  /** 로거를 닫는다 (현재 구현에서는 no-op). */
  close() {}

  /**
   * 레벨 필터를 통과한 로그를 파일에 기록한다.
   * @param {string} level
   * @param {string} stage
   * @param {object} [fields={}]
   */
  _write(level, stage, fields = {}) {
    if (this._disabled) return;
    if (LEVELS[level] < this._minLevel) return;
    const text = this._format(level, stage, fields);
    this._appendToFile(text + '\n');
  }

  /**
   * 로그 라인을 포맷팅하여 문자열로 반환한다.
   * @param {string} level
   * @param {string} stage
   * @param {object} fields
   * @returns {string}
   */
  _format(level, stage, fields) {
    const ts = _formatLocalTimestamp(new Date());
    const label = LEVEL_LABEL[level] || level.toUpperCase();

    const { msg, ...rest } = fields;
    const kvParts = Object.entries(rest)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${_quoteIfNeeded(String(v))}`);

    const msgStr = msg !== undefined ? String(msg) : '';
    const kv = kvParts.length > 0 ? `  (${kvParts.join(' ')})` : '';
    return `[${label}] ${ts}  ${stage}  ${msgStr}${kv}`;
  }

  /**
   * 현재 active 로그 파일 경로를 반환한다.
   * @returns {string}
   */
  _resolveActiveFilePath() {
    return path.join(this._fileDir, `${this._fileStem}.log`);
  }

  /**
   * 로테이션된 로그 파일 경로를 생성한다.
   * 같은 초에 여러 번 회전되면 suffix를 붙여 충돌을 피한다.
   * @returns {string}
   */
  _resolveRotatedFilePath() {
    const stamp = _formatLocalFileStamp(new Date());
    const baseName = `${this._fileStem}_${stamp}`;
    let candidate = path.join(this._fileDir, `${baseName}.log`);
    let index = 1;
    while (true) {
      try {
        fs.statSync(candidate);
      } catch (_) {
        return candidate;
      }
      candidate = path.join(this._fileDir, `${baseName}_${String(index).padStart(4, '0')}.log`);
      index++;
    }
  }

  /**
   * 현재 쓸 active 로그 파일 경로를 결정한다.
   */
  _ensurePath() {
    if (this._filePath) return;

    try {
      this._filePath = this._resolveActiveFilePath();
      try { this._fileSize = fs.statSync(this._filePath).size; } catch (_) { this._fileSize = 0; }
    } catch (err) {
      console.error(`[Logger] failed to open log file: ${err.message}`);
    }
  }

  /**
   * active 로그 파일을 회전시킨다.
   */
  _rotateFile() {
    try {
      if (!this._filePath) this._ensurePath();
      if (!this._filePath) return;
      if (this._fileSize > 0) {
        fs.renameSync(this._filePath, this._resolveRotatedFilePath());
      }
      this._pruneRotatedFiles();
      this._filePath = this._resolveActiveFilePath();
      this._fileSize = 0;
    } catch (err) {
      console.error(`[Logger] failed to rotate log file: ${err.message}`);
      this._filePath = null;
      this._fileSize = 0;
    }
  }

  /**
   * maxFiles를 넘는 rotated 로그를 오래된 것부터 삭제한다.
   */
  _pruneRotatedFiles() {
    if (this._maxFiles <= 1) return;
    let names = [];
    try {
      names = fs.readdirSync(this._fileDir);
    } catch (_) {
      return;
    }
    const prefix = `${this._fileStem}_`;
    const rotated = names
      .filter((name) => name.startsWith(prefix) && name.endsWith('.log'))
      .map((name) => {
        const filePath = path.join(this._fileDir, name);
        let mtime = 0;
        try { mtime = fs.statSync(filePath).mtime.getTime(); } catch (_) {}
        return { filePath, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime);
    const maxRotated = this._maxFiles - 1;
    while (rotated.length > maxRotated) {
      const item = rotated.shift();
      try { fs.unlinkSync(item.filePath); } catch (_) {}
    }
  }

  /**
   * 텍스트를 현재 active 로그 파일에 추가한다. 크기 초과 시 회전 후 이어쓴다.
   * @param {string} text
   */
  _appendToFile(text) {
    this._ensurePath();
    if (!this._filePath) return;

    // 파일 크기 초과 시 active 파일을 rotated 파일명으로 바꾸고 새 active 파일을 연다.
    if (this._fileSize + text.length > MAX_FILE_SIZE) {
      this._rotateFile();
      if (!this._filePath) return;
    }

    try {
      fs.appendFileSync(this._filePath, text, 'utf8');
      this._fileSize += text.length;
    } catch (err) {
      this._filePath = null;
      console.error(`[Logger] failed to write log file: ${err.message}`);
    }
  }
}

/**
 * 공백, 등호, 따옴표가 포함된 문자열을 큰따옴표로 감싼다.
 * @param {string} str
 * @returns {string}
 */
function _quoteIfNeeded(str) {
  return /[ ="]/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str;
}

function _formatLocalTimestamp(date) {
  return [
    date.getFullYear(),
    '-',
    _pad2(date.getMonth() + 1),
    '-',
    _pad2(date.getDate()),
    ' ',
    _pad2(date.getHours()),
    ':',
    _pad2(date.getMinutes()),
    ':',
    _pad2(date.getSeconds()),
    '.',
    String(date.getMilliseconds()).padStart(3, '0'),
    ' ',
    _formatLocalTimezone(date),
  ].join('');
}

function _formatLocalTimezone(date) {
  const match = String(date).match(/\(([^)]+)\)$/);
  if (!match || !match[1]) {
    return 'LOC';
  }
  const label = match[1].trim();
  if (/^[A-Z]{3}$/.test(label)) {
    return label;
  }
  return label
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 3) || 'LOC';
}

function _formatLocalFileStamp(date) {
  return [
    date.getFullYear(),
    _pad2(date.getMonth() + 1),
    _pad2(date.getDate()),
    '_',
    _pad2(date.getHours()),
    _pad2(date.getMinutes()),
    _pad2(date.getSeconds()),
  ].join('');
}

function _pad2(value) {
  return String(value).padStart(2, '0');
}

function _sanitizeFileStem(value) {
  const text = String(value || '').trim();
  const safe = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'repli';
}

let _instance = new Logger();

/**
 * Logger 싱글턴을 새 설정으로 초기화한다.
 * @param {{ disable?: boolean, level?: string, maxFiles?: number }} loggingConfig
 */
function init(loggingConfig, runtimeOptions) {
  _instance.close();
  _instance = new Logger(loggingConfig, runtimeOptions);
}

/**
 * Logger 싱글턴 인스턴스를 반환한다.
 * @returns {Logger}
 */
function getInstance() {
  return _instance;
}

module.exports = { Logger, init, getInstance };
