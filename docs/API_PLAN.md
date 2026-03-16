# Job CRUD REST API 추가

## Context

repli는 현재 CLI 전용 도구다. 외부에서 job을 제어할 수 있는 HTTP API가 필요하다.
config.json에 `api` 섹션을 추가하고, `Replicator`에 jobRegistry를 도입해 동적 제어를 지원한다.

---

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | /api/jobs | 전체 job 목록 + 실행 상태 |
| GET | /api/jobs/:id | 단건 job 조회 + 실행 상태 |
| POST | /api/jobs | job 추가 (config 저장 + 메모리 등록, status: stopped) |
| PUT | /api/jobs/:id | job 수정 (running이면 에러, config 저장 + 메모리 업데이트) |
| DELETE | /api/jobs/:id | job 삭제 (running이면 에러, config 삭제 + 메모리 제거) |
| POST | /api/jobs/:id/start | job 동적 시작 (stopped 상태일 때만) |
| POST | /api/jobs/:id/stop | job 동적 중지 (running 상태일 때만) |

**응답 형식**: JSON. 에러 시 `{ "error": "메시지" }`.

---

## 아키텍처

### Replicator 변경 (`job_runner.js`)

job별 독립 shutdownFlag + jobRegistry 도입.

```js
class Replicator {
  constructor(config, configPath) {
    this.config = config;           // 처리된 config (servers 등)
    this.configPath = configPath;   // raw config 저장용
    // id → { jobConfig, shutdownFlag, promise, status: 'running'|'stopped' }
    this.jobRegistry = new Map();
    this.globalShutdownFlag = { value: false };
  }

  // job 하나 시작 (내부용)
  _startJob(jobConfig) {
    const shutdownFlag = { value: false };
    const entry = { jobConfig, shutdownFlag, promise: null, status: 'running' };
    this.jobRegistry.set(jobConfig.id, entry);
    entry.promise = new Job(jobConfig, this.config.servers, shutdownFlag)
      .run()
      .catch(err => getLogger().error(...))
      .finally(() => { entry.status = 'stopped'; });
  }

  // job 중지 후 완료 대기 (내부용)
  async _stopJob(id) {
    const entry = this.jobRegistry.get(id);
    if (!entry || entry.status !== 'running') return;
    entry.shutdownFlag.value = true;
    await entry.promise;
  }

  async run() {
    // SIGTERM/SIGINT → globalShutdownFlag + 모든 entry.shutdownFlag.value = true
    // enabled job 모두 _startJob()
    // Promise.all(registry의 모든 entry.promise)
  }
}
```

---

## 변경 파일

### 1. `job_runner.js`

- `Replicator` 생성자: `configPath` 파라미터 추가, `jobRegistry`, `globalShutdownFlag` 도입
- `_startJob(jobConfig)` 추가
- `_stopJob(id)` 추가 (async, promise 완료 대기)
- `run()`:
  - enabled job → `_startJob()`으로 시작
  - SIGTERM/SIGINT 시 `globalShutdownFlag.value = true` + 모든 `entry.shutdownFlag.value = true`
  - `Promise.all(registry의 모든 entry.promise)`
- `module.exports`에 `Replicator` 유지 (기존 `Job`, `Worker` 포함)

### 2. `api/server.js` (신규)

Node.js 내장 `http` 모듈 사용. `ApiServer` 클래스.

```js
class ApiServer {
  constructor(replicator, configPath) { ... }
  start(port) { ... }   // http.createServer().listen(port)
  stop() { ... }        // server.close()
}
```

라우팅: `req.method` + `req.url` 파싱으로 직접 처리.

**핸들러 동작:**

- `GET /api/jobs`
  - `replicator.jobRegistry` 전체 반환
  - 응답: `[{ id, status, jobConfig }]`

- `GET /api/jobs/:id`
  - 없으면 404
  - 응답: `{ id, status, jobConfig }`

- `POST /api/jobs`
  - body 파싱 → `ConfigLoader._processJob()` 검증
  - id 중복이면 409
  - raw config에 job 추가 → `ConfigLoader.save()`
  - `jobRegistry`에 `{ jobConfig, status: 'stopped' }` 등록
  - 응답: 201

- `PUT /api/jobs/:id`
  - 없으면 404
  - `status === 'running'`이면 409
  - body 파싱 → `ConfigLoader._processJob()` 검증
  - raw config의 해당 job 교체 → `ConfigLoader.save()`
  - `jobRegistry` entry의 `jobConfig` 업데이트
  - 응답: 200

- `DELETE /api/jobs/:id`
  - 없으면 404
  - `status === 'running'`이면 409
  - raw config에서 제거 → `ConfigLoader.save()`
  - `jobRegistry`에서 제거
  - 응답: 204

- `POST /api/jobs/:id/start`
  - 없으면 404
  - `status === 'running'`이면 409
  - `replicator._startJob(entry.jobConfig)`
  - 응답: 200

- `POST /api/jobs/:id/stop`
  - 없으면 404
  - `status !== 'running'`이면 409
  - `await replicator._stopJob(id)`
  - 응답: 200

### 3. `config/config.js`

`ConfigLoader.save(filePath, rawConfig)` 정적 메서드 추가:
- `JSON.stringify(rawConfig, null, 2)`
- atomic write: `{filePath}.tmp` → `fs.rename` (CheckpointStore와 동일한 패턴)

`_processApi(raw)` 정적 메서드 추가:
```js
static _processApi(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    port: raw.port || 8080,
  };
}
```

`load()` 반환값에 `api: ConfigLoader._processApi(raw.api)` 추가.

### 4. `app.js`

```js
const replicator = new Replicator(config, configPath);

if (config.api?.enabled) {
  const { ApiServer } = require('./api/server.js');
  new ApiServer(replicator, configPath).start(config.api.port);
}

return replicator.run();
```

### 5. `config.json`

```json
{
  "api": { "enabled": true, "port": 8080 },
  ...
}
```

---

## raw config 읽기/쓰기 전략

- API 핸들러에서 raw config가 필요할 때마다 `fs.readFile(configPath)` + `JSON.parse`
- 수정 후 `ConfigLoader.save(configPath, rawConfig)`
- `_processJob()`은 `static`이므로 외부에서도 호출 가능

---

## 검증

```bash
# 단위 테스트
node --test tests/unit/*.test.js

# 수동 API 테스트
node app.js config.json &

curl http://localhost:8080/api/jobs
curl http://localhost:8080/api/jobs/job-1
curl -X POST http://localhost:8080/api/jobs/job-1/stop
curl -X POST http://localhost:8080/api/jobs/job-1/start
curl -X POST http://localhost:8080/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"id":"job-2","source":{"server":"src","table":"TAG"},"target":{"server":"dst","table":"TAG2"},"checkpoint":{"directory":"./checkpoints"}}'
curl -X PUT http://localhost:8080/api/jobs/job-2 \
  -H 'Content-Type: application/json' \
  -d '{"id":"job-2","source":{"server":"src","table":"TAG"},"target":{"server":"dst","table":"TAG3"},"checkpoint":{"directory":"./checkpoints"}}'
curl -X DELETE http://localhost:8080/api/jobs/job-2
```
