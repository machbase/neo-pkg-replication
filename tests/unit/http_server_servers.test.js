'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { HttpServer } = require('../../src/api/http_server.js');
const { MachbaseClient } = require('../../src/db/client.js');

// ─── 테스트 헬퍼 ──────────────────────────────────────────────────────────────

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
 * servers 배열을 직접 조작 가능한 config mock 반환
 */
function makeServer(initialServers = [], initialJobs = []) {
  const servers = initialServers.map(s => ({ ...s }));
  const jobs = initialJobs.map(j => ({ ...j }));

  const registry = new Map();
  const scheduler = {
    registry,
    listEntries: () => Array.from(registry.values()),
    getEntry: (id) => registry.get(id),
    start: (id) => { const e = registry.get(id); if (e) e.status = 'running'; },
    stop: async (id) => { const e = registry.get(id); if (e) e.status = 'stopped'; },
    update: (jobConfig) => { const e = registry.get(jobConfig.id); if (e) e.jobConfig = jobConfig; },
    unregister: (id) => registry.delete(id),
  };

  const config = {
    servers,
    replication: { jobs },
    addServer(raw) {
      if (!raw.name) throw new Error(`servers[].name is required`);
      if (!raw.host) throw new Error(`servers.${raw.name}.host is required`);
      if (!raw.port) throw new Error(`servers.${raw.name}.port is required`);
      if (!raw.user) throw new Error(`servers.${raw.name}.user is required`);
      if (raw.password === undefined) throw new Error(`servers.${raw.name}.password is required`);
      if (servers.find(s => s.name === raw.name))
        throw new Error(`Server '${raw.name}' already exists`);
      const srv = { name: raw.name, host: raw.host, port: raw.port, user: raw.user, password: raw.password };
      servers.push(srv);
      return srv;
    },
    updateServer(name, raw) {
      const idx = servers.findIndex(s => s.name === name);
      if (idx === -1) throw new Error(`Server '${name}' not found`);
      if (!raw.host) throw new Error(`servers.${name}.host is required`);
      const srv = { name, host: raw.host, port: raw.port ?? servers[idx].port, user: raw.user ?? servers[idx].user, password: raw.password ?? servers[idx].password };
      servers[idx] = srv;
      return srv;
    },
    removeServer(name) {
      const idx = servers.findIndex(s => s.name === name);
      if (idx === -1) throw new Error(`Server '${name}' not found`);
      servers.splice(idx, 1);
    },
    save: async () => {},
  };

  const server = new HttpServer(scheduler, config);
  return { server, scheduler, config, registry, servers };
}

// ─── GET /api/servers ──────────────────────────────────────────────────────────

describe('HttpServer — GET /api/servers', () => {
  test('빈 목록 → data: []', async () => {
    const { server } = makeServer();
    const port = 19120;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
    } finally {
      server.stop();
    }
  });

  test('2개 등록 → data 길이 2, password 미포함', async () => {
    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'SECRET' },
      { name: 'dst', host: '127.0.0.2', port: 5656, user: 'SYS', password: 'SECRET' },
    ]);
    const port = 19121;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 2);
      assert.equal(res.body.data[0].password, undefined, 'password 필드 없어야 함');
      assert.equal(res.body.data[1].password, undefined, 'password 필드 없어야 함');
      assert.equal(res.body.data[0].name, 'src');
    } finally {
      server.stop();
    }
  });
});

// ─── GET /api/servers/:name ────────────────────────────────────────────────────

describe('HttpServer — GET /api/servers/:name', () => {
  test('존재하는 서버 → 200 + ServerResponse', async () => {
    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19122;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/src`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.name, 'src');
      assert.equal(res.body.data.host, '127.0.0.1');
      assert.equal(res.body.data.password, undefined);
    } finally {
      server.stop();
    }
  });

  test('존재하지 않는 서버 → 404', async () => {
    const { server } = makeServer();
    const port = 19123;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/ghost`);
      assert.equal(res.status, 404);
      assert.ok(res.body.reason);
    } finally {
      server.stop();
    }
  });
});

// ─── POST /api/servers ─────────────────────────────────────────────────────────

describe('HttpServer — POST /api/servers', () => {
  test('정상 생성 → 201 + ServerResponse', async () => {
    const { server } = makeServer();
    const port = 19124;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/servers`, {
        name: 'new', host: '10.0.0.1', port: 5656, user: 'SYS', password: 'PASS',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.name, 'new');
      assert.equal(res.body.data.host, '10.0.0.1');
      assert.equal(res.body.data.password, undefined);
    } finally {
      server.stop();
    }
  });

  test('중복 name → 409', async () => {
    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19125;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/servers`, {
        name: 'src', host: '10.0.0.1', port: 5656, user: 'SYS', password: 'PASS',
      });
      assert.equal(res.status, 409);
      assert.ok(res.body.reason);
    } finally {
      server.stop();
    }
  });

  test('검증 오류(host 없음) → 400', async () => {
    const { server } = makeServer();
    const port = 19126;
    server.start(port, {});
    try {
      const res = await request('POST', `http://127.0.0.1:${port}/api/servers`, {
        name: 'bad', port: 5656, user: 'SYS', password: 'PASS',
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.reason);
    } finally {
      server.stop();
    }
  });
});

// ─── PUT /api/servers/:name ────────────────────────────────────────────────────

describe('HttpServer — PUT /api/servers/:name', () => {
  test('정상 업데이트 → 200 + ServerResponse', async () => {
    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19127;
    server.start(port, {});
    try {
      const res = await request('PUT', `http://127.0.0.1:${port}/api/servers/src`, {
        host: '192.168.1.1', port: 5656, user: 'SYS', password: 'MANAGER',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.host, '192.168.1.1');
      assert.equal(res.body.data.name, 'src');
    } finally {
      server.stop();
    }
  });

  test('존재하지 않는 서버 → 404', async () => {
    const { server } = makeServer();
    const port = 19128;
    server.start(port, {});
    try {
      const res = await request('PUT', `http://127.0.0.1:${port}/api/servers/ghost`, {
        host: '10.0.0.1', port: 5656, user: 'SYS', password: 'PASS',
      });
      assert.equal(res.status, 404);
      assert.ok(res.body.reason);
    } finally {
      server.stop();
    }
  });

  test('검증 오류(host 없음) → 400', async () => {
    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19129;
    server.start(port, {});
    try {
      const res = await request('PUT', `http://127.0.0.1:${port}/api/servers/src`, {
        port: 5656, user: 'SYS', password: 'MANAGER',
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.reason);
    } finally {
      server.stop();
    }
  });
});

// ─── DELETE /api/servers/:name ─────────────────────────────────────────────────

describe('HttpServer — DELETE /api/servers/:name', () => {
  test('정상 삭제 → 204', async () => {
    const { server, servers } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19130;
    server.start(port, {});
    try {
      const res = await request('DELETE', `http://127.0.0.1:${port}/api/servers/src`);
      assert.equal(res.status, 204);
      assert.equal(servers.length, 0);
    } finally {
      server.stop();
    }
  });

  test('존재하지 않는 서버 → 404', async () => {
    const { server } = makeServer();
    const port = 19131;
    server.start(port, {});
    try {
      const res = await request('DELETE', `http://127.0.0.1:${port}/api/servers/ghost`);
      assert.equal(res.status, 404);
    } finally {
      server.stop();
    }
  });

  test('job이 참조 중 → 409', async () => {
    const { server } = makeServer(
      [{ name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' }],
      [{ id: 'job-1', source: { server: 'src' }, target: { server: 'dst' } }]
    );
    const port = 19132;
    server.start(port, {});
    try {
      const res = await request('DELETE', `http://127.0.0.1:${port}/api/servers/src`);
      assert.equal(res.status, 409);
      assert.ok(res.body.reason);
    } finally {
      server.stop();
    }
  });
});

// ─── GET /api/servers/:name/health ─────────────────────────────────────────────

describe('HttpServer — GET /api/servers/:name/health', () => {
  test('연결 성공 → ok: true', async () => {
    const origConnect = MachbaseClient.prototype.connect;
    const origClose = MachbaseClient.prototype.close;
    MachbaseClient.prototype.connect = async function() {};
    MachbaseClient.prototype.close = async function() {};

    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19133;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/src/health`);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data, null);
      assert.equal(res.body.reason, null);
    } finally {
      server.stop();
      MachbaseClient.prototype.connect = origConnect;
      MachbaseClient.prototype.close = origClose;
    }
  });

  test('연결 실패 → ok: false, reason에 메시지', async () => {
    const origConnect = MachbaseClient.prototype.connect;
    MachbaseClient.prototype.connect = async function() { throw new Error('connection refused'); };

    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19134;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/src/health`);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.data, null);
      assert.ok(res.body.reason, 'reason 필드가 있어야 함');
    } finally {
      server.stop();
      MachbaseClient.prototype.connect = origConnect;
    }
  });

  test('서버 없음 → 404', async () => {
    const { server } = makeServer();
    const port = 19135;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/ghost/health`);
      assert.equal(res.status, 404);
    } finally {
      server.stop();
    }
  });
});

// ─── GET /api/servers/:name/tables ─────────────────────────────────────────────

describe('HttpServer — GET /api/servers/:name/tables', () => {
  test('테이블 목록 반환', async () => {
    const origConnect = MachbaseClient.prototype.connect;
    const origClose = MachbaseClient.prototype.close;
    const origSelectAll = MachbaseClient.prototype.selectAllTables;
    MachbaseClient.prototype.connect = async function() {};
    MachbaseClient.prototype.close = async function() {};
    MachbaseClient.prototype.selectAllTables = async function() {
      return [
        { NAME: 'TAG', TYPE: 6 },
        { NAME: 'LOG_DATA', TYPE: 0 },
      ];
    };

    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19136;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/src/tables`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 2);
      assert.equal(res.body.data[0].name, 'TAG');
      assert.equal(res.body.data[0].type, 'TAG');
      assert.equal(res.body.data[1].name, 'LOG_DATA');
      assert.equal(res.body.data[1].type, 'LOG');
    } finally {
      server.stop();
      MachbaseClient.prototype.connect = origConnect;
      MachbaseClient.prototype.close = origClose;
      MachbaseClient.prototype.selectAllTables = origSelectAll;
    }
  });

  test('서버 없음 → 404', async () => {
    const { server } = makeServer();
    const port = 19137;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/ghost/tables`);
      assert.equal(res.status, 404);
    } finally {
      server.stop();
    }
  });

  test('connect 오류 → 500', async () => {
    const origConnect = MachbaseClient.prototype.connect;
    MachbaseClient.prototype.connect = async function() { throw new Error('connection refused'); };

    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19138;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/src/tables`);
      assert.equal(res.status, 500);
      assert.ok(res.body.reason);
    } finally {
      server.stop();
      MachbaseClient.prototype.connect = origConnect;
    }
  });
});

// ─── GET /api/servers/:name/tables/:table/schema ────────────────────────────────

describe('HttpServer — GET /api/servers/:name/tables/:table/schema', () => {
  test('컬럼 목록 반환', async () => {
    const origConnect = MachbaseClient.prototype.connect;
    const origClose = MachbaseClient.prototype.close;
    const origSelectCols = MachbaseClient.prototype.selectColumnsByTableName;
    MachbaseClient.prototype.connect = async function() {};
    MachbaseClient.prototype.close = async function() {};
    MachbaseClient.prototype.selectColumnsByTableName = async function() {
      return [
        { NAME: 'TIME', TYPE: 6, ID: 1, LENGTH: 0 },
        { NAME: 'VALUE', TYPE: 20, ID: 2, LENGTH: 0 },
      ];
    };

    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19139;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/src/tables/TAG/schema`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 2);
      assert.equal(res.body.data[0].name, 'TIME');
      assert.equal(res.body.data[0].type, 'int64');
      assert.equal(res.body.data[1].name, 'VALUE');
      assert.equal(res.body.data[1].type, 'float64');
    } finally {
      server.stop();
      MachbaseClient.prototype.connect = origConnect;
      MachbaseClient.prototype.close = origClose;
      MachbaseClient.prototype.selectColumnsByTableName = origSelectCols;
    }
  });

  test('테이블 없음(빈 결과) → 404', async () => {
    const origConnect = MachbaseClient.prototype.connect;
    const origClose = MachbaseClient.prototype.close;
    const origSelectCols = MachbaseClient.prototype.selectColumnsByTableName;
    MachbaseClient.prototype.connect = async function() {};
    MachbaseClient.prototype.close = async function() {};
    MachbaseClient.prototype.selectColumnsByTableName = async function() { return []; };

    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19140;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/src/tables/NONEXISTENT/schema`);
      assert.equal(res.status, 404);
      assert.ok(res.body.reason);
    } finally {
      server.stop();
      MachbaseClient.prototype.connect = origConnect;
      MachbaseClient.prototype.close = origClose;
      MachbaseClient.prototype.selectColumnsByTableName = origSelectCols;
    }
  });

  test('서버 없음 → 404', async () => {
    const { server } = makeServer();
    const port = 19141;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/ghost/tables/TAG/schema`);
      assert.equal(res.status, 404);
    } finally {
      server.stop();
    }
  });

  test('connect 오류 → 500', async () => {
    const origConnect = MachbaseClient.prototype.connect;
    MachbaseClient.prototype.connect = async function() { throw new Error('connection refused'); };

    const { server } = makeServer([
      { name: 'src', host: '127.0.0.1', port: 5656, user: 'SYS', password: 'MANAGER' },
    ]);
    const port = 19142;
    server.start(port, {});
    try {
      const res = await request('GET', `http://127.0.0.1:${port}/api/servers/src/tables/TAG/schema`);
      assert.equal(res.status, 500);
      assert.ok(res.body.reason);
    } finally {
      server.stop();
      MachbaseClient.prototype.connect = origConnect;
    }
  });
});
