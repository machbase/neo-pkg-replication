'use strict';

const { JobScheduler } = require('./job.js');
const { getInstance: getLogger } = require('./lib/logger.js');

// ─── Replicator ───────────────────────────────────────────────────────────────

class Replicator {
  constructor(config) {
    this.config = config;
    this.scheduler = new JobScheduler(config.servers);
    this.httpServer = null;
  }

  _startShutdownTimer(shutdownTimeoutMs) {
    const handle = setTimeout(() => {
      getLogger().warn('replicator', { msg: `shutdown timeout (${shutdownTimeoutMs}ms) exceeded, forcing exit` });
      process.exit(1);
    }, shutdownTimeoutMs);
    // Node.js 프로세스 종료를 막지 않도록 unref
    if (handle.unref) handle.unref();
    return handle;
  }

  async run() {
    const { config } = this;
    const shutdownFlag = { value: false };

    // shutdownTimeoutMs: 모든 job 중 최댓값 사용, 없으면 기본값
    let shutdownTimeoutMs = 30000;
    const maxTimeout = Math.max(0, ...config.replication.jobs.map(j => j.shutdownTimeoutMs || 0));
    if (maxTimeout > 0) shutdownTimeoutMs = maxTimeout;

    let timeoutHandle;
    const startShutdown = async (signal) => {
      if (shutdownFlag.value) return;
      getLogger().info('replicator', { msg: `${signal} received, graceful shutdown initiated` });
      shutdownFlag.value = true;
      timeoutHandle = this._startShutdownTimer(shutdownTimeoutMs);
      await this.scheduler.stopAll();
      if (this.httpServer) this.httpServer.stop();
    };

    process.once('SIGTERM', () => startShutdown('SIGTERM'));
    process.once('SIGINT', () => startShutdown('SIGINT'));

    getLogger().banner(`repli starting — ${config.replication.jobs.length} job(s) configured`);

    // config에서 로드된 job들을 scheduler에 등록 (stopped 상태)
    for (const jobConfig of config.replication.jobs) {
      if (!this.scheduler.registry.has(jobConfig.id)) {
        this.scheduler.register(jobConfig);
      }
    }

    // API 서버 시작
    if (config.api?.enabled) {
      const { HttpServer } = require('./api/http_server.js');
      this.httpServer = new HttpServer(this.scheduler, config);
      this.httpServer.start(config.api.port, config.api.cors);
    }

    // job은 자동 시작하지 않음 — API를 통해 개별 시작
    await new Promise(resolve => {
      const check = () => { if (shutdownFlag.value) resolve(); else setTimeout(check, 500); };
      check();
    });

    clearTimeout(timeoutHandle);
    process.exit(0);
  }
}

module.exports = { Replicator };
