'use strict';

class RetryHandler {
  /**
   * @param {object} config
   * @param {string}  [config.strategy='exponential'] - 'exponential' | 'linear'
   * @param {number}  [config.base_delay_ms=1000]
   * @param {number}  [config.multiplier=2]           - exponential 전용
   * @param {number}  [config.max_delay_ms=60000]
   * @param {boolean} [config.jitter=true]
   * @param {number|null} [config.max_attempts=null]  - null=무한
   */
  constructor(config = {}) {
    this.strategy = config.strategy || 'exponential';
    this.baseDelayMs = config.base_delay_ms ?? 1000;
    this.multiplier = config.multiplier ?? 2;
    this.maxDelayMs = config.max_delay_ms ?? 60000;
    this.jitter = config.jitter !== false;
    this.maxAttempts = config.max_attempts ?? null;
  }

  /**
   * 재시도 가능 여부 판단
   * @param {Error} err
   * @returns {boolean}
   */
  shouldRetry(err) {
    return err.retryable !== false;
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
      delay = this.baseDelayMs * Math.pow(this.multiplier, attempt);
    } else {
      // linear
      delay = this.baseDelayMs * (attempt + 1);
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
    if (shutdownFlag.value) return Promise.resolve('shutdown');

    return new Promise(resolve => {
      const ac = new AbortController();

      const timer = setTimeout(() => {
        ac.abort();
        resolve('timeout');
      }, ms);

      const checker = setInterval(() => {
        if (shutdownFlag.value) {
          clearTimeout(timer);
          clearInterval(checker);
          ac.abort();
          resolve('shutdown');
        }
      }, 50);

      ac.signal.addEventListener('abort', () => clearInterval(checker), { once: true });
    });
  }
}

module.exports = RetryHandler;
