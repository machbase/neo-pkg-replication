# 테스트 결과 보고서

**프로젝트**: repli-js
**수행일**: 2026-03-12
**환경**: Node.js v22, CommonJS
**통합 테스트 DB**: 127.0.0.1:5656 (Machbase, SYS/MANAGER)

---

## 요약

| 구분 | 파일 수 | 테스트 수 | pass | fail | 실행 시간 |
|------|---------|----------|------|------|-----------|
| 단위 테스트 | 6개 | 92개 | **92** | 0 | ~500ms |
| 통합 테스트 (TAG) | 1개 | 11개 | **11** | 0 | ~51초 |
| 통합 테스트 (LOG) | 1개 | 8개 | **8** | 0 | ~7초 |
| 통합 테스트 (table) | 1개 | 17개 | **17** | 0 | — |
| **합계** | **9개** | **128개** | **128** | **0** | — |

> 통합 테스트는 127.0.0.1:5656 DB 접근 가능 시 실행.

---

## 단위 테스트 (92개 pass)

```
node --test tests/unit/*.test.js
```

### checkpoint.test.js — CheckpointStore (6개)

| # | 테스트 항목 |
|---|------------|
| 1 | load: 파일 없음 → `{ exists: false, err: null }` |
| 2 | save + load 라운드트립: BigInt rid 보존 |
| 3 | save + load: source_server, source_table 보존 |
| 4 | load: source.data_table 불일치 → `{ exists: false, err }` |
| 5 | load: JSON 파싱 실패 → `{ exists: false, err }` |
| 6 | rid = 0n 저장 및 로드 |

### client.test.js — fixDoubleEndian (4개)

| # | 테스트 항목 |
|---|------------|
| 1 | 정상 double 값은 변환되지 않음 |
| 2 | BE로 저장된 double → LE 오독 복원 |
| 3 | 0, Infinity, NaN은 변환하지 않음 |
| 4 | number 아닌 값은 변환하지 않음 |

### config.test.js — ConfigLoader (33개)

| # | 테스트 항목 |
|---|------------|
| 1 | 정상 config 로드 |
| 2 | version != 3 → 오류 |
| 3 | servers 없음 → 오류 |
| 4 | replication.jobs 없음 → 오류 |
| 5 | 존재하지 않는 source server → 해당 mapping 스킵 |
| 6 | start_mode=rid_after + rid_after 없음 → mapping 스킵 |
| 7 | start_mode=rid_after + rid_after 있음 → 정상 로드 |
| 8 | execution 필드 레벨 merge: mapping > source > job_defaults |
| 9 | 기본값 주입: query_limit=5000, rid_range_size=50000, shutdown_timeout_ms=30000 |
| 10 | rid_range_size 사용자 설정 및 merge 우선순위 |
| 11 | rid_range_size 비정수 → mapping 스킵 |
| 12 | enabled=false job 처리 |
| 13 | mapping.source 없음 → mapping 스킵 |
| 14 | mapping.target 없음 → mapping 스킵 |
| 15 | source.table 빈 문자열 → mapping 스킵 |
| 16 | target.table 없음 → mapping 스킵 |
| 17 | query_limit 비정수 → mapping 스킵 |
| 18 | poll_interval_ms 0 → mapping 스킵 |
| 19 | retry가 배열 → mapping 스킵 |
| 20 | retry.strategy 잘못된 값 → mapping 스킵 |
| 21 | retry.max_attempts 음수 → mapping 스킵 |
| 22 | integrity 비객체 → mapping 스킵 |
| 23 | integrity.enabled 비불리언 → mapping 스킵 |
| 24 | tag_identifier.value 비문자열 → mapping 스킵 |
| 25 | shutdown_timeout_ms 비정수 → warn 후 기본값 30000 |
| 26 | checkpoint.directory 빈 문자열 → 오류 |
| 27 | checkpoint = {} (directory 없음) → 오류 |
| 28 | JSON 파싱 실패 → 파일 경로 포함 에러 |
| 29 | source.columns 미지정 → columns: null |
| 30 | source.columns: `["TIME", "VALUE"]` → UPPERCASE 정규화 후 `["TIME", "VALUE"]` |
| 31 | source.columns: `["time", "value"]` (소문자) → `["TIME", "VALUE"]`로 정규화 |
| 32 | source.columns: `[]` (빈 배열) → mapping 스킵 |
| 33 | source.columns: `[123]` (비문자열) → mapping 스킵 |

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

### retry.test.js — RetryHandler (15개)

| # | 테스트 항목 |
|---|------------|
| 1 | shouldRetry: 일반 Error → true |
| 2 | shouldRetry: err.retryable=false → false |
| 3 | exponential: attempt=0 → base_delay_ms |
| 4 | exponential: attempt=1 → initial * multiplier^1 |
| 5 | exponential: attempt=3 → 8000 |
| 6 | linear: attempt=0 → base_delay_ms |
| 7 | linear: attempt=2 → initial * 3 |
| 8 | max_delay_ms 상한 적용 |
| 9 | jitter=true → delay < 원본 delay |
| 10 | isExhausted: max_attempts=null → 항상 false |
| 11 | isExhausted: attempt >= max_attempts → true |
| 12 | isExhausted: attempt < max_attempts → false |
| 13 | sleepOrShutdown: 타임아웃 → "timeout" |
| 14 | sleepOrShutdown: shutdown flag set → "shutdown" |
| 15 | sleepOrShutdown: 이미 shutdown이면 즉시 반환 |

### worker.test.js — Worker 상태 머신 + E2E mock 시나리오 (27개)

| suite | # | 테스트 항목 |
|-------|---|------------|
| RESOLVE_START | 1 | 체크포인트 없음 + start_mode=full → startRid=0n으로 시작 |
| RESOLVE_START | 2 | 체크포인트 있음 → last_success_rid+1에서 재개 |
| STEADY_REPLICATION | 3 | TAG 배치 처리 → checkpoint = maxRidInBatch |
| STEADY_REPLICATION | 4 | drop_not_found → checkpoint = maxRidInBatch (1행 남는 케이스) |
| STEADY_REPLICATION | 5 | LOG 테이블 → tag_id 변환 없이 그대로 append |
| STARTUP_INTEGRITY | 6 | integrity.enabled=false → STARTUP_INTEGRITY 미실행 |
| STARTUP_INTEGRITY | 7 | TAG + cp존재 + integrity.enabled → first_miss 발견 후 STEADY |
| STARTUP_INTEGRITY | 8 | LOG → checkpoint 있어도 STARTUP_INTEGRITY 미수행 |
| non-retryable | 9 | read non-retryable 에러 → Worker 즉시 종료 |
| non-retryable | 10 | append non-retryable 에러 → Worker 즉시 종료 |
| Job/_discoverMapping | 11 | connect 오류 → null 반환 |
| Job/_discoverMapping | 12 | discover 성공 → `{ tableType, dataTables, srcSchema, dstSchema }` |
| Job/AbortController | 13 | signal.aborted=true → open 호출 없이 즉시 반환 |
| Job/AbortController | 14 | Worker_0 에러 → abort → Worker_1의 signal.aborted=true |
| Job/재시작 | 15 | Worker 에러 → abort → 재시작 후 shutdown → 정상 종료 |
| Replicator/run() | 16 | disabled job은 실행되지 않음 |
| Replicator/run() | 17 | enabled job 없음 → 즉시 완료 |
| Replicator/run() | 18 | 여러 job 병렬 실행 — 독립적 실행 및 완료 |
| Replicator/run() | 19 | 한 job 에러 → 다른 job 실행에 영향 없음 |
| E2E/TAG 기본 | 20 | full start → steady: startRid=0n, 배치 후 checkpoint 갱신 |
| E2E/LOG 기본 | 21 | LOG: tag_id 변환 없이 그대로 append |
| E2E/resume | 22 | checkpoint 저장 후 재시작 → startRid = last_success_rid + 1 |
| E2E/drop_not_found | 23 | read()가 drop_not_found 제외한 rows 반환 확인 |
| E2E/read 에러 | 24 | read 에러 → retry 없이 즉시 Worker 종료 |
| E2E/append retry | 25 | append 에러(retryable) → retry 후 복구 |
| E2E/shutdown | 26 | shutdown 신호 → 즉시 종료 |
| E2E/poll 대기 | 27 | 빈 배치 → poll interval 대기 후 재읽기 |

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
| 6 | TAG-05 | start_mode=full — RID 0부터 전체 복제 | pass |
| 7 | TAG-06 | start_mode=now — 기존 데이터 복제 안 함 | pass |
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
| 6 | LOG-05 | start_mode=full — RID 0부터 전체 복제 | pass |
| 7 | LOG-06 | start_mode=now — 기존 데이터 복제 안 함 | pass |
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
# 단위 테스트 전체 (92개)
node --test tests/unit/*.test.js

# 개별 파일
node --test tests/unit/checkpoint.test.js
node --test tests/unit/client.test.js
node --test tests/unit/config.test.js
node --test tests/unit/integrity_checker.test.js
node --test tests/unit/retry.test.js
node --test tests/unit/worker.test.js

# 통합 테스트 (실 DB 연결 필요 — 127.0.0.1:5656)
node --test tests/integration/tag_replication.test.js
node --test tests/integration/log_replication.test.js
node --test tests/integration/table.test.js
```
