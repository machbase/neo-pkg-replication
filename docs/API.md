# repli-js REST API 명세

**Base URL**: `http://{host}:{port}/api`
**기본 포트**: `8080` (config.json `api.port`로 변경 가능)
**Content-Type**: `application/json`

---

## 공통 응답 구조

모든 응답은 아래 구조를 따른다.

```json
{
  "data":   <object | array | null>,
  "reason": <string | null>
}
```

| 필드 | 설명 |
|------|------|
| `data` | 성공 시 응답 데이터. 실패 시 `null`. |
| `reason` | 실패 시 오류 메시지. 성공 시 `null`. |

---

## 공통 오류 코드

| HTTP 상태 | 원인 |
|-----------|------|
| 400 | 요청 본문이 유효하지 않음 (config 검증 실패) |
| 404 | 해당 id의 job이 존재하지 않음 |
| 409 | 상태 충돌 (이미 존재, 실행 중, 미실행 등) |
| 500 | 서버 내부 오류 |

---

## Job 객체

### JobConfig

| 필드 | 타입 | 설명 |
|------|------|------|
| `id` | string | 고유 식별자 |
| `shutdown_timeout_ms` | number | 종료 대기 타임아웃 (ms), 기본 30000 |
| `source` | object | 소스 설정 |
| `source.server` | string | servers 배열의 name 참조 |
| `source.table` | string | 원본 테이블명 |
| `source.columns` | string[] \| null | SELECT 컬럼 목록 (null=전체) |
| `source.tag_identifier` | object | 태그명 식별자 (`mode`: prefix/suffix/none, `value`: string) |
| `target` | object | 대상 설정 |
| `target.server` | string | servers 배열의 name 참조 |
| `target.table` | string | 대상 테이블명 |
| `query_limit` | number | 배치당 최대 레코드 수, 기본 5000 |
| `rid_range_size` | number | RID 범위 힌트 크기, 기본 50000 |
| `poll_interval_ms` | number | 폴링 주기 (ms), 기본 1000 |
| `start_mode` | string | `full` \| `now` \| `rid_after` |
| `rid_after` | string \| null | start_mode=rid_after 시 기준 RID |
| `on_save_failure` | string | `continue` \| `abort` |
| `integrity` | object \| null | `{ enabled: boolean }` |
| `retry` | object \| null | `{ strategy, max_attempts, base_delay_ms, max_delay_ms, multiplier }` |

---

## 엔드포인트

### GET /api/jobs

전체 job 목록 조회.

**응답 200**
```json
{
  "data": [
    {
      "id": "job-1",
      "status": "stopped",
      "jobConfig": { ... }
    }
  ],
  "reason": null
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `data[].id` | string | job id |
| `data[].status` | string | `running` \| `stopped` |
| `data[].jobConfig` | JobConfig | job 설정 전체 |

---

### GET /api/jobs/:id

특정 job 조회.

**응답 200**
```json
{
  "data": {
    "id": "job-1",
    "status": "stopped",
    "jobConfig": { ... }
  },
  "reason": null
}
```

**응답 404**
```json
{ "data": null, "reason": "Job 'job-1' not found" }
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
  "start_mode": "full"
}
```

**응답 201**
```json
{
  "data": { "id": "job-2", "status": "stopped" },
  "reason": null
}
```

**응답 400** — config 검증 실패
```json
{ "data": null, "reason": "job.source.table is required ..." }
```

**응답 409** — id 중복
```json
{ "data": null, "reason": "Job 'job-2' already exists" }
```

---

### PUT /api/jobs/:id

기존 job 설정 수정. `stopped` 상태일 때만 가능.

**요청 본문**: JobConfig 형식 (id 제외 가능, path param으로 대체)

**응답 200**
```json
{
  "data": { "id": "job-1", "status": "stopped" },
  "reason": null
}
```

**응답 404** — job 없음
**응답 409** — job이 실행 중
```json
{ "data": null, "reason": "Job 'job-1' is running" }
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
  "data": { "id": "job-1", "status": "running" },
  "reason": null
}
```

**응답 404** — job 없음
**응답 409** — 이미 실행 중
```json
{ "data": null, "reason": "Job 'job-1' is already running" }
```

---

### POST /api/jobs/:id/stop

job 중지. 실행 중인 worker가 현재 배치를 완료할 때까지 대기 후 응답한다.

**응답 200**
```json
{
  "data": { "id": "job-1", "status": "stopped" },
  "reason": null
}
```

**응답 404** — job 없음
**응답 409** — 실행 중이 아님
```json
{ "data": null, "reason": "Job 'job-1' is not running" }
```
