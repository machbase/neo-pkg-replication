'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { trace: -1, debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABEL = { trace: 'TRACE', debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

/**
 * Logger — 날짜 기반 로테이션, stdout/file 독립 제어
 *
 * 포맷: {timestamp} [{LEVEL}] {stage} {key=value ...} msg="{msg}"
 *
 * 설정 (config.logging):
 *   level      : "debug"|"info"|"warn"|"error"  (기본 "info")
 *   stdout     : boolean                          (기본 true)
 *   file:
 *     enabled  : boolean                          (기본 false)
 *     directory: string                           (기본 "/work/logs")
 */
class Logger {
  constructor(loggingConfig = {}) {
    this._minLevel = LEVELS[loggingConfig.level] ?? LEVELS.info;
    this._stdout = loggingConfig.stdout !== false;

    const fileCfg = loggingConfig.file || {};
    this._fileEnabled = fileCfg.enabled === true;
    this._fileDir = fileCfg.directory || '/work/logs';

    this._stream = null;
    this._currentDate = null;
  }

  trace(stage, fields) { this._write('trace', stage, fields); }
  debug(stage, fields) { this._write('debug', stage, fields); }
  info(stage, fields)  { this._write('info',  stage, fields); }
  warn(stage, fields)  { this._write('warn',  stage, fields); }
  error(stage, fields) { this._write('error', stage, fields); }

  banner(msg) {
    const ts = new Date().toISOString();
    const line = '-'.repeat(72);
    const text = `${line}\n  ${ts}  ${msg}\n${line}`;
    if (this._stdout) console.println(text);
    if (this._fileEnabled) {
      this._ensureStream();
      if (this._stream) this._stream.write(text + '\n', 'utf8');
    }
  }

  close() {
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }

  _write(level, stage, fields = {}) {
    if (LEVELS[level] < this._minLevel) return;

    const line = this._format(level, stage, fields);

    if (this._stdout) {
      if (level === 'error' || level === 'warn') {
        console.error(line);
      } else {
        console.println(line);
      }
    }

    if (this._fileEnabled) {
      this._ensureStream();
      if (this._stream) this._stream.write(line + '\n', 'utf8');
    }
  }

  _format(level, stage, fields) {
    const ts = new Date().toISOString();
    const label = LEVEL_LABEL[level] || level.toUpperCase();

    const { msg, ...rest } = fields;
    const kvParts = Object.entries(rest)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${_quoteIfNeeded(String(v))}`);

    if (msg !== undefined) kvParts.push(`msg=${_quoteIfNeeded(String(msg))}`);

    const kv = kvParts.length > 0 ? ' ' + kvParts.join(' ') : '';
    return `${ts} [${label}] ${stage}${kv}`;
  }

  _ensureStream() {
    const today = new Date().toISOString().slice(0, 10);
    if (this._currentDate === today && this._stream) return;

    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }

    try {
      fs.mkdirSync(this._fileDir, { recursive: true });
      const filePath = path.join(this._fileDir, `repli-${today}.log`);
      this._stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
      this._currentDate = today;
    } catch (err) {
      console.error(`[Logger] failed to open log file: ${err.message}`);
    }
  }
}

function _quoteIfNeeded(str) {
  return /[ ="]/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str;
}

let _instance = new Logger();

function init(loggingConfig) {
  _instance.close();
  _instance = new Logger(loggingConfig);
}

function getInstance() {
  return _instance;
}

module.exports = { Logger, init, getInstance };
