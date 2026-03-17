'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { HttpServer } = require('../../src/api/http_server.js');

// ─── 테스트 헬퍼 ──────────────────────────────────────────────────────────────

/**
 * JSON HTTP 요청 유틸리티
 */
function request(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * HttpServer + mock scheduler/config 생성
 */
function makeServer() {
  // JobScheduler mock
  const registry = new Map();
  const scheduler = {
    registry,
    listEntries: () => Array.from(registry.values()),
    getEntry: (id) => registry.get(id),
    start: (id) => {
      const entry = registry.get(id);
      if (entry) entry.status = 'running';
    },
    stop: async (id) => {
      const entry = registry.get(id);
      if (entry) entry.status = 'stopped';
    },
    update: (jobConfig) => {
      const entry = registry.get(jobConfig.id);
      if (entry) entry.jobConfig = jobConfig;
    },
    unregister: (id) => registry.delete(id),
  };

  // Config mock
  const config = {
    addJob: (rawJob) => {
      const jobConfig = { id: rawJob.id, source: rawJob.source, target: rawJob.target };
      return jobConfig;
    },
    updateJob: (id, rawJob) => {
      return { id, ...rawJob };
    },
    removeJob: (id) => {},
    save: async () => {},
  };

  const server = new HttpServer(scheduler, config);
  return { server, scheduler, config, registry };
}

// ─── GET /api/jobs ─────────────────────────────────────────────────────────────

describe('HttpServer — GET /api/jobs', () => {
  test('빈 registry → data: []', async () => {
    const { server } = makeServer();
    const port = 19101;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/jobs`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
    } finally {
      server.stop();
    }
  });

  test('job 2개 등록 → data 길이 2', async () => {
    const { server, registry } = makeServer();
    registry.set('job-1', { jobConfig: { id: 'job-1' }, status: 'stopped' });
    registry.set('job-2', { jobConfig: { id: 'job-2' }, status: 'running' });
    const port = 19102;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/jobs`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 2);
    } finally {
      server.stop();
    }
  });
});

// ─── GET /api/jobs/:id ─────────────────────────────────────────────────────────

describe('HttpServer — GET /api/jobs/:id', () => {
  test('존재하는 job → 200 + JobResponse', async () => {
    const { server, registry } = makeServer();
    registry.set('job-x', { jobConfig: { id: 'job-x' }, status: 'stopped' });
    const port = 19103;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/jobs/job-x`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, 'job-x');
      assert.equal(res.body.data.status, 'stopped');
    } finally {
      server.stop();
    }
  });

  test('존재하지 않는 job → 404', async () => {
    const { server } = makeServer();
    const port = 19104;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/jobs/nonexistent`);
      assert.equal(res.status, 404);
      assert.ok(res.body.reason, 'reason 필드가 있어야 함');
    } finally {
      server.stop();
    }
  });
});

// ─── POST /api/jobs ────────────────────────────────────────────────────────────

describe('HttpServer — POST /api/jobs', () => {
  test('새 job 생성 → 201 + JobStatusResponse', async () => {
    const { server } = makeServer();
    const port = 19105;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/jobs`, {
        id: 'job-new',
        source: { server: 'src', table: 'TAG' },
        target: { server: 'dst', table: 'TAG2' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.id, 'job-new');
      assert.equal(res.body.data.status, 'stopped');
    } finally {
      server.stop();
    }
  });

  test('이미 존재하는 job id → 409', async () => {
    const { server, registry } = makeServer();
    registry.set('job-dup', { jobConfig: { id: 'job-dup' }, status: 'stopped' });
    const port = 19106;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/jobs`, {
        id: 'job-dup',
      });
      assert.equal(res.status, 409);
      assert.ok(res.body.reason);
    } finally {
      server.stop();
    }
  });

  test('config.addJob 오류 → 400', async () => {
    const { server, config } = makeServer();
    config.addJob = () => { throw new Error('validation failed'); };
    const port = 19107;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/jobs`, {
        id: 'job-bad',
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.reason.includes('validation failed'));
    } finally {
      server.stop();
    }
  });
});

// ─── PUT /api/jobs/:id ─────────────────────────────────────────────────────────

describe('HttpServer — PUT /api/jobs/:id', () => {
  test('stopped job 업데이트 → 200', async () => {
    const { server, registry } = makeServer();
    registry.set('job-upd', { jobConfig: { id: 'job-upd', target: { table: 'OLD' } }, status: 'stopped' });
    const port = 19108;
    server.start(port, {});
    try {
      const res = await request('PUT', `http://127.0.0.1:${port}/api/jobs/job-upd`, {
        target: { table: 'NEW' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, 'job-upd');
    } finally {
      server.stop();
    }
  });

  test('존재하지 않는 job → 404', async () => {
    const { server } = makeServer();
    const port = 19109;
    server.start(port, {});
    try {
      const res = await request('PUT', `http://127.0.0.1:${port}/api/jobs/ghost`, {});
      assert.equal(res.status, 404);
    } finally {
      server.stop();
    }
  });

  test('running job 업데이트 → 409', async () => {
    const { server, registry } = makeServer();
    registry.set('job-running', { jobConfig: { id: 'job-running' }, status: 'running' });
    const port = 19110;
    server.start(port, {});
    try {
      const res = await request('PUT', `http://127.0.0.1:${port}/api/jobs/job-running`, {});
      assert.equal(res.status, 409);
    } finally {
      server.stop();
    }
  });
});

// ─── DELETE /api/jobs/:id ──────────────────────────────────────────────────────

describe('HttpServer — DELETE /api/jobs/:id', () => {
  test('stopped job 삭제 → 204', async () => {
    const { server, registry } = makeServer();
    registry.set('job-del', { jobConfig: { id: 'job-del' }, status: 'stopped' });
    const port = 19111;
    server.start(port, {});
    try {
      const res = await request('DELETE', `http://127.0.0.1:${port}/api/jobs/job-del`);
      assert.equal(res.status, 204);
      assert.equal(registry.has('job-del'), false);
    } finally {
      server.stop();
    }
  });

  test('존재하지 않는 job → 404', async () => {
    const { server } = makeServer();
    const port = 19112;
    server.start(port, {});
    try {
      const res = await request('DELETE', `http://127.0.0.1:${port}/api/jobs/ghost`);
      assert.equal(res.status, 404);
    } finally {
      server.stop();
    }
  });

  test('running job 삭제 → 409', async () => {
    const { server, registry } = makeServer();
    registry.set('job-run-del', { jobConfig: { id: 'job-run-del' }, status: 'running' });
    const port = 19113;
    server.start(port, {});
    try {
      const res = await request('DELETE', `http://127.0.0.1:${port}/api/jobs/job-run-del`);
      assert.equal(res.status, 409);
    } finally {
      server.stop();
    }
  });
});

// ─── POST /api/jobs/:id/start ──────────────────────────────────────────────────

describe('HttpServer — POST /api/jobs/:id/start', () => {
  test('stopped job 시작 → 200, status=running', async () => {
    const { server, registry } = makeServer();
    registry.set('job-start', { jobConfig: { id: 'job-start' }, status: 'stopped' });
    const port = 19114;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/jobs/job-start/start`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'running');
    } finally {
      server.stop();
    }
  });

  test('이미 running job 시작 → 409', async () => {
    const { server, registry } = makeServer();
    registry.set('job-already', { jobConfig: { id: 'job-already' }, status: 'running' });
    const port = 19115;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/jobs/job-already/start`);
      assert.equal(res.status, 409);
    } finally {
      server.stop();
    }
  });

  test('존재하지 않는 job 시작 → 404', async () => {
    const { server } = makeServer();
    const port = 19116;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/jobs/ghost/start`);
      assert.equal(res.status, 404);
    } finally {
      server.stop();
    }
  });
});

// ─── POST /api/jobs/:id/stop ───────────────────────────────────────────────────

describe('HttpServer — POST /api/jobs/:id/stop', () => {
  test('running job 중지 → 200, status=stopped', async () => {
    const { server, registry } = makeServer();
    registry.set('job-stop', { jobConfig: { id: 'job-stop' }, status: 'running' });
    const port = 19117;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/jobs/job-stop/stop`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'stopped');
    } finally {
      server.stop();
    }
  });

  test('stopped job 중지 → 409', async () => {
    const { server, registry } = makeServer();
    registry.set('job-notrun', { jobConfig: { id: 'job-notrun' }, status: 'stopped' });
    const port = 19118;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/jobs/job-notrun/stop`);
      assert.equal(res.status, 409);
    } finally {
      server.stop();
    }
  });

  test('존재하지 않는 job 중지 → 404', async () => {
    const { server } = makeServer();
    const port = 19119;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/jobs/ghost/stop`);
      assert.equal(res.status, 404);
    } finally {
      server.stop();
    }
  });
});
