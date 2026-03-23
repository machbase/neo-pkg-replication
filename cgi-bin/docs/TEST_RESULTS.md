# 테스트 결과 보고서

**프로젝트**: repli-js
**수행일**: 2026-03-19
**환경**: Node.js v22, CommonJS
**통합 테스트 DB**: 127.0.0.1:5656 (Machbase, SYS/MANAGER)

---

## 요약

| 구분 | 파일 수 | 테스트 수 | pass | fail | 실행 시간 |
|------|---------|----------|------|------|-----------|
| 단위 테스트 | 9개 | 187개 | **187** | 0 | ~0.6초 |
| 통합 테스트 (TAG) | 1개 | 11개 | **11** | 0 | ~51초 |
| 통합 테스트 (LOG) | 1개 | 8개 | **8** | 0 | ~7초 |
| 통합 테스트 (table) | 1개 | 17개 | **17** | 0 | — |
| **합계** | **13개** | **201개** | **201** | **0** | — |

> 통합 테스트는 127.0.0.1:5656 DB 접근 가능 시 실행.

---

## 단위 테스트 (187개 pass)

```
node --test tests/unit/*.test.js
```

### checkpoint.test.js — CheckpointStore (6개)

| # | 테스트 항목 |
|---|------------|
| 1 | load: 파일 없음 → `{ exists: false, err: null }` |
| 2 | save + load 라운드트립: BigInt rid 보존 |
| 3 | save + load: sourceServer, sourceTable 보존 |
| 4 | load: source.dataTable 불일치 → `{ exists: false, err }` |
| 5 | load: JSON 파싱 실패 → `{ exists: false, err }` |
| 6 | rid = 0n 저장 및 로드 |

### config.test.js — Config (51개)

| # | 테스트 항목 |
|---|------------|
| 1 | 정상 config 로드 |
| 2 | version != 3 → 오류 |
| 3 | servers 없음 → 빈 배열 |
| 4 | replication.jobs 없음 → 빈 배열 |
| 5 | 존재하지 않는 source server → 오류 |
| 6 | startMode=ridAfter + ridAfter 없음 → 오류 |
| 7 | startMode=ridAfter + ridAfter 있음 → 정상 로드 |
| 8 | job 필드 직접 지정: queryLimit, pollIntervalMs |
| 9 | 기본값 주입: queryLimit=5000, ridRangeSize=50000, shutdownTimeoutMs=30000 |
| 10 | ridRangeSize 사용자 설정 |
| 11 | ridRangeSize 비정수(0) → 오류 |
| 12 | job.source 없음 → 오류 |
| 13 | job.target 없음 → 오류 |
| 14 | source.table 빈 문자열 → 오류 |
| 15 | target.table 없음 → 오류 |
| 16 | queryLimit 비정수 → 오류 |
| 17 | pollIntervalMs 0 → 오류 |
| 18 | retry가 배열 → 오류 |
| 19 | retry.strategy 잘못된 값 → 오류 |
| 20 | retry.maxAttempts 음수 → 오류 |
| 21 | integrity 비객체 → 오류 |
| 22 | integrity.enabled 비불리언 → 오류 |
| 23 | tagIdentifier.value 비문자열 → 오류 |
| 24 | shutdownTimeoutMs 비정수 → warn 후 기본값 30000 |
| 25 | JSON 파싱 실패 → 파일 경로 포함 에러 |
| 26 | source.columns 미지정 → `columns: null` |
| 27 | source.columns: `["TIME", "VALUE"]` → UPPERCASE 정규화 |
| 28 | source.columns: `["time", "value"]` (소문자) → `["TIME", "VALUE"]`로 정규화 |
| 29 | source.columns: `[]` (빈 배열) → 오류 |
| 30 | source.columns: `[123]` (비문자열) → 오류 |
| 31 | addJob: 새 job 추가 후 replication.jobs에 포함됨 |
| 32 | addJob: 유효하지 않은 server → 오류 throw |
| 33 | updateJob: 기존 job 내용 교체 |
| 34 | removeJob: job 제거 후 replication.jobs에서 삭제됨 |
| 35 | removeJob: 존재하지 않는 id → 오류 없이 무시 |
| 36 | save: 파일에 쓰고 다시 로드 가능 |
| 37 | target.autoCreate: true + table: "" → valid 통과 |
| 38 | target.autoCreate: false + table: "" → config 오류 |
| 39 | target.autoCreate: true + table: "TAG_COPY" → valid 통과 |
| 40 | target.autoCreate 미지정 + table: "" → config 오류 (autoCreate 기본 false) |
| 41 | autoStart 미지정 → 기본값 true |
| 42 | autoStart: false → false로 로드 |
| 43 | autoStart: true → true로 로드 |
| 44 | autoStart: 비boolean → config 오류 |

### http_server.test.js — HttpServer Jobs REST API (19개)

| suite | # | 테스트 항목 |
|-------|---|------------|
| GET /api/jobs | 1 | 빈 registry → `data: []` |
| GET /api/jobs | 2 | job 2개 등록 → `data` 길이 2 |
| GET /api/jobs/:id | 3 | 존재하는 job → 200 + JobResponse |
| GET /api/jobs/:id | 4 | 존재하지 않는 job → 404 |
| POST /api/jobs | 5 | 새 job 생성 → 201 + JobStatusResponse |
| POST /api/jobs | 6 | 이미 존재하는 job id → 409 |
| POST /api/jobs | 7 | config.addJob 오류 → 400 |
| PUT /api/jobs/:id | 8 | stopped job 업데이트 → 200 |
| PUT /api/jobs/:id | 9 | 존재하지 않는 job → 404 |
| PUT /api/jobs/:id | 10 | running job 업데이트 → 409 |
| DELETE /api/jobs/:id | 11 | stopped job 삭제 → 204 |
| DELETE /api/jobs/:id | 12 | 존재하지 않는 job → 404 |
| DELETE /api/jobs/:id | 13 | running job 삭제 → 409 |
| POST /api/jobs/:id/start | 14 | stopped job 시작 → 200, status=running |
| POST /api/jobs/:id/start | 15 | 이미 running job 시작 → 409 |
| POST /api/jobs/:id/start | 16 | 존재하지 않는 job 시작 → 404 |
| POST /api/jobs/:id/stop | 17 | running job 중지 → 200, status=stopped |
| POST /api/jobs/:id/stop | 18 | stopped job 중지 → 409 |
| POST /api/jobs/:id/stop | 19 | 존재하지 않는 job 중지 → 404 |

### http_server_servers.test.js — HttpServer Servers REST API (23개)

| suite | # | 테스트 항목 |
|-------|---|------------|
| GET /api/servers | 1 | 빈 목록 → `data: []` |
| GET /api/servers | 2 | 2개 등록 → `data` 길이 2, password 미포함 |
| GET /api/servers/:name | 3 | 존재하는 서버 → 200 + ServerResponse |
| GET /api/servers/:name | 4 | 존재하지 않는 서버 → 404 |
| POST /api/servers | 5 | 정상 생성 → 201 + ServerResponse |
| POST /api/servers | 6 | 중복 name → 409 |
| POST /api/servers | 7 | 검증 오류(host 없음) → 400 |
| PUT /api/servers/:name | 8 | 정상 업데이트 → 200 + ServerResponse |
| PUT /api/servers/:name | 9 | 존재하지 않는 서버 → 404 |
| PUT /api/servers/:name | 10 | 검증 오류(host 없음) → 400 |
| DELETE /api/servers/:name | 11 | 정상 삭제 → 204 |
| DELETE /api/servers/:name | 12 | 존재하지 않는 서버 → 404 |
| DELETE /api/servers/:name | 13 | job이 참조 중 → 409 |
| GET /api/servers/:name/health | 14 | 연결 성공 → ok: true |
| GET /api/servers/:name/health | 15 | 연결 실패 → ok: false, reason에 메시지 |
| GET /api/servers/:name/health | 16 | 서버 없음 → 404 |
| GET /api/servers/:name/tables | 17 | 테이블 목록 반환 (TAG/LOG 타입 변환 포함) |
| GET /api/servers/:name/tables | 18 | 서버 없음 → 404 |
| GET /api/servers/:name/tables | 19 | connect 오류 → 500 |
| GET /api/servers/:name/tables/:table/schema | 20 | 컬럼 목록 반환 |
| GET /api/servers/:name/tables/:table/schema | 21 | 테이블 없음(빈 결과) → 404 |
| GET /api/servers/:name/tables/:table/schema | 22 | 서버 없음 → 404 |
| GET /api/servers/:name/tables/:table/schema | 23 | connect 오류 → 500 |

### integrity_checker.test.js — TagTable.findFirstMissRow + TagAliasCache (7개)

| # | 테스트 항목 |
|---|------------|
| 1 | TagAliasCache.set: tag name에 null byte → throw |
| 2 | findFirstMissRow: 빈 rows → `{ firstMissIdx: null, err: null }` |
| 3 | findFirstMissRow: 모든 rows 존재 → `{ firstMissIdx: null, err: null }` |
| 4 | findFirstMissRow: 첫 번째(idx=0) miss → `{ firstMissIdx: 0, err: null }` |
| 5 | findFirstMissRow: 중간(idx=1) miss → `{ firstMissIdx: 1, err: null }` |
| 6 | findFirstMissRow: NAME 컬럼 없는 schema → `{ firstMissIdx: null, err }` |
| 7 | findFirstMissRow: execute 에러 → `{ firstMissIdx: null, err }` |

### job-scheduler.test.js — Job + JobScheduler (19개)

| suite | # | 테스트 항목 |
|-------|---|------------|
| Job/_discoverMapping | 1 | connect 오류 → null 반환 |
| Job/_discoverMapping | 2 | discover 성공 → `{ tableType, dataTables, srcSchema, dstSchema }` |
| Job/_discoverMapping | 3 | source.columns에 존재하지 않는 컬럼 → null 반환 |
| Job/_discoverMapping | 4 | src에만 있는 컬럼(non-metadata) → null 반환 |
| Job/autoCreate | 5 | TAG: autoCreate=true + dst 파티션 없음 → createTagTable 호출 후 정상 반환 |
| Job/autoCreate | 6 | TAG: autoCreate=false + dst 파티션 없음 → null 반환 |
| Job/autoCreate | 7 | LOG: autoCreate=true + dst 테이블 없음 → createLogTable 호출 후 정상 반환 |
| Job/autoCreate | 8 | LOG: autoCreate=false + dst 테이블 없음 → null 반환 |
| Job/AbortController | 9 | signal.aborted=true → open 호출 없이 즉시 반환 |
| Job/AbortController | 10 | Worker_0 에러 → abort → Worker_1의 signal.aborted=true |
| Job/run() 재시작 | 11 | Worker 에러 → abort → 재시작 후 shutdown → 정상 종료 |
| JobScheduler | 12 | register → getEntry 반환, status=stopped |
| JobScheduler | 13 | unregister → stopped job 제거 |
| JobScheduler | 14 | update → stopped job의 jobConfig 교체 |
| JobScheduler | 15 | listEntries → 전체 entry 배열 반환 |
| JobScheduler | 16 | start → status=running, stop → status=stopped |
| JobScheduler | 17 | stopAll → 모든 running job 중지 |

### replicator.test.js — Replicator (6개)

| # | 테스트 항목 |
|---|------------|
| 1 | SIGTERM 수신 → shutdownFlag 설정 후 run() 완료 |
| 2 | job 없음 → SIGTERM 후 즉시 완료 |
| 3 | SIGINT 수신 → run() 정상 종료 |
| 4 | shutdownTimeoutMs: 여러 job 중 최댓값 사용 |
| 5 | config.api.enabled=false → httpServer가 생성되지 않음 |
| 6 | autoStart=true → 시작 시 scheduler.start() 호출됨 |

### retry.test.js — RetryHandler (15개)

| # | 테스트 항목 |
|---|------------|
| 1 | shouldRetry: 일반 Error → true |
| 2 | shouldRetry: err.retryable=false → false |
| 3 | exponential: attempt=0 → baseDelayMs |
| 4 | exponential: attempt=1 → initial * multiplier^1 |
| 5 | exponential: attempt=3 → 8000 |
| 6 | linear: attempt=0 → baseDelayMs |
| 7 | linear: attempt=2 → initial * 3 |
| 8 | maxDelayMs 상한 적용 |
| 9 | jitter=true → delay < 원본 delay |
| 10 | isExhausted: maxAttempts=null → 항상 false |
| 11 | isExhausted: attempt >= maxAttempts → true |
| 12 | isExhausted: attempt < maxAttempts → false |
| 13 | sleepOrShutdown: 타임아웃 → "timeout" |
| 14 | sleepOrShutdown: shutdown flag set → "shutdown" |
| 15 | sleepOrShutdown: 이미 shutdown이면 즉시 반환 |

### worker-state.test.js — Worker 상태 머신 + E2E mock 시나리오 (20개)

| suite | # | 테스트 항목 |
|-------|---|------------|
| RESOLVE_START | 1 | 체크포인트 없음 + startMode=full → startRid=0n으로 시작 |
| RESOLVE_START | 2 | 체크포인트 있음 → lastSuccessRid+1에서 재개 |
| STEADY_REPLICATION | 3 | TAG 배치 처리 → checkpoint = maxRidInBatch |
| STEADY_REPLICATION | 4 | drop_not_found → checkpoint = maxRidInBatch (1행 남는 케이스) |
| STEADY_REPLICATION | 5 | LOG 테이블 → tag_id 변환 없이 그대로 append |
| STEADY_REPLICATION | 6 | stmtCount >= 900 → srcTable 연결 갱신 (open/close 재호출 확인) |
| STARTUP_INTEGRITY | 7 | integrity.enabled=false → STARTUP_INTEGRITY 미실행 |
| STARTUP_INTEGRITY | 8 | TAG + cp존재 + integrity.enabled → firstMiss 발견 후 STEADY |
| STARTUP_INTEGRITY | 9 | 배치 내 모든 row 존재 → 다음 배치 진행 후 소스 소진 시 STEADY 진입 |
| STARTUP_INTEGRITY | 10 | LOG → checkpoint 있어도 STARTUP_INTEGRITY 미수행 |
| non-retryable | 11 | read non-retryable 에러 → Worker 즉시 종료 |
| non-retryable | 12 | append non-retryable 에러 → Worker 즉시 종료 |
| read 에러 | 13 | read 에러 → retry 없이 즉시 Worker 종료 |
| append retry | 14 | append 에러(retryable) → retry 후 복구 |
| shutdown | 15 | shutdown 신호 → 즉시 종료 |
| 빈 배치 poll | 16 | 빈 배치 → pollIntervalMs 대기 후 재읽기 |
| TAG 복제 기본 | 17 | full start → startRid=0n, 배치 후 checkpoint 갱신 |
| LOG 복제 기본 | 18 | LOG: tag_id 변환 없이 그대로 append + checkpoint 갱신 |
| checkpoint resume | 19 | checkpoint 저장 후 재시작 → startRid = lastSuccessRid + 1 |
| drop_not_found | 20 | read()가 drop_not_found 제외한 rows 반환 확인 |

---

## 통합 테스트 — TAG 테이블 (11개 pass)

```
node --test tests/integration/tag_replication.test.js
```

**대상 DB**: 127.0.0.1:5656 / 실행 시간: ~51초

| # | 테스트 ID | 항목 | 결과 |
|---|-----------|------|------|
| 1 | cleanup | 이전 테스트에서 남은 REPLI_TAG_ 테이블 정리 | pass |
| 2 | TAG-01 | 동일 스키마 TAG→TAG 복제 — 행수/value/cp 검증 | pass |
| 3 | TAG-02 | SRC-only additional column → 복제 스킵, cp 미저장 | pass |
| 4 | TAG-03 | DST-only additional column → safeNull 패딩, 정상 복제 | pass |
| 5 | TAG-04 | 동일 컬럼명 but 타입 다름 (DOUBLE → VARCHAR) — 복제 동작 확인 | pass |
| 6 | TAG-05 | startMode=full — RID 0부터 전체 복제 | pass |
| 7 | TAG-06 | startMode=now — 기존 데이터 복제 안 함 | pass |
| 8 | TAG-07 | cp 재시작 — cp 이후 데이터만 복제, cp 갱신 | pass |
| 9 | TAG-08 | tag_identifier prefix — DST name = prefix + canonical | pass |
| 10 | TAG-09 | STARTUP_INTEGRITY — 재시작 시 중복 없이 복제 | pass |
| 11 | TAG-10 | LOG 테이블은 cp+integrity=true여도 STARTUP_INTEGRITY 미수행 | pass |

---

## 통합 테스트 — LOG 테이블 (8개 pass)

```
node --test tests/integration/log_replication.test.js
```

**대상 DB**: 127.0.0.1:5656 / 실행 시간: ~7초

| # | 테스트 ID | 항목 | 결과 |
|---|-----------|------|------|
| 1 | cleanup | 이전 테스트에서 남은 REPLI_LOG_ 테이블 정리 | pass |
| 2 | LOG-01 | 동일 스키마 LOG→LOG 복제 — 행수/value/cp 검증 | pass |
| 3 | LOG-02 | SRC-only 컬럼 → 복제 스킵, cp 미저장 | pass |
| 4 | LOG-03 | DST-only 컬럼 → safeNull 패딩, 정상 복제 | pass |
| 5 | LOG-04 | 동일 컬럼명 but 타입 다름 (DOUBLE → VARCHAR) — 복제 동작 확인 | pass |
| 6 | LOG-05 | startMode=full — RID 0부터 전체 복제 | pass |
| 7 | LOG-06 | startMode=now — 기존 데이터 복제 안 함 | pass |
| 8 | LOG-07 | cp 재시작 — cp 이후 데이터만 복제, cp 갱신 | pass |

---

## 통합 테스트 — LogTable/TagTable/TagDataTable (17개)

```
node --test tests/integration/table.test.js
```

**대상 DB**: 127.0.0.1:5656

| # | 테스트 ID | 항목 |
|---|-----------|------|
| 1 | cleanup | 이전 테스트에서 남은 REPLI_TBL_ 테이블 정리 |
| 2 | LogTable-01 | getSchema() — M$SYS_COLUMNS 조회 |
| 3 | LogTable-02 | getSchema() — TableSchema 반환 |
| 4 | LogTable-03 | getMaxRid() — 빈 테이블은 0n 이하 |
| 5 | LogTable-04 | append() — 데이터 삽입 후 read()로 검증 |
| 6 | LogTable-05 | read() — RID 기반 배치 읽기 |
| 7 | LogTable-06 | getMaxRid() — 데이터 삽입 후 양수 |
| 8 | TagTable-01 | getSchema() — META + DATA 컬럼 조합 |
| 9 | TagTable-02 | getDataTables() — 파티션 목록 반환 |
| 10 | TagTable-03 | append() — 데이터 삽입 후 조회 검증 |
| 11 | TagTable-04 | metadata 컬럼 포함 append — location 값 저장 확인 |
| 12 | TagDataTable-05 | loadTagAliasCache() — _TAG_META 로드 후 내부 캐시 구성 |
| 13 | TagDataTable-06 | read() — loadTagAliasCache 후 NAME이 canonical name으로 반환 |
| 14 | TagDataTable-01 | getMaxRid() — 빈 파티션은 BigInt 반환 |
| 15 | TagDataTable-02 | read() — 데이터 삽입 후 RID 기반 읽기 |
| 16 | TagDataTable-03 | getMaxRid() — 데이터 삽입 후 양수 |
| 17 | TagDataTable-04 | read() — metadata 컬럼은 결과에 포함되지 않음 |

---

## 테스트 실행 명령

```bash
# 단위 테스트 전체 (187개)
node --test tests/unit/*.test.js

# 개별 파일
node --test tests/unit/checkpoint.test.js
node --test tests/unit/client.test.js
node --test tests/unit/config.test.js
node --test tests/unit/http_server.test.js
node --test tests/unit/http_server_servers.test.js
node --test tests/unit/integrity_checker.test.js
node --test tests/unit/job-scheduler.test.js
node --test tests/unit/replicator.test.js
node --test tests/unit/retry.test.js
node --test tests/unit/worker-state.test.js

# 통합 테스트 (실 DB 연결 필요 — 127.0.0.1:5656)
node --test tests/integration/tag_replication.test.js
node --test tests/integration/log_replication.test.js
node --test tests/integration/table.test.js
```

## 테스트 파일 구조

```
tests/
├── unit/
│   ├── fixtures/
│   │   └── worker_fixtures.js       # Worker 테스트 공통 픽스처
│   ├── checkpoint.test.js           # CheckpointStore (6개)
│   ├── config.test.js               # Config load/validate/CRUD (51개)
│   ├── http_server.test.js          # HttpServer Jobs REST API (19개)
│   ├── http_server_servers.test.js  # HttpServer Servers REST API (23개)
│   ├── integrity_checker.test.js    # TagTable.findFirstMissRow (7개)
│   ├── job-scheduler.test.js        # Job + JobScheduler (19개)
│   ├── replicator.test.js           # Replicator (6개)
│   ├── retry.test.js                # RetryHandler (15개)
│   └── worker-state.test.js         # Worker 상태 머신 + E2E (20개)
└── integration/
    ├── tag_replication.test.js      # TAG 복제 E2E (11개)
    ├── log_replication.test.js      # LOG 복제 E2E (8개)
    └── table.test.js                # DB I/O 계층 (17개)
```
