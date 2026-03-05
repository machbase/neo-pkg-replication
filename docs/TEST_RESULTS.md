# 테스트 결과 보고서

**프로젝트**: repli-js
**수행일**: 2026-03-05
**환경**: Node.js v22, CommonJS
**통합 테스트 DB**: 192.168.1.189:5656 (Machbase, SYS/MANAGER)

---

## 요약

| 구분 | 파일 수 | 테스트 수 | pass | fail | 실행 시간 |
|------|---------|----------|------|------|-----------|
| 단위 테스트 | 7개 | 101개 | **101** | 0 | ~368ms |
| 통합 테스트 (TAG) | 1개 | 11개 | **11** | 0 | ~51초 |
| 통합 테스트 (LOG) | 1개 | 8개 | **8** | 0 | ~7초 |
| **합계** | **9개** | **120개** | **120** | **0** | — |

---

## 단위 테스트 (101개 pass)

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

### retry.test.js — RetryHandler (19개)

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
| 16~19 | (추가 케이스 4개) |

### table_info.test.js — TableSchema / TagAliasCache (13개)

| # | 테스트 항목 |
|---|------------|
| 1 | TableSchema — 컬럼 구조 빌드 및 조회 |
| 2 | Column — 메타정보 저장 |
| 3 | TagAliasCache.resolve — cache hit / miss / drop_not_found / retry_error |
| 4 | TagAliasCache.load — 전체 alias 일괄 로드 |
| 5 | buildTagSchema — TAG 테이블 컬럼 분석 |
| 6 | buildLogSchema — LOG 테이블 컬럼 분석 |
| 7~13 | (추가 케이스 7개) |

### target_writer.test.js — Writer (5개)

| # | 테스트 항목 |
|---|------------|
| 1 | Scenario A: 대상 전용 컬럼 → safeNull 패딩 |
| 2 | Scenario C: int64 컬럼 → number를 BigInt로 변환 |
| 3 | Scenario D: 다양한 타입의 대상 전용 컬럼 → safeNull |
| 4 | Scenario E: metadata 컬럼 → safeNull 패딩 (TAG 테이블) |
| 5 | Scenario F: null 소스 값 → safeNull 대체 |

### worker.test.js — Worker 상태 머신 (9개)

| suite | # | 테스트 항목 |
|-------|---|------------|
| RESOLVE_START | 1 | 체크포인트 없음 + start_mode=full → startRid=0n으로 시작 후 빈 배치 대기 후 shutdown |
| RESOLVE_START | 2 | 체크포인트 있음 → last_success_rid에서 재개 |
| STEADY_REPLICATION | 3 | TAG 배치 처리 → checkpoint가 maxRid+1로 갱신됨 |
| STEADY_REPLICATION | 4 | drop_not_found → checkpoint = maxRidInBatch+1 (all-drop 케이스) |
| STEADY_REPLICATION | 5 | LOG 테이블 → tag_id 변환 없이 그대로 append |
| STARTUP_INTEGRITY | 6 | integrity.enabled=false → STARTUP_INTEGRITY 미실행, 즉시 STEADY 진입 |
| STARTUP_INTEGRITY | 7 | TAG + checkpoint존재 + integrity.enabled → STARTUP_INTEGRITY 수행, first_miss 발견 후 STEADY |
| STARTUP_INTEGRITY | 8 | LOG 테이블 → checkpoint 있어도 STARTUP_INTEGRITY 미수행 |
| Job/_discoverMapping | — | 2개 (connect 오류 → null, discover 성공) |
| Job/AbortController | — | 2개 (signal.aborted 즉시 반환, Worker 에러 → abort 전파) |
| Job/재시작 | — | 1개 (에러 → abort → 재시작 후 shutdown) |
| Replicator/run() | — | 4개 (disabled job 제외, 빈 jobs, 병렬 실행, job 에러 격리) |

### e2e_scenarios.test.js — E2E 시나리오 mock 테스트 (8개)

| suite | 테스트 항목 |
|-------|------------|
| E2E-02 | SIGKILL 후 재시작 — 대상에 이미 존재하는 행은 skipped_exists로 건너뜀 |
| E2E-03 | SIGTERM graceful — 배치 처리 도중 shutdown → 현재 배치 완료 후 cp 갱신 |
| E2E-03 | SLEEP 중 shutdown → 즉시 깨어나 종료 |
| E2E-05 | LOG + cp존재 + integrity=true → STARTUP_INTEGRITY 미수행, tag_id 변환 없이 기록 |
| E2E-06 | append 첫 호출 실패(retryable) → retry 후 성공, 정상 복제 |
| E2E-06 | retry max_attempts 초과 → mapping skip (Worker 종료) |
| E2E-07 | cp 파일 손상 → start_mode=full → startRid=0n, stage=checkpoint_io 로그 |
| E2E-07 | (추가 케이스 1개) |

---

## 통합 테스트 — TAG 테이블 (11개 pass)

```
node --test tests/integration/tag_replication.test.js
```

**대상 DB**: 192.168.1.189:5656 / 실행 시간: ~51초

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

### 주요 검증 내용

- **TAG-01**: 소스 3행 삽입 → 대상 3행 복제, sensor_a/b/c value 정확도 확인, cp 저장 확인
- **TAG-02**: SRC 추가 컬럼(quality DOUBLE)이 DST에 없을 때 src-only 컬럼 검출 → 복제 스킵 → DST 0행, cp 미저장
- **TAG-03**: DST 추가 컬럼(temperature DOUBLE)이 SRC에 없을 때 → 0.0(safeNull)으로 패딩하여 복제
- **TAG-04**: 동일 컬럼명 타입 불일치(DOUBLE↔VARCHAR) → Machbase 암묵적 변환으로 2행 복제 성공
- **TAG-07**: 2차 재시작 시 cp 이후 신규 데이터(batch2_a)만 추가 복제, 총 3행 확인
- **TAG-08**: prefix="SRC_" 적용 → DST name에 "SRC_sensor_a", "SRC_sensor_b" 확인
- **TAG-09**: 1차 복제 → 2차 재시작 시 STARTUP_INTEGRITY 수행 → 대상 확인(all confirmed) → STEADY → 중복 없이 2행 유지
- **TAG-10**: LOG 테이블 + integrity=true → STARTUP_INTEGRITY 로그 미출력 확인

---

## 통합 테스트 — LOG 테이블 (8개 pass)

```
node --test tests/integration/log_replication.test.js
```

**대상 DB**: 192.168.1.189:5656 / 실행 시간: ~7초

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

### 주요 검증 내용

- **LOG-01**: 소스 3행 삽입 → 대상 3행 복제, sensor_a/b/c value 정확도 확인, last_success_rid > 0 확인
- **LOG-02**: SRC 추가 컬럼(quality DOUBLE)이 DST에 없을 때 → 에러 throw 확인, DST 0행, cp 미저장
- **LOG-03**: DST 추가 컬럼(status VARCHAR) → ''(safeNull)으로 패딩하여 복제
- **LOG-04**: 동일 컬럼명 타입 불일치(DOUBLE↔VARCHAR) → 2행 복제 확인
- **LOG-07**: 1차 2행 복제 후 cp 저장, 신규 1행 추가 후 2차 재시작 → 총 3행, cp 갱신(rid 증가) 확인

---

## 테스트 실행 명령

```bash
# 단위 테스트 전체 (101개)
node --test tests/unit/*.test.js

# 개별 파일
node --test tests/unit/checkpoint.test.js
node --test tests/unit/config.test.js
node --test tests/unit/retry.test.js
node --test tests/unit/table_info.test.js
node --test tests/unit/target_writer.test.js
node --test tests/unit/worker.test.js
node --test tests/unit/e2e_scenarios.test.js

# 통합 테스트 (실 DB 연결 필요 — 192.168.1.189:5656)
node --test tests/integration/tag_replication.test.js
node --test tests/integration/log_replication.test.js
```
