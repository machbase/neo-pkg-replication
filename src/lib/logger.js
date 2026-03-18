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
 *     directory: string                           (기본 "./logs")
 */
class Logger {
  constructor(loggingConfig = {}) {
    this._minLevel = LEVELS[loggingConfig.level] ?? LEVELS.info;
    this._stdout = loggingConfig.stdout !== false;

    const fileCfg = loggingConfig.file || {};
    this._fileEnabled = fileCfg.enabled === true;
    this._fileDir = fileCfg.directory || './logs';

    this._stream = null;       // 현재 열린 WriteStream
    this._currentDate = null;  // 스트림이 열린 날짜 (YYYY-MM-DD)
  }

  // ── 공개 API ─────────────────────────────────────────────────────────────

  trace(stage, fields) { this._write('trace', stage, fields); }
  debug(stage, fields) { this._write('debug', stage, fields); }
  info(stage, fields)  { this._write('info',  stage, fields); }
  warn(stage, fields)  { this._write('warn',  stage, fields); }
  error(stage, fields) { this._write('error', stage, fields); }

  /** 시작 구분선 배너 출력 */
  banner(msg) {
    const ts = new Date().toISOString();
    const line = `${'─'.repeat(72)}`;
    const text = [
      line,
      `  ${ts}  ${msg}`,
      line,
    ].join('\n');

    if (this._stdout) {
      process.stdout.write(text + '\n');
    }
    if (this._fileEnabled) {
      this._ensureStream();
      if (this._stream) this._stream.write(text + '\n');
    }
  }

  /** app 종료 시 스트림 닫기 */
  close() {
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }

  // ── 내부 ──────────────────────────────────────────────────────────────────

  _write(level, stage, fields = {}) {
    if (LEVELS[level] < this._minLevel) return;

    const line = this._format(level, stage, fields);

    if (this._stdout) {
      if (level === 'error' || level === 'warn') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    }

    if (this._fileEnabled) {
      this._ensureStream();
      if (this._stream) {
        this._stream.write(line + '\n');
      }
    }
  }

  _format(level, stage, fields) {
    const ts = new Date().toISOString();
    const label = LEVEL_LABEL[level] || level.toUpperCase();

    // msg는 별도로 꺼내서 마지막에 배치
    const { msg, ...rest } = fields;

    const kvParts = Object.entries(rest)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${_quoteIfNeeded(String(v))}`);

    if (msg !== undefined) {
      kvParts.push(`msg=${_quoteIfNeeded(String(msg))}`);
    }

    const kv = kvParts.length > 0 ? ' ' + kvParts.join(' ') : '';
    return `${ts} [${label}] ${stage}${kv}`;
  }

  /** 날짜가 바뀌었으면 스트림 재생성 */
  _ensureStream() {
    const today = _dateString(new Date());
    if (this._currentDate === today && this._stream) return;

    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }

    try {
      fs.mkdirSync(this._fileDir, { recursive: true });
      const filePath = path.join(this._fileDir, `repli-${today}.log`);
      this._stream = fs.createWriteStream(filePath, { flags: 'a' });
      this._stream.on('error', err => {
        // 파일 쓰기 오류는 stderr에만 출력 (무한 루프 방지)
        process.stderr.write(`[Logger] file stream error: ${err.message}\n`);
        this._stream = null;
      });
      this._currentDate = today;
    } catch (err) {
      process.stderr.write(`[Logger] failed to open log file: ${err.message}\n`);
    }
  }
}

function _dateString(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function _quoteIfNeeded(str) {
  // 공백이나 = 포함 시 따옴표
  return /[ ="]/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str;
}

// 싱글턴 인스턴스 — app.js에서 init() 후 전역 사용
let _instance = new Logger(); // 기본값: info, stdout만

function init(loggingConfig) {
  _instance.close();
  _instance = new Logger(loggingConfig);
}

function getInstance() {
  return _instance;
}

module.exports = { Logger, init, getInstance };
