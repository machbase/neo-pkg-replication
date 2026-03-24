# repli-js REST API 명세

## 접근 방식

### HTTP 직접 접근 (`src/admin/http_server.js`)

`neo-admin.js` 실행 시 `conf.d/server.json`의 `internalPort`로 HTTP 서버가 열린다.

```
http://127.0.0.1:{internalPort}/api/replicators
```

### CGI 접근 (`cgi-bin/*.js`)

machbase-neo web-ui의 cgi-bin을 통해 접근한다.
CGI 파일은 요청을 내부 HTTP 서버(`internalPort`)로 포워딩한다.

| CGI 파일 | 메서드 | 설명 |
|----------|--------|------|
| `replicators.js` | GET, POST | 목록 조회 / 등록 |
| `replicator.js?name=xxx` | GET, PUT, DELETE | 단건 조회 / 수정 / 제거 |
| `replicator-start.js?name=xxx` | POST | 시작 |
| `replicator-stop.js?name=xxx` | POST | 종료 |

**Content-Type**: `application/json`

### conf.d/server.json

```json
{
  "internalPort": 57321
}
```

`internalPort` 미설정 시 `neo-admin.js` 시작 실패.

---

## 공통 응답 구조

```json
{
  "ok":     true | false,
  "reason": "<오류 메시지 | null>",
  "data":   "<object | array | null>"
}
```

| 필드 | 설명 |
|------|------|
| `ok` | `true` (성공) / `false` (실패) |
| `reason` | 실패 시 오류 메시지, 성공 시 생략 |
| `data` | 성공 시 응답 데이터, 없으면 생략 |

---

## 공통 오류 코드

| HTTP 상태 | 원인 |
|-----------|------|
| 400 | 필수 파라미터 누락 |
| 404 | 리소스가 존재하지 않음 |
| 405 | 허용되지 않는 HTTP 메서드 |
| 409 | duplicate replicator id |
| 500 | 서버 내부 오류 |
| 503 | internalPort 미설정 (CGI 전용) |

---

## Replicator 객체

각 replicator는 `conf.d/` 디렉토리의 JSON 파일 하나에 대응한다.
`name`은 파일명에서 `.json` 확장자를 제거한 값이다.

### ReplicatorConfig

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| `id` | string \| null | | `"{source.table}_{target.table}"` | replicator 고유 ID. 미설정 시 자동 생성. 중복 불가. |
| `source` | object | ✓ | — | 소스 DB + 테이블 설정 |
| `source.host` | string | ✓ | — | 소스 DB 호스트 |
| `source.port` | number | ✓ | — | 소스 DB 포트 |
| `source.user` | string | ✓ | — | 소스 DB 사용자명 |
| `source.password` | string | ✓ | — | 소스 DB 비밀번호 |
| `source.table` | string | ✓ | — | 원본 테이블명 |
| `source.columns` | string[] \| null | | null | SELECT 컬럼 목록 (null=전체). TAG 테이블이면 NAME, TIME 필수 포함. |
| `source.filter` | object[] \| null | | null | WHERE절 필터 목록 |
| `source.transform` | object[] \| null | | null | read 후 값 변환 목록 |
| `target` | object | ✓ | — | 대상 DB + 테이블 설정 |
| `target.host` | string | ✓ | — | 대상 DB 호스트 |
| `target.port` | number | ✓ | — | 대상 DB 포트 |
| `target.user` | string | ✓ | — | 대상 DB 사용자명 |
| `target.password` | string | ✓ | — | 대상 DB 비밀번호 |
| `target.table` | string | ✓ | — | 대상 테이블명. `autoCreate: true`이면 빈 문자열 허용 (source.table 이름 사용). |
| `target.autoCreate` | boolean | | false | 대상 테이블 미존재 시 src 스키마로 자동 생성 |
| `shutdownTimeoutMs` | number | | 30000 | 종료 대기 타임아웃 (ms) |
| `startMode` | string | | `"full"` | `"full"` \| `"now"` \| `"ridAfter"` |
| `ridAfter` | number \| null | | null | `startMode: "ridAfter"` 시 기준 RID |
| `queryLimit` | number | | 5000 | 배치당 최대 레코드 수 |
| `ridRangeSize` | number | | 50000 | RID 범위 힌트 크기 |
| `pollIntervalMs` | number | | 1000 | 폴링 주기 (ms) |
| `onSaveFailure` | string | | `"continue"` | `"continue"` \| `"abort"` |
| `integrity` | boolean \| null | | null | `false`=비활성화, 그 외=활성화 — TAG 테이블 STARTUP_INTEGRITY 단계 제어 |
| `metaSync` | boolean | | true | TAG 테이블 복제 시작 전 META 동기화 여부 |
| `retry` | object \| null | | null | RetryConfig 참조 |

### RetryConfig

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `maxAttempts` | number | 5 | 최대 재시도 횟수 |
| `baseDelayMs` | number | 100 | 초기 재시도 지연 (ms) |
| `maxDelayMs` | number | 30000 | 최대 재시도 지연 (ms) |

### LoggingConfig

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `level` | string | `"info"` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` |
| `stdout` | boolean | true | 표준 출력 여부 |
| `file.enabled` | boolean | false | 파일 출력 여부 |
| `file.directory` | string | `"/work/logs"` | 로그 파일 디렉토리 (절대경로) |

---

## 엔드포인트

### GET /api/replicators

등록된 replicator 전체 목록 조회.

**응답 200**
```json
{
  "ok": true,
  "data": [
    { "name": "test", "status": "running" },
    { "name": "prod", "status": "stopped" }
  ]
}
```

| 필드 | 설명 |
|------|------|
| `name` | conf.d 파일명 (확장자 제외) |
| `status` | `"running"` \| `"stopped"` \| `"stopping"` |

---

### GET /api/replicators/:name

특정 replicator 조회.

**응답 200**
```json
{
  "ok": true,
  "data": {
    "name": "test",
    "status": "running",
    "config": {
      "source": { "host": "192.168.1.1", "port": 5656, "user": "SYS", "table": "TAG" },
      "target": { "host": "192.168.1.2", "port": 5656, "user": "SYS", "table": "TAG_COPY" },
      "startMode": "full",
      "pollIntervalMs": 1000
    }
  }
}
```

**응답 404**
```json
{ "ok": false, "reason": "not found" }
```

---

### POST /api/replicators

새 replicator 등록. `conf.d/{name}.json` 파일로 저장되며 `stopped` 상태로 등록된다.

**요청 본문**
```json
{
  "name": "prod",
  "config": {
    "source": { "host": "10.0.0.1", "port": 5656, "user": "SYS", "password": "MANAGER", "table": "TAG" },
    "target": { "host": "10.0.0.2", "port": 5656, "user": "SYS", "password": "MANAGER", "table": "TAG2" },
    "startMode": "full",
    "pollIntervalMs": 1000
  }
}
```

**응답 201**
```json
{
  "ok": true,
  "data": { "name": "prod", "status": "stopped" }
}
```

**응답 500** — name 중복 또는 파일 저장 실패

---

### PUT /api/replicators/:name

replicator 설정 수정. `stopped` 상태일 때만 가능. `conf.d/{name}.json` 파일이 갱신된다.

**요청 본문**: ReplicatorConfig 형식

**응답 200**
```json
{
  "ok": true,
  "data": { "name": "prod", "status": "stopped" }
}
```

**응답 500** — 실행 중이거나 미존재

---

### DELETE /api/replicators/:name

replicator 제거. `stopped` 상태일 때만 가능. `conf.d/{name}.json` 파일도 삭제된다.

**응답 200**
```json
{ "ok": true }
```

**응답 500** — 실행 중이거나 미존재

---

### POST /api/replicators/:name/start

replicator 시작.

**응답 200**
```json
{
  "ok": true,
  "data": { "name": "prod", "status": "running" }
}
```

**응답 500** — 이미 실행 중이거나 미존재

---

### POST /api/replicators/:name/stop

replicator 종료 요청. 비동기 — 실행 중인 배치가 완료되면 실제 종료된다.

**응답 200**
```json
{
  "ok": true,
  "data": { "name": "prod", "status": "stopping" }
}
```

**응답 500** — 실행 중이 아니거나 미존재
