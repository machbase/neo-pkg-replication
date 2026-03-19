# repli-js REST API 명세

**Base URL**: `http://{host}:{port}/api`
**기본 포트**: `8080` (config.json `api.port`로 변경 가능)
**Content-Type**: `application/json`

---

## 공통 응답 구조

모든 응답은 아래 구조를 따른다.

```json
{
  "ok":     true | false,
  "reason": <string | null>,
  "data":   <object | array | null>
}
```

| 필드 | 설명 |
|------|------|
| `ok` | `true` (성공) 또는 `false` (실패) |
| `reason` | 실패 시 오류 메시지. 성공 시 `null`. |
| `data` | 성공 시 응답 데이터. 실패 시 `null`. |

F.E는 `ok === false` 여부만 확인하면 된다. `false`인 경우 `reason` 필드에 오류 메시지가 포함된다.

---

## 공통 오류 코드

| HTTP 상태 | 원인 |
|-----------|------|
| 400 | 요청 본문이 유효하지 않음 (config 검증 실패) |
| 404 | 리소스가 존재하지 않음 |
| 409 | 상태 충돌 (이미 존재, 실행 중, 미실행, 참조 중 등) |
| 500 | 서버 내부 오류 (DB 연결 실패 포함) |

---

## Server 객체

### ServerConfig (요청)

| 필드 | 타입 | 설명 |
|------|------|------|
| `name` | string | 고유 식별자 |
| `host` | string | DB 호스트 |
| `port` | number | DB 포트 |
| `user` | string | DB 사용자명 |
| `password` | string | DB 비밀번호 |

### ServerResponse (응답)

응답에서 `password` 필드는 항상 제외된다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `name` | string | 고유 식별자 |
| `host` | string | DB 호스트 |
| `port` | number | DB 포트 |
| `user` | string | DB 사용자명 |

---

## Job 객체

### JobConfig

| 필드 | 타입 | 설명 |
|------|------|------|
| `id` | string | 고유 식별자 |
| `shutdownTimeoutMs` | number | 종료 대기 타임아웃 (ms), 기본 30000 |
| `source` | object | 소스 설정 |
| `source.server` | string | servers 배열의 name 참조 |
| `source.table` | string | 원본 테이블명 |
| `source.columns` | string[] \| null | SELECT 컬럼 목록 (null=전체) |
| `source.tagIdentifier` | object | 태그명 식별자 (`mode`: prefix/suffix/none, `value`: string) |
| `target` | object | 대상 설정 |
| `target.server` | string | servers 배열의 name 참조 |
| `target.table` | string | 대상 테이블명. `autoCreate: true`이면 빈 문자열 허용 (소스 테이블명 사용). |
| `target.autoCreate` | boolean | `true`이면 대상 테이블 미존재 시 src 스키마로 자동 생성. 기본 `false`. |
| `queryLimit` | number | 배치당 최대 레코드 수, 기본 5000 |
| `ridRangeSize` | number | RID 범위 힌트 크기, 기본 50000 |
| `pollIntervalMs` | number | 폴링 주기 (ms), 기본 1000 |
| `startMode` | string | `full` \| `now` \| `ridAfter` |
| `ridAfter` | string \| null | startMode=ridAfter 시 기준 RID |
| `onSaveFailure` | string | `continue` \| `abort` |
| `integrity` | object \| null | `{ enabled: boolean }` |
| `retry` | object \| null | `{ strategy, maxAttempts, baseDelayMs, maxDelayMs, multiplier }` |

---

## 엔드포인트

### GET /api/servers

전체 서버 목록 조회.

**응답 200**
```json
{
  "ok": true,
  "reason": null,
  "data": [
    { "name": "src", "host": "127.0.0.1", "port": 5656, "user": "SYS" },
    { "name": "dst", "host": "127.0.0.2", "port": 5656, "user": "SYS" }
  ]
}
```

---

### GET /api/servers/:name

특정 서버 조회.

**응답 200**
```json
{
  "ok": true,
  "reason": null,
  "data": { "name": "src", "host": "127.0.0.1", "port": 5656, "user": "SYS" }
}
```

**응답 404**
```json
{ "ok": false, "reason": "Server 'src' not found", "data": null }
```

---

### POST /api/servers

새 서버 등록. config.json에 저장된다.

**요청 본문**: ServerConfig 형식

```json
{
  "name": "src2",
  "host": "10.0.0.1",
  "port": 5656,
  "user": "SYS",
  "password": "MANAGER"
}
```

**응답 201**
```json
{
  "ok": true,
  "reason": null,
  "data": { "name": "src2", "host": "10.0.0.1", "port": 5656, "user": "SYS" }
}
```

**응답 400** — 필드 누락 또는 검증 실패
**응답 409** — name 중복
```json
{ "ok": false, "reason": "Server 'src2' already exists", "data": null }
```

---

### PUT /api/servers/:name

서버 설정 수정. config.json에 저장된다.

**요청 본문**: ServerConfig 형식 (name 제외 가능, path param으로 대체)

**응답 200**
```json
{
  "ok": true,
  "reason": null,
  "data": { "name": "src", "host": "192.168.1.1", "port": 5656, "user": "SYS" }
}
```

**응답 400** — 검증 실패
**응답 404** — 서버 없음

---

### DELETE /api/servers/:name

서버 삭제. config.json에서 제거된다. 해당 서버를 참조하는 job이 있으면 삭제 불가.

**응답 204** — No Content

**응답 404** — 서버 없음
**응답 409** — job이 해당 서버를 참조 중
```json
{ "ok": false, "reason": "Server 'src' is referenced by job 'job-1'", "data": null }
```

---

### GET /api/servers/:name/tables

해당 서버에 실제 접속하여 사용자 테이블 목록(TAG/LOG 타입)을 조회한다. 내부 시스템 테이블(`_` 접두사)은 제외된다.

**응답 200**
```json
{
  "ok": true,
  "reason": null,
  "data": [
    { "name": "TAG", "type": "TAG" },
    { "name": "LOG_DATA", "type": "LOG" }
  ]
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `name` | string | 테이블명 |
| `type` | string | `TAG` \| `LOG` |

**응답 404** — 서버 없음
**응답 500** — DB 연결 실패
```json
{ "ok": false, "reason": "connection refused", "data": null }
```

---

### GET /api/servers/:name/tables/:table/schema

해당 서버에 접속하여 지정 테이블의 컬럼 스키마를 조회한다.

**응답 200**
```json
{
  "ok": true,
  "reason": null,
  "data": [
    { "name": "TIME",  "type": "int64",   "length": 0 },
    { "name": "VALUE", "type": "float64", "length": 0 },
    { "name": "TAG",   "type": "varchar", "length": 80 }
  ]
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `name` | string | 컬럼명 |
| `type` | string | appendOpen 프로토콜 타입 (`int32`, `int64`, `float64`, `varchar` 등) |
| `length` | number | VARCHAR 가변 길이 (고정 길이 타입은 0) |

**응답 404** — 서버 없음 또는 테이블 없음
**응답 500** — DB 연결 실패

---

### GET /api/servers/:name/health

해당 서버에 접속을 시도하여 연결 가능 여부를 확인한다. 연결 실패 시에도 HTTP 상태는 **항상 200**이다.

**응답 200 (연결 성공)**
```json
{ "ok": true, "reason": null, "data": null }
```

**응답 200 (연결 실패)**
```json
{ "ok": false, "reason": "connection refused", "data": null }
```

**응답 404** — 서버 없음

---

### GET /api/jobs

전체 job 목록 조회.

**응답 200**
```json
{
  "ok": true,
  "reason": null,
  "data": [
    {
      "id": "job-1",
      "status": "stopped",
      "autoStart": true,
      "shutdownTimeoutMs": 30000,
      "source": {
        "server": "src",
        "table": "TAG",
        "columns": null,
        "tagIdentifier": { "mode": "none", "value": "" }
      },
      "target": {
        "server": "dst",
        "table": "TAG2",
        "autoCreate": false
      },
      "startMode": "full",
      "ridAfter": null,
      "queryLimit": 5000,
      "ridRangeSize": 50000,
      "pollIntervalMs": 1000,
      "onSaveFailure": "continue",
      "integrity": { "enabled": true },
      "retry": {
        "strategy": "exponential",
        "maxAttempts": 5,
        "baseDelayMs": 100,
        "maxDelayMs": 30000,
        "multiplier": 2
      }
    }
  ]
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `data[].id` | string | job id |
| `data[].status` | string | `running` \| `stopped` |
| `data[].*` | - | JobConfig 필드 전체 포함 |

---

### GET /api/jobs/:id

특정 job 조회.

**응답 200**
```json
{
  "ok": true,
  "reason": null,
  "data": {
    "id": "job-1",
    "status": "stopped",
    "autoStart": true,
    "shutdownTimeoutMs": 30000,
    "source": {
      "server": "src",
      "table": "TAG",
      "columns": null,
      "tagIdentifier": { "mode": "none", "value": "" }
    },
    "target": {
      "server": "dst",
      "table": "TAG2",
      "autoCreate": false
    },
    "startMode": "full",
    "ridAfter": null,
    "queryLimit": 5000,
    "ridRangeSize": 50000,
    "pollIntervalMs": 1000,
    "onSaveFailure": "continue",
    "integrity": { "enabled": true },
    "retry": {
      "strategy": "exponential",
      "maxAttempts": 5,
      "baseDelayMs": 100,
      "maxDelayMs": 30000,
      "multiplier": 2
    }
  }
}
```

**응답 404**
```json
{ "ok": false, "reason": "Job 'job-1' not found", "data": null }
```

---

### POST /api/jobs

새 job 생성. 생성된 job은 `stopped` 상태이며 자동 시작되지 않는다.

**요청 본문**: JobConfig 형식 (id 필수)

```json
{
  "id": "job-2",
  "source": { "server": "src", "table": "TAG" },
  "target": { "server": "dst", "table": "TAG2" },
  "startMode": "full"
}
```

`autoCreate: true` 예시 (대상 테이블 없으면 자동 생성):

```json
{
  "id": "job-3",
  "source": { "server": "src", "table": "TAG" },
  "target": { "server": "dst", "table": "", "autoCreate": true },
  "startMode": "full"
}
```

**응답 201**
```json
{
  "ok": true,
  "reason": null,
  "data": {
    "id": "job-2",
    "status": "stopped",
    "autoStart": true,
    "shutdownTimeoutMs": 30000,
    "source": {
      "server": "src",
      "table": "TAG",
      "columns": null,
      "tagIdentifier": { "mode": "none", "value": "" }
    },
    "target": {
      "server": "dst",
      "table": "TAG2",
      "autoCreate": false
    },
    "startMode": "full",
    "ridAfter": null,
    "queryLimit": 5000,
    "ridRangeSize": 50000,
    "pollIntervalMs": 1000,
    "onSaveFailure": "continue",
    "integrity": null,
    "retry": null
  }
}
```

**응답 400** — config 검증 실패
```json
{ "ok": false, "reason": "job.source.table is required ...", "data": null }
```

**응답 409** — id 중복
```json
{ "ok": false, "reason": "Job 'job-2' already exists", "data": null }
```

---

### PUT /api/jobs/:id

기존 job 설정 수정. `stopped` 상태일 때만 가능.

**요청 본문**: JobConfig 형식 (id 제외 가능, path param으로 대체)

**응답 200**
```json
{
  "ok": true,
  "reason": null,
  "data": {
    "id": "job-1",
    "status": "stopped",
    "autoStart": true,
    "shutdownTimeoutMs": 30000,
    "source": {
      "server": "src",
      "table": "TAG",
      "columns": null,
      "tagIdentifier": { "mode": "none", "value": "" }
    },
    "target": {
      "server": "dst",
      "table": "TAG2",
      "autoCreate": false
    },
    "startMode": "full",
    "ridAfter": null,
    "queryLimit": 5000,
    "ridRangeSize": 50000,
    "pollIntervalMs": 1000,
    "onSaveFailure": "continue",
    "integrity": { "enabled": true },
    "retry": null
  }
}
```

**응답 404** — job 없음
**응답 409** — job이 실행 중

```json
{ "ok": false, "reason": "Job 'job-1' is running", "data": null }
```

---

### DELETE /api/jobs/:id

job 삭제. `stopped` 상태일 때만 가능.

**응답 204** — No Content

**응답 404** — job 없음
**응답 409** — job이 실행 중

---

### POST /api/jobs/:id/start

job 시작.

**응답 200**
```json
{
  "ok": true,
  "reason": null,
  "data": {
    "id": "job-1",
    "status": "running",
    "autoStart": true,
    "shutdownTimeoutMs": 30000,
    "source": {
      "server": "src",
      "table": "TAG",
      "columns": null,
      "tagIdentifier": { "mode": "none", "value": "" }
    },
    "target": {
      "server": "dst",
      "table": "TAG2",
      "autoCreate": false
    },
    "startMode": "full",
    "ridAfter": null,
    "queryLimit": 5000,
    "ridRangeSize": 50000,
    "pollIntervalMs": 1000,
    "onSaveFailure": "continue",
    "integrity": { "enabled": true },
    "retry": null
  }
}
```

**응답 404** — job 없음
**응답 409** — 이미 실행 중
```json
{ "ok": false, "reason": "Job 'job-1' is already running", "data": null }
```

---

### POST /api/jobs/:id/stop

job 중지. 실행 중인 worker가 현재 배치를 완료할 때까지 대기 후 응답한다.

**응답 200**
```json
{
  "ok": true,
  "reason": null,
  "data": {
    "id": "job-1",
    "status": "stopped",
    "autoStart": true,
    "shutdownTimeoutMs": 30000,
    "source": {
      "server": "src",
      "table": "TAG",
      "columns": null,
      "tagIdentifier": { "mode": "none", "value": "" }
    },
    "target": {
      "server": "dst",
      "table": "TAG2",
      "autoCreate": false
    },
    "startMode": "full",
    "ridAfter": null,
    "queryLimit": 5000,
    "ridRangeSize": 50000,
    "pollIntervalMs": 1000,
    "onSaveFailure": "continue",
    "integrity": { "enabled": true },
    "retry": null
  }
}
```

**응답 404** — job 없음
**응답 409** — 실행 중이 아님
```json
{ "ok": false, "reason": "Job 'job-1' is not running", "data": null }
```
