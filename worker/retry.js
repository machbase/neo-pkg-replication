'use strict';

// 재시도 불가 오류 코드
const NON_RETRYABLE_CODES = new Set([
  'CONFIG_ERROR',
  'SCHEMA_ERROR',
  'TYPE_MISMATCH',
  'COLUMN_VALIDATION_ERROR',
]);

class RetryHandler {
  /**
   * @param {object} config
   * @param {string}  [config.strategy='exponential'] - 'exponential' | 'linear'
   * @param {number}  [config.initial_delay_ms=1000]
   * @param {number}  [config.multiplier=2]           - exponential 전용
   * @param {number}  [config.max_delay_ms=60000]
   * @param {boolean} [config.jitter=true]
   * @param {number|null} [config.max_attempts=null]  - null=무한
   */
  constructor(config = {}) {
    this.strategy = config.strategy || 'exponential';
    this.initialDelayMs = config.initial_delay_ms ?? 1000;
    this.multiplier = config.multiplier ?? 2;
    this.maxDelayMs = config.max_delay_ms ?? 60000;
    this.jitter = config.jitter !== false;
    this.maxAttempts = config.max_attempts ?? null;
  }

  /**
   * 재시도 가능 여부 판단
   * @param {Error|null} err
   * @returns {boolean}
   */
  shouldRetry(err) {
    if (!err) return true;
    if (err.retryable === false) return false;
    if (NON_RETRYABLE_CODES.has(err.code)) return false;
    return true;
  }

  /**
   * max_attempts 초과 여부 판단
   * @param {number} attempt - 0-based 시도 횟수
   * @returns {boolean} true면 스킵 대상
   */
  isExhausted(attempt) {
    if (this.maxAttempts === null) return false;
    return attempt >= this.maxAttempts;
  }

  /**
   * 다음 지연 시간(ms) 계산
   * @param {number} attempt - 0-based
   * @returns {number}
   */
  nextDelay(attempt) {
    let delay;
    if (this.strategy === 'exponential') {
      delay = this.initialDelayMs * Math.pow(this.multiplier, attempt);
    } else {
      // linear
      delay = this.initialDelayMs * (attempt + 1);
    }

    delay = Math.min(delay, this.maxDelayMs);

    if (this.jitter) {
      // delay/2 ~ delay 범위로 jitter 적용 (0ms 방지)
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  /**
   * ms 동안 대기하거나, shutdownFlag가 set되면 즉시 반환
   * @param {number} ms
   * @param {{ value: boolean }} shutdownFlag
   * @returns {Promise<'timeout'|'shutdown'>}
   */
  sleepOrShutdown(ms, shutdownFlag) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        clearInterval(checker);
        resolve('timeout');
      }, ms);

      const checker = setInterval(() => {
        if (shutdownFlag.value) {
          clearTimeout(timer);
          clearInterval(checker);
          resolve('shutdown');
        }
      }, 50);
    });
  }
}

module.exports = RetryHandler;
