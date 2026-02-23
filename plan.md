# 데이터베이스 테이블 복제 시스템 기획서

**기준 문서**: `replication_2.txt` (요구사항 명세 v2.2 / 상세설계 v1.2)
**작성일**: 2026-02-23

---

## 1. 프로젝트 개요

### 1.1 목적

원본 Database의 TAG / Log 테이블 데이터를 대상 Database 테이블로 지속 복제한다.
트랜잭션·PK가 없는 환경에서 _rid 기반 체크포인트를 활용하여 at-least-once 복제를 달성한다.

### 1.2 목표 / 비목표

| 구분 | 항목 |
|------|------|
| **목표** | at-least-once 복제, 가능한 범위 내 정합성 최대화, graceful shutdown |
| **비목표** | Exactly-once 보장, Update/Delete 복제, 대상 테이블 생성/스키마 관리 |

### 1.3 핵심 제약

- DB 트랜잭션 없음, PK 없음
- 복제 단위: _rid 기반 배치
- 중복 발생 허용 (at-least-once)
- 설정 변경 시 프로세스 재시작 필요 (핫 리로드 미지원)

---

## 2. 기능 범위

### 2.1 포함

| # | 기능 |
|---|------|
| F1 | 설정 파일(v3) 로드 및 유효성 검사 |
| F2 | 소스 테이블 타입 판정 (TAG / Log) 및 데이터 테이블 목록 조회 |
| F3 | 체크포인트 파일 읽기/쓰기 (atomic write) |
| F4 | _rid 기반 배치 읽기 (RID_RANGE) |
| F5 | tag_id → tag_name 변환 + tag_identifier(prefix/suffix/none) 적용 |
| F6 | 재시작 시 정합성 보정 (STARTUP_INTEGRITY, Tag 전용) |
| F7 | 대상 테이블 Append 쓰기 |
| F8 | 재시도 (exponential/linear backoff, jitter) |
| F9 | data_table 단위 Worker 병렬 실행 |
| F10 | Graceful Shutdown (SIGTERM 기반, shutdown_timeout_ms) |
| F11 | 구조화 로그 (stage + raw 정보 포함) |

### 2.2 제외

- Update / Delete 복제
- 대상 테이블 생성 및 스키마 관리
- 메타 정보 동기화 (별도 루틴으로 분리, 1차 범위 외)
- 핫 리로드

---

## 3. 시스템 아키텍처

### 3.1 컴포넌트 구성

```
┌─────────────────────────────────────────────────────────┐
│  Main Process                                           │
│                                                         │
│  ConfigLoader ──→ JobRunner                             │
│                      │                                  │
│                      ├─ CatalogClient (소스 DB)         │
│                      ├─ CheckpointStore (파일)          │
│                      └─ [Worker × N] ─────────┐         │
│                                               │         │
│  Worker (data_table 1개당 1개, concurrent)    │         │
│  ┌────────────────────────────────────────┐   │         │
│  │  SourceReader     (소스 DB 읽기)       │   │         │
│  │  TagMetaProvider  (소스 DB 메타 조회)  │   │         │
│  │  IntegrityChecker (대상 DB 존재 확인)  │   │         │
│  │  TargetWriter     (대상 DB 쓰기)       │   │         │
│  │  CheckpointStore  (파일 갱신)          │   │         │
│  └────────────────────────────────────────┘   │         │
└───────────────────────────────────────────────┘─────────┘
```

### 3.2 시스템 상태 머신

**시스템 레벨**
```
INIT → DISCOVER → [Worker 병렬 실행] → STOPPED
```

**Worker 레벨 (data_table 1개당)**
```
RESOLVE_START → (STARTUP_INTEGRITY, Tag+체크포인트 존재 시) → STEADY_REPLICATION
```

---

## 4. 컴포넌트 명세

### 4.1 ConfigLoader

**역할**: 설정 파일(YAML/JSON v3)을 파싱하고 유효성을 검사한다.

**인터페이스**
```
ConfigLoader.load(filePath) → Config
```

**검증 항목**
- version == 3
- servers 별칭 참조 유효성 (source.server, target.server가 servers에 존재)
- start_mode 값 범위 ("full" | "now" | "rid_after")
- rid_after: start_mode == "rid_after"일 때 필수
- on_save_failure: "continue" | "abort" (기본값: "continue")
- shutdown_timeout_ms: 양의 정수 (기본값: 30000)

**execution 필드 레벨 merge 규칙**

각 필드(batch_size_records, poll_interval_ms)는 독립적으로 다음 우선순위를 따른다:
```
1. mapping.execution.{field}
2. source.execution.{field}
3. job.execution_defaults.{field}
```
상위 레벨에 해당 필드가 없으면 다음 레벨의 값을 사용한다.

---

### 4.2 CatalogClient

**역할**: 소스 DB의 시스템 카탈로그를 조회하여 테이블 타입·데이터 테이블 목록·컬럼 정보를 반환한다.

**인터페이스**
```
CatalogClient.getLogicalTableType(server, table) → { type: TAG | LOG | UNSUPPORTED }
CatalogClient.listTagDataTables(server, logicalTable) → DataTable[]
CatalogClient.getColumns(server, tableId) → Column[]
CatalogClient.validateTagColumns(columns) → bool
```

**TAG 컬럼 규칙 검증**
- 1번째 컬럼: tag id (type: integer 계열)
- 2번째 컬럼: time (type: int64)
- 위반 시 해당 mapping 스킵

**TYPE 판정 기준**
```
M$SYS_TABLES.TYPE
  6  → TAG
  0  → LOG
  기타 → UNSUPPORTED (mapping 스킵)
```

---

### 4.3 CheckpointStore

**역할**: 데이터 테이블별 체크포인트 파일을 읽고 atomic write로 갱신한다.

**인터페이스**
```
CheckpointStore.load(jobId, dataTable) → { cp, exists, err }
CheckpointStore.save(jobId, dataTable, cp) → err
```

**파일명 규칙**
```
{checkpoint.directory}/{job_id}__{data_table}.json
```

**파일 포맷**
```json
{
  "version": 1,
  "job_id": "<string>",
  "source": {
    "server": "<server_alias>",
    "table": "<logical_table>",
    "data_table": "<data_table_name>"
  },
  "checkpoint": {
    "last_success_rid": <integer>,
    "updated_at": "<RFC3339>"
  }
}
```

**Atomic write 방식**: `{파일명}.tmp` 임시 파일로 쓴 후 rename

**읽기 오류 처리**
- 파일 없음 → exists=false, err=null
- JSON 파싱 실패 → exists=false, err=파싱 오류 (로그 후 "없음" 취급)
- source.data_table ≠ 파일명 내 data_table → 손상(corruption) 처리, 무효화

**저장 실패 처리** (`on_save_failure` 설정에 따름)
- `"continue"` (기본값): error 로그 + Worker는 메모리 기준 rid로 계속 처리
- `"abort"`: TODO — 세부 동작 미정의

---

### 4.4 SourceReader

**역할**: 소스 DB에서 _rid 기반으로 배치 데이터를 읽는다.

**인터페이스**
```
SourceReader.readAfterRid(server, dataTable, startRid, limit) → { rows, err }
SourceReader.getMaxRid(server, dataTable) → { maxRid, err }
```

**readAfterRid 조건**: `_rid >= startRid`, LIMIT limit

**rows 구조**
```
Row {
  rid:    BigInt
  values: any[]   // 컬럼 순서대로
}
```

---

### 4.5 TagMetaProvider

**역할**: tag_id → tag_name을 조회하고, tag_identifier를 적용하여 canonical tag_name'을 반환한다.

**인터페이스**
```
TagMetaProvider.resolveTagCanonical(server, logicalTable, tagId, tagIdentifier)
  → { canonical: string | null, status: "ok" | "drop_not_found" | "retry_error" }
```

**처리 규칙**
- 조회 성공 → tag_identifier 적용 후 canonical 반환 (`status: "ok"`)
- 메타 없음 → `status: "drop_not_found"` (해당 row drop)
- 일시 오류 → `status: "retry_error"` (retry 대상)

**tag_identifier 적용 로직**
```
mode == "prefix" → value + tag_name
mode == "suffix" → tag_name + value
mode == "none"   → tag_name
```

---

### 4.6 IntegrityChecker

**역할**: 재시작 직후 STARTUP_INTEGRITY 단계에서 대상 테이블에 row가 이미 존재하는지 확인한다.
정상 복제(STEADY) 중에는 사용하지 않는다.

**인터페이스**
```
IntegrityChecker.existsByTagAndTime(server, table, canonicalTag, timeNs)
  → { exists: bool, err }
```

**조회 조건**: `tag_name = canonicalTag AND time = timeNs`
**조회 방식**: 존재 여부만 확인 (전체 컬럼 비교 없음)

---

### 4.7 TargetWriter

**역할**: 대상 테이블에 배치 단위로 데이터를 Append 쓰기한다.

**인터페이스**
```
TargetWriter.write(server, table, rows) → err
```

**성공 기준**: 전체 성공만 성공으로 인정. 부분 성공 = 실패.

**스키마 불일치 처리**
- 원본에 있고 대상에 없는 컬럼: write에서 제외
- 대상에 있고 원본에 없는 컬럼: Null로 채움

---

### 4.8 RetryHandler

**역할**: 네트워크·일시 오류에 대한 재시도 로직을 실행한다.

**설정 항목**
```
enabled:          bool
strategy:         "exponential" | "linear"
initial_delay_ms: int
max_delay_ms:     int
multiplier:       float   (exponential 전용)
jitter:           bool
max_attempts:     int | null  (null = 무한)
```

**재시도 불가 오류 (즉시 mapping 스킵)**
- 설정 오류
- TAG 컬럼 규칙 위반
- 테이블 TYPE 불일치

---

## 5. 핵심 동작 흐름

### 5.1 초기화 흐름

```
1. ConfigLoader.load()
2. 각 job의 enabled == true인 job 선택
3. job별 CatalogClient로 mapping 검증:
   a. 테이블 TYPE 조회
   b. TAG이면 데이터 테이블 목록 조회 + 컬럼 규칙 검증
   c. Log이면 1:1 매핑 검증
   d. 오류 시 해당 mapping 스킵 (job은 계속)
4. 검증 통과한 data_table별 Worker를 병렬 실행
5. SIGTERM 수신 대기 (메인 프로세스)
```

### 5.2 Worker 시작점 결정

```
1. CheckpointStore.load()
2. 체크포인트 존재 & 파싱 성공:
   start_rid = cp.last_success_rid
3. 체크포인트 없음/손상:
   - full     → start_rid = 0
   - now      → start_rid = SourceReader.getMaxRid()
   - rid_after → start_rid = config.rid_after
4. (TAG + 체크포인트 존재 + integrity.enabled)이면:
   start_rid = STARTUP_INTEGRITY_PHASE(start_rid)
5. STEADY_REPLICATION_LOOP(start_rid)
```

### 5.3 STARTUP_INTEGRITY_PHASE (Tag 전용)

```
while NOT shutdown_requested:
  rows = readAfterRid(start_rid, batch_size)
  if empty: SLEEP_OR_SHUTDOWN; continue

  max_rid_in_batch = MAX(rows.rid)

  for row in rows:
    (canonical, status) = resolveTagCanonical(row.tag_id)
    if status == retry_error: retry → 재처리
    if status == drop_not_found: stats.dropped++; continue

    exists = existsByTagAndTime(canonical, row.time)
    if error: retry → 재처리
    if exists: stats.skipped++; continue

    // 최초 miss 발견
    safe_cp_rid = row.rid - 1
    SAVE_CHECKPOINT(safe_cp_rid)
    return safe_cp_rid   // STEADY는 이 rid부터 시작

  // 배치 전체 skip/drop
  SAVE_CHECKPOINT(max_rid_in_batch + 1n)
  start_rid = max_rid_in_batch + 1n
```

### 5.4 STEADY_REPLICATION_LOOP

```
while NOT shutdown_requested:
  rows = readAfterRid(start_rid, batch_size)
  if empty: SLEEP_OR_SHUTDOWN; continue

  max_rid_in_batch = MAX(rows.rid)   // all-drop fallback용
  max_written_rid  = 0

  [TAG] rows → tag_id 변환 → canonical tag_name' 치환 → out_rows
  [LOG] out_rows = rows 그대로

  if out_rows is not empty:
    write(out_rows)
    if error: retry → continue
    max_written_rid = MAX(out_rows.rid)

  // checkpoint 갱신
  effective_max = max_written_rid > 0 ? max_written_rid : max_rid_in_batch
  SAVE_CHECKPOINT(effective_max + 1n)
  start_rid = effective_max + 1n
```

> **핵심**: `effective_max + 1n`을 저장함으로써 재시작 시 중복 없이 다음 미처리 RID부터 읽는다.
> `max_written_rid = 0` (전부 drop)인 경우 `max_rid_in_batch`를 fallback으로 사용한다.

### 5.5 Graceful Shutdown

```
[메인 프로세스]
SIGTERM 수신
  → shutdown_requested = true
  → 모든 Worker 종료 대기 (최대 shutdown_timeout_ms ms)
  → 타임아웃 초과 시 강제 종료 + 경고 로그

[Worker]
  → 배치 루프 시작 시 shutdown_requested 확인
  → true이면 루프 탈출 (진행 중 배치는 완료 후 종료)
  → SLEEP 중에도 즉시 깨어남
```

---

## 6. 설정 스키마 명세

### 6.1 최상위

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| version | int | ✅ | 3 고정 |
| servers | map<string, string> | ✅ | 서버 별칭 → 접속 문자열 |
| replication.jobs | Job[] | ✅ | 복제 작업 목록 |

### 6.2 Job

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| job_id | string | — | 고유 식별자 |
| enabled | bool | — | 실행 여부 |
| shutdown_timeout_ms | int | 30000 | Worker 종료 대기 타임아웃 (ms) |
| checkpoint.directory | string | — | 체크포인트 파일 저장 경로 |
| checkpoint.on_save_failure | "continue"\|"abort" | "continue" | 체크포인트 저장 실패 정책 |
| integrity.enabled | bool | — | 재시작 정합성 유지 여부 |
| integrity.mode | "existence_only" | — | 정합성 비교 방식 (현재 고정) |
| retry.enabled | bool | — | 재시도 활성화 |
| retry.strategy | "exponential"\|"linear" | — | 대기 증가 방식 |
| retry.initial_delay_ms | int | — | 최초 재시도 대기 (ms) |
| retry.max_delay_ms | int | — | 최대 재시도 대기 (ms) |
| retry.multiplier | float | — | 지수 증가 계수 |
| retry.jitter | bool | — | 랜덤 변동 적용 |
| retry.max_attempts | int\|null | null | 최대 횟수 (null = 무한) |
| execution_defaults.batch_size_records | int | 5000 | 배치당 최대 레코드 수 |
| execution_defaults.poll_interval_ms | int | — | 폴링 주기 (ms) |
| logging.level | "debug"\|"info"\|"warn"\|"error" | — | 로그 레벨 |
| logging.log_dir | string | — | 로그 파일 경로 |

### 6.3 Mapping

| 필드 | 타입 | 설명 |
|------|------|------|
| mapping_id | string | 고유 식별자 |
| source.server | string | servers 별칭 참조 |
| source.table | string | 원본 논리 테이블명 |
| source.start_mode | "full"\|"now"\|"rid_after" | 최초 실행 시작 기준 |
| source.rid_after | int\|null | start_mode=rid_after 시 기준 rid |
| source.tag_identifier.mode | "prefix"\|"suffix"\|"none" | tag name 식별자 방식 |
| source.tag_identifier.value | string | 적용 문자열 (구분자 포함) |
| source.execution | ExecutionOptions | source 레벨 실행 옵션 override |
| target.server | string | servers 별칭 참조 |
| target.table | string | 대상 테이블명 (사전 생성 필요) |
| execution | ExecutionOptions | mapping 레벨 실행 옵션 override |

### 6.4 고정 정책 (설정 비노출)

| 항목 | 값 |
|------|----|
| max_inflight_batches | 1 |
| single_instance_per_data_table | true |
| atomic_write | true |
| skip_when_table_type_unsupported | true |
| config_hot_reload | false |

---

## 7. 에러 처리 정책

| 오류 유형 | 발생 단계 | 처리 |
|-----------|-----------|------|
| 설정 오류 (잘못된 값, 참조 오류) | INIT | mapping 스킵 |
| TAG 컬럼 규칙 위반 | DISCOVER | mapping 스킵 |
| TYPE 불일치 / 미지원 | DISCOVER | mapping 스킵 |
| 카탈로그 조회 실패 | DISCOVER | mapping 스킵 |
| 체크포인트 파싱 실패 | RESOLVE_START | "없음" 취급 + 로그 |
| 체크포인트 저장 실패 | SAVE_CHECKPOINT | on_save_failure 정책 적용 |
| 소스 읽기 오류 (네트워크) | READ | retry |
| tag_id 메타 조회 오류 (not found) | META_LOOKUP | row drop |
| tag_id 메타 조회 오류 (일시) | META_LOOKUP | retry |
| 존재 여부 검색 오류 | INTEGRITY_CHECK | retry |
| 대상 쓰기 오류 (네트워크) | WRITE | retry |
| 재시도 횟수 초과 (max_attempts 도달) | 각 단계 | mapping 스킵 |

**로그 필수 포함 정보 (구조화)**

```
{
  stage:      "catalog" | "checkpoint_io" | "read" | "meta_lookup" |
              "integrity_check" | "write",
  job_id:     string,
  mapping_id: string,
  data_table: string,
  raw:        <원본 에러 메시지>,
  ...기타 컨텍스트
}
```

**체크포인트 저장 성공 시 로그 필수 항목**

```
{
  event:            "checkpoint_saved",
  job_id, mapping_id, data_table,
  last_success_rid: BigInt,
  stats: {
    read:             int,
    written:          int,
    skipped_exists:   int,
    dropped_no_meta:  int
  },
  updated_at: RFC3339
}
```

---

## 8. 개발 작업 지시서

### 8.1 모듈 목록 및 구현 태스크

#### M1. ConfigLoader
- [ ] YAML/JSON 파싱
- [ ] 스키마 유효성 검사 (필수 필드, 타입, 값 범위)
- [ ] servers 별칭 참조 검증
- [ ] execution 필드 레벨 merge 로직 구현
- [ ] 기본값 주입 (shutdown_timeout_ms, batch_size_records, on_save_failure)

#### M2. CatalogClient
- [ ] `getLogicalTableType()` 구현 (M$SYS_TABLES 조회)
- [ ] `listTagDataTables()` 구현 (V$STORAGE_TAG_TABLES 조회)
- [ ] `getColumns()` 구현 (M$SYS_COLUMNS 조회)
- [ ] `validateTagColumns()` 구현 (1번째: tag id, 2번째: time int64)

#### M3. CheckpointStore
- [ ] `load()` 구현 (JSON 파싱, 손상 감지)
- [ ] `save()` 구현 (atomic write: tmp → rename)
- [ ] `source.data_table` ≠ 파일명 불일치 감지 → 무효화
- [ ] `on_save_failure` 처리 분기 (continue / abort TODO)

#### M4. SourceReader
- [ ] `readAfterRid()` 구현 (`_rid >= startRid LIMIT n`)
- [ ] `getMaxRid()` 구현

#### M5. TagMetaProvider
- [ ] `resolveTagCanonical()` 구현
- [ ] tag_identifier (prefix / suffix / none) 적용 로직
- [ ] 에러 분류: not_found vs 일시 오류

#### M6. IntegrityChecker
- [ ] `existsByTagAndTime()` 구현 (tag_name + time 조건 검색)

#### M7. TargetWriter
- [ ] `write()` 구현 (Append 배치)
- [ ] 스키마 불일치 처리 (컬럼 필터링, Null 채움)

#### M8. RetryHandler
- [ ] exponential backoff 구현
- [ ] linear backoff 구현
- [ ] jitter 적용
- [ ] max_attempts 제한
- [ ] 재시도 불가 오류 분류 (즉시 스킵)

#### M9. Worker
- [ ] `RESOLVE_START` 단계 구현
- [ ] `STARTUP_INTEGRITY_PHASE` 구현 (safe_cp_rid = row.rid - 1, all-drop: max_rid+1n)
- [ ] `STEADY_REPLICATION_LOOP` 구현 (max_written_rid + effective_max + 1n)
- [ ] `SAVE_CHECKPOINT` 구현
- [ ] shutdown_requested 플래그 확인 (루프 시작, SLEEP 중 즉시 wake)
- [ ] TAG / LOG 분기 처리

#### M10. JobRunner
- [ ] SIGTERM 핸들러 등록 → shutdown_requested = true
- [ ] 모든 Worker 병렬 실행
- [ ] Worker 종료 대기 (shutdown_timeout_ms 초과 시 강제 종료 + 경고)

### 8.2 구현 순서 (의존 관계 기준)

```
Phase 1 (독립 모듈)
  M1. ConfigLoader
  M3. CheckpointStore
  M8. RetryHandler

Phase 2 (DB 연결 모듈)
  M2. CatalogClient        (소스 DB)
  M4. SourceReader         (소스 DB)
  M5. TagMetaProvider      (소스 DB)
  M6. IntegrityChecker     (대상 DB)
  M7. TargetWriter         (대상 DB)

Phase 3 (Worker 조합)
  M9. Worker               (M3, M4, M5, M6, M7, M8 의존)

Phase 4 (오케스트레이션)
  M10. JobRunner           (M1, M2, M9 의존)
```

### 8.3 마일스톤

| 마일스톤 | 포함 모듈 | 완료 기준 |
|----------|-----------|-----------|
| **M0** 기반 환경 구성 | — | DB 연결 확인, 설정 파일 로드 성공 |
| **M1** 설정 + 체크포인트 | M1, M3 | 설정 파싱, 체크포인트 read/write 동작 |
| **M2** 소스 읽기 | M2, M4 | 카탈로그 조회, RID 기반 배치 읽기 동작 |
| **M3** 기본 복제 | M5, M7, M8, M9(STEADY) | TAG/LOG 단순 복제 동작 (정합성 없음) |
| **M4** 정합성 + Shutdown | M6, M9(STARTUP), M10 | 재시작 정합성 보정, SIGTERM graceful 종료 |
| **M5** 통합 검증 | 전체 | 전체 시나리오 E2E 동작 확인 |

---

## 9. 비범위 및 향후 과제

| 항목 | 상태 | 비고 |
|------|------|------|
| 메타 정보 동기화 루틴 | 미정의 | 별도 설계 예정 |
| `on_save_failure: "abort"` 세부 동작 | TODO | 정책 결정 후 구현 |
| 상태 조회 API / Prometheus 메트릭 | 향후 | 1차는 구조화 로그로 대체 |
| Log 테이블 _arrival_time 전달 옵션 | Backlog | `log.include_arrival_time` |
| Log 테이블 tag_identifier 확장 | Backlog | `log.identifier_columns` |
| Log 테이블 재시작 정합성 옵션 | Backlog | `log.integrity.key_columns` |
