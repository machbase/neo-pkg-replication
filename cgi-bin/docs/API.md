# repli-js CGI API 명세

## 접근 방식

CGI 파일을 machbase-neo jsh로 직접 실행한다.
각 CGI 파일은 `conf.d/` 디렉토리를 직접 읽고 쓴다.

### jsh 직접 실행 (테스트용)

```bash
# 실행 위치: /home/machbase/repli
# 주의: -e 플래그는 반드시 스크립트 파일 앞에 위치해야 함

# GET 목록
../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=GET cgi-bin/replicators.js

# GET 단건
../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=GET -e QUERY_STRING=name=repli-a cgi-bin/replicator.js

# POST 등록
echo '{"name":"repli-b","config":{...}}' | \
  ../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=POST cgi-bin/replicators.js

# PUT 수정
echo '{...config...}' | \
  ../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=PUT -e QUERY_STRING=name=repli-a cgi-bin/replicator.js

# DELETE 삭제
../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=DELETE -e QUERY_STRING=name=repli-a cgi-bin/replicator.js

# POST 시작 (현재 503 반환 — 수동 실행 안내)
../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=POST -e QUERY_STRING=name=repli-a cgi-bin/replicator-start.js

# POST 종료 (현재 503 반환 — 수동 종료 안내)
../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=POST -e QUERY_STRING=name=repli-a cgi-bin/replicator-stop.js
```

### CGI 파일 목록

| CGI 파일 | 메서드 | 설명 |
|----------|--------|------|
| `replicators.js` | GET, POST | 목록 조회 / 등록 |
| `replicator.js?name=xxx` | GET, PUT, DELETE | 단건 조회 / 수정 / 제거 |
| `replicator-start.js?name=xxx` | POST | 시작 (데몬 연동 예정) |
| `replicator-stop.js?name=xxx` | POST | 종료 (데몬 연동 예정) |

---

## 공통 응답 구조

```json
{
  "ok":     true | false,
  "reason": "<오류 메시지>",
  "data":   "<object | array>"
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
| 409 | 이미 존재하는 name |
| 503 | 미구현 (start/stop 데몬 연동 전) |

---

## ReplicatorConfig

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| `id` | string \| null | | `"{source.table}_{target.table}"` | replicator 고유 ID. 미설정 시 자동 생성. |
| `logging` | object | | — | 로깅 설정 (LoggingConfig 참조) |
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
| `startMode` | string | | `"full"` | `"full"` \| `"now"` \| `"ridAfter"` |
| `ridAfter` | number \| null | | null | `startMode: "ridAfter"` 시 기준 RID |
| `pollIntervalMs` | number | | 1000 | 폴링 주기 (ms) |
| `queryLimit` | number | | 5000 | 배치당 최대 레코드 수 |
| `ridRangeSize` | number | | 50000 | RID 범위 힌트 크기 |
| `shutdownTimeoutMs` | number | | 30000 | 종료 대기 타임아웃 (ms) |
| `onSaveFailure` | string | | `"continue"` | `"continue"` \| `"abort"` |
| `integrity` | boolean \| null | | null | `false`=비활성화, 그 외=활성화 |
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
| `level` | string | `"info"` | `"trace"` \| `"debug"` \| `"info"` \| `"warn"` \| `"error"` |
| `stdout` | boolean | true | 표준 출력 여부 |
| `file.enabled` | boolean | false | 파일 출력 여부 |
| `file.directory` | string | `"/work/logs"` | 로그 파일 디렉토리 (절대경로) |

---

## 엔드포인트

### GET /cgi-bin/replicators

등록된 replicator 전체 목록과 config 조회.

**응답 200**
```json
{
  "ok": true,
  "data": [
    { "name": "repli-a", "config": { ... } },
    { "name": "repli-b", "config": { ... } }
  ]
}
```

---

### GET /cgi-bin/replicator?name=xxx

특정 replicator config 조회.

**응답 200**
```json
{
  "ok": true,
  "data": { "name": "repli-a", "config": { ... } }
}
```

**응답 404**
```json
{ "ok": false, "reason": "replicator 'xxx' not found" }
```

---

### POST /cgi-bin/replicators

새 replicator 등록. `conf.d/{name}.json` 파일로 저장된다.

**요청 본문**
```json
{
  "name": "repli-a",
  "config": {
    "id": "repli-a",
    "source": { "host": "...", "port": 5656, "user": "SYS", "password": "MANAGER", "table": "TAG" },
    "target": { "host": "...", "port": 5656, "user": "SYS", "password": "MANAGER", "table": "TAG_COPY", "autoCreate": true },
    "startMode": "now",
    "pollIntervalMs": 1000
  }
}
```

**응답 201**
```json
{ "ok": true, "data": { "name": "repli-a" } }
```

**응답 409** — 이미 존재하는 name

---

### PUT /cgi-bin/replicator?name=xxx

replicator config 수정. `conf.d/{name}.json` 파일이 갱신된다.

**요청 본문**: ReplicatorConfig 형식

**응답 200**
```json
{ "ok": true, "data": { "name": "repli-a" } }
```

---

### DELETE /cgi-bin/replicator?name=xxx

replicator 제거. `conf.d/{name}.json` 파일도 삭제된다.

**응답 200**
```json
{ "ok": true }
```

---

### POST /cgi-bin/replicator-start?name=xxx

replicator 시작. jsh 비동기 exec 지원 시 구현 예정.

현재는 503을 반환하며, 수동 실행 명령을 안내한다.

**응답 503**
```json
{ "ok": false, "reason": "daemon not supported yet. run manually: machbase-neo jsh cgi-bin/neo-repli.js cgi-bin/conf.d/{name}.json" }
```

**응답 404** — name이 존재하지 않음

---

### POST /cgi-bin/replicator-stop?name=xxx

replicator 종료. jsh 비동기 exec 지원 시 PID 파일 기반 SIGTERM으로 구현 예정.

현재는 503을 반환하며, 수동 종료 방법을 안내한다.

**응답 503**
```json
{ "ok": false, "reason": "daemon not supported yet. stop manually: kill $(cat cgi-bin/run/{name}.pid)" }
```

**응답 404** — name이 존재하지 않음
