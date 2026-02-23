# 개발 계획서

**기준 문서**: `replication_v2.txt` (상세설계 v1.2), `plan.md`, `spec.md`
**작성일**: 2026-02-23
**프로젝트 경로**: `/home/machbase/repli`

---

## 1. 확정 사항

### 1.1 설계 결정

| ID | 항목 | 결정 |
|----|------|------|
| B-01 | target connection / stream 공유 방식 | mapping당 target_conn 1개, appendOpen stream 1개 생성 후 **해당 mapping의 모든 Worker가 stream 공유** (Worker별 appendOpen 호출 없음) |
| B-02 | `on_save_failure="abort"` 동작 | **코드 상 TODO 주석으로 남김.** 현재는 "continue"와 동일하게 동작 |
| B-03 | 설정 파일 형식 | **JSON 채택.** JavaScript 런타임 내장 지원, 별도 라이브러리 불필요 |
| D-01 | SourceReader SQL 방식 | **RID_RANGE 힌트 + `_rid >= startRid` 조건 병용.** 힌트로 스캔 범위 한정, WHERE 조건으로 중복 제거 |
| D-02 | TagMetaProvider 메타 로드 방식 | **Read-through cache.** Worker 시작 시 `_TAG_META` 전체를 Map으로 로드. 복제 중 Map miss 시 단건 DB 조회 후 Map에 추가. DB 조회 후에도 없으면 `drop_not_found`. 주기적 sync 없음 |
| D-03 | `getMaxRid()` 실패 시 처리 | **SKIP_MAPPING.** 오류 로그(stage="catalog") 출력 후 해당 mapping 스킵 |
| D-04 | Log 테이블 n:1 매핑 금지 검증 위치 | **DISCOVER 단계 (CatalogClient).** 테이블 타입 확인 후 target 중복 여부 검증 |

### 1.2 B-01 상세: Stream 공유 구조

```
mapping (소스 table → 대상 table)
  source_conn: 1개  ──── Worker_0, Worker_1, ... 가 query에 공유
  target_conn: 1개  ──┐
  target_stream: 1개  ─┴── Worker_0, Worker_1, ... 가 append에 공유
                            (appendOpen은 mapping 시작 시 1회만 호출)
```

- TargetWriter는 mapping 레벨에서 1개 생성, 모든 Worker에 주입
- Worker는 `targetWriter.append(rows)` 호출만 담당
- Node.js 단일 스레드 특성상 동시 append 요청은 이벤트 루프에서 직렬화됨

### 1.3 D-01 상세: SourceReader SQL

```sql
SELECT /*+ RID_RANGE(data_table, :startRid, :endRid) */
       d._RID, m.name, d.time, d.value
FROM   data_table d, _LOGICAL_META m
WHERE  d.name = m._ID
  AND  d._RID >= :startRid
LIMIT  :limit
```

- `:endRid` = `startRid + BigInt(batchSize)` (스캔 범위 상한 추정값)
- `AND d._RID >= :startRid` 는 RID_RANGE 범위 내 중복 row 제거

---

## 2. 기존 코드 재사용 분석

| 파일 | 판정 | 처리 방향 |
|------|------|----------|
| `file/file.js` | **전면 재사용** | 수정 없이 CheckpointStore 기반 클래스로 활용 |
| `file/checkpoint.js` | **재작성** | v2 스펙(파일 1개 = data_table 1개, job_id, version, RFC3339)으로 전면 재작성 |
| `machbase/machbase.js` | **부분 재사용** | `connect/close/query/tableExists/columntypeof` 유지. `lookupEndRIDS`, `lookupColumns`, `selectDataByRid`, `MachbaseStream` 제거 |
| `app.js` | **폐기 후 재작성** | JobRunner 호출 진입점으로 재작성 |

---

## 3. 파일 구조

```
/home/machbase/repli/
├── app.js                      # [재작성] 진입점 — JobRunner 호출
├── config.json                 # 설정 파일 (v3 스키마, JSON)
│
├── config/
│   └── config.js               # [신규] M1: ConfigLoader
│
├── machbase/
│   ├── machbase.js             # [수정] 저수준 연결/쿼리 유지, 불필요 메서드 제거
│   ├── catalog.js              # [신규] M2: CatalogClient
│   ├── source_reader.js        # [신규] M4: SourceReader
│   ├── tag_meta_provider.js    # [신규] M5: TagMetaProvider
│   ├── integrity_checker.js    # [신규] M6: IntegrityChecker
│   └── target_writer.js        # [신규] M7: TargetWriter (stream 공유 관리)
│
├── file/
│   ├── file.js                 # [재사용] 변경 없음
│   └── checkpoint.js           # [재작성] M3: CheckpointStore v2 포맷
│
├── worker/
│   ├── retry.js                # [신규] M8: RetryHandler
│   └── worker.js               # [신규] M9: Worker 상태 머신
│
├── job_runner.js               # [신규] M10: JobRunner
└── package.json                # 변경 없음 (YAML 파서 추가 불필요)
```

---

## 4. 모듈 명세

### M1. ConfigLoader (`config/config.js`)

```js
ConfigLoader.load(filePath) → Config
```

**구현 항목**
- JSON.parse로 파일 읽기
- 필수 필드 검증: version==3, servers, replication.jobs
- servers 별칭 참조 유효성 (source.server, target.server가 servers에 존재)
- start_mode 값 범위: "full" | "now" | "rid_after"
- rid_after: start_mode=="rid_after"일 때 필수
- on_save_failure: "continue" | "abort" (기본값: "continue")
- shutdown_timeout_ms: 양의 정수 (기본값: 30000)
- batch_size_records 기본값: 5000
- execution 필드 레벨 merge: `mapping.execution` > `source.execution` > `job.execution_defaults` (필드 독립 적용)

---

### M2. CatalogClient (`machbase/catalog.js`)

```js
CatalogClient.getLogicalTableType(conn, table) → { type: "TAG"|"LOG"|"UNSUPPORTED" }
CatalogClient.listTagDataTables(conn, logicalTable) → DataTable[]
CatalogClient.getColumns(conn, tableId) → Column[]
CatalogClient.validateTagColumns(columns) → bool
CatalogClient.checkLogTableN1Conflict(mappings, logicalTable, targetServer, targetTable) → bool
```

**구현 항목**
- `M$SYS_TABLES.TYPE`: 6=TAG, 0=LOG, 그 외=UNSUPPORTED
- `V$STORAGE_TAG_TABLES + M$SYS_TABLES` 조인으로 data_table 목록 조회
- TAG 컬럼 규칙: 1번째 컬럼 tag id(integer 계열), 2번째 컬럼 time(int64) — 위반 시 mapping 스킵
- Log 테이블 n:1 매핑 금지: DISCOVER 단계에서 동일 target.server+target.table에 다수 Log mapping 시 두 번째 이후 스킵

---

### M3. CheckpointStore (`file/checkpoint.js`)

```js
CheckpointStore.load(jobId, dataTable) → { cp, exists, err }
CheckpointStore.save(jobId, dataTable, cp, stats) → err
```

**파일명**: `{checkpoint.directory}/{job_id}__{data_table}.json`

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
    "last_success_rid": "<BigInt as string>",
    "updated_at": "<RFC3339>"
  }
}
```

**구현 항목**
- `File` 클래스를 기반으로 atomic write 활용
- 파일 없음 → `{ exists: false, err: null }`
- JSON 파싱 실패 → `{ exists: false, err: ... }` + stage="checkpoint_io" 로그
- `source.data_table` ≠ 파일명 내 data_table → 손상 처리, 무효화
- `on_save_failure="continue"`: 오류 로그 + Worker 메모리 기준 rid로 계속
- `on_save_failure="abort"`: TODO (현재 continue와 동일하게 동작)
- 저장 성공 시 `checkpoint_saved` 구조화 로그 출력 (stats 4개 필드 포함)

---

### M4. SourceReader (`machbase/source_reader.js`)

```js
SourceReader.readAfterRid(conn, dataTable, logicalTable, startRid, limit) → { rows, err }
SourceReader.getMaxRid(conn, dataTable) → { maxRid, err }
```

**구현 항목**
- RID_RANGE 힌트 + `AND d._RID >= startRid` 조건 병용 (D-01 확정)
- Row 구조: `{ rid: BigInt, values: any[] }` (컬럼 순서대로)
- `getMaxRid()` 실패 시 → 호출자(Worker)에 err 반환, SKIP_MAPPING 처리 (D-03)
- 빈 테이블: `getMaxRid()` → `0n` 반환

---

### M5. TagMetaProvider (`machbase/tag_meta_provider.js`)

```js
TagMetaProvider.loadAll(conn, logicalTable) → err
TagMetaProvider.resolveTagCanonical(conn, tagId, tagIdentifier)
  → { canonical: string|null, status: "ok"|"drop_not_found"|"retry_error" }
```

**구현 항목**

`loadAll()` — Worker 시작 시 1회 호출
- `SELECT _ID, name FROM _LOGICAL_META` 전체 조회
- 결과를 `Map<tagId, tagName>`으로 보관

`resolveTagCanonical()` — 배치 처리 중 row마다 호출
- Map에서 tagId 조회 → 있으면 tag_identifier 적용 후 반환 (`status: "ok"`)
- Map miss → `_LOGICAL_META`에서 단건 DB 조회 → Map에 추가 후 반환 (`status: "ok"`)
- DB 조회 후에도 없음 → `status: "drop_not_found"` (해당 row drop)
- DB 오류 → `status: "retry_error"` (retry 대상)
- tag_identifier 적용: `prefix` → `value + tag_name`, `suffix` → `tag_name + value`, `none` → `tag_name`

**SourceReader SQL** — JOIN 없이 `_TAG_DATA_*`만 조회 (tag_id 정수 그대로 반환)
```sql
SELECT /*+ RID_RANGE(data_table, :startRid, :endRid) */ _RID, name, time, value
FROM   data_table
WHERE  _RID >= :startRid
LIMIT  :limit
```

---

### M6. IntegrityChecker (`machbase/integrity_checker.js`)

```js
IntegrityChecker.existsByTagAndTime(conn, table, canonicalTag, timeNs)
  → { exists: bool, err }
```

**구현 항목**
- `WHERE name = :canonicalTag AND time = :timeNs` 조건으로 존재 여부만 확인
- STARTUP_INTEGRITY 단계에서만 호출됨 (STEADY 중 미사용)

---

### M7. TargetWriter (`machbase/target_writer.js`)

```js
TargetWriter.open(conn, table, sourceColumns) → err
TargetWriter.append(rows) → err
TargetWriter.close() → err
```

**구현 항목**
- mapping 레벨에서 1회 `appendOpen()` 호출 → stream 보관
- 동일 mapping의 모든 Worker가 이 인스턴스를 공유하여 `append()` 호출 (B-01 확정)
- 대상 컬럼 목록 조회 후 스키마 불일치 처리:
  - 원본에 있고 대상에 없는 컬럼 → write에서 제외
  - 대상에 있고 원본에 없는 컬럼 → null로 채움
- `columntypeof()` 재사용하여 appendOpen 컬럼 정의 생성

---

### M8. RetryHandler (`worker/retry.js`)

```js
RetryHandler.shouldRetry(err) → bool
RetryHandler.nextDelay(attempt) → ms
RetryHandler.sleepOrShutdown(ms, shutdownFlag) → Promise<"timeout"|"shutdown">
```

**구현 항목**
- strategy: "exponential" → `initial_delay_ms * multiplier^attempt`
- strategy: "linear" → `initial_delay_ms * (attempt + 1)`
- 계산값이 max_delay_ms 초과 시 max_delay_ms 적용
- jitter=true → `delay * Math.random()`
- max_attempts: null=무한, 초과 시 mapping 스킵
- 재시도 불가 오류(설정 오류, TAG 컬럼 규칙 위반, TYPE 불일치) → 즉시 스킵
- `sleepOrShutdown`: `Promise.race([setTimeout(ms), shutdownSignal])` 구현

---

### M9. Worker (`worker/worker.js`)

```js
runDataTableWorker(mapping, tableType, dataTable, sourceConn, targetWriter, shutdownFlag) → Promise<void>
```

**구현 항목 — 상태 전이**

```
RESOLVE_START → (STARTUP_INTEGRITY, TAG+cp존재+integrity.enabled) → STEADY_REPLICATION
```

**RESOLVE_START**
- CheckpointStore.load(jobId, dataTable)
- 체크포인트 존재 + 파싱 성공 → `start_rid = cp.last_success_rid` (start_mode 무시)
- 체크포인트 없음/손상 → start_mode 기준: full=0n, now=getMaxRid(), rid_after=설정값

**STARTUP_INTEGRITY_PHASE**
- 대상 테이블에서 row 존재 여부 확인 (IntegrityChecker 사용)
- 최초 miss row → `safe_cp_rid = row.rid - 1n`, 체크포인트 갱신 후 STEADY 진입
- 전체 skip/drop → `max_rid_in_batch + 1n`으로 체크포인트 갱신, 다음 배치 계속

**STEADY_REPLICATION_LOOP** (F-01 반영)
```
while NOT shutdown_requested:
  rows = readAfterRid(start_rid, batch_size)
  if rows.empty: sleepOrShutdown(poll_interval_ms); continue

  max_rid_in_batch = MAX(rows.rid)
  max_written_rid = 0n

  [TAG] 각 row: resolveTagCanonical → drop_not_found 시 skip, retry_error 시 retry
  [LOG] rows 그대로

  if out_rows not empty:
    targetWriter.append(out_rows)  // 공유 stream에 append
    max_written_rid = MAX(out_rows.rid)

  effective_max = max_written_rid > 0n ? max_written_rid : max_rid_in_batch
  SAVE_CHECKPOINT(effective_max + 1n)
  start_rid = effective_max + 1n
```

---

### M10. JobRunner (`job_runner.js`)

**구현 항목**
1. ConfigLoader.load() → Config 객체
2. SIGTERM 핸들러 등록 → `shutdownFlag = true`
3. 각 enabled job의 mapping에 대해 DISCOVER (CatalogClient)
4. DISCOVER 성공 mapping: `source_conn`, `target_conn` 생성 (mapping당 각 1개)
5. TargetWriter.open(target_conn, ...) → mapping당 stream 1개 생성
6. data_table별 Worker를 `Promise.all`로 병렬 실행 — `source_conn`, `targetWriter` 주입
7. 모든 Worker 종료 후 `TargetWriter.close()`, `source_conn.end()`, `target_conn.end()`
8. Graceful Shutdown: `Promise.race([allWorkersDone, timeout(shutdown_timeout_ms)])`
9. 타임아웃 초과 → `level="warn"` 경고 로그 + 프로세스 강제 종료

---

## 5. 구현 순서

### Phase 0 — 환경 구성
- 테스트 프레임워크 선택 및 `npm test` 구성 (Node.js 22 내장 test runner 또는 Jest)
- 테스트 디렉토리 구조 생성: `tests/unit/`, `tests/integration/`
- `config.json` 샘플 작성 (v3 스키마)

### Phase 1 — 독립 모듈 (DB 없이 단위 테스트 가능)

| 순서 | 파일 | 모듈 | 비고 |
|------|------|------|------|
| 1 | `file/checkpoint.js` | M3 CheckpointStore | File 클래스 재사용 |
| 2 | `config/config.js` | M1 ConfigLoader | JSON 파싱, merge 로직 |
| 3 | `worker/retry.js` | M8 RetryHandler | sleepOrShutdown 포함 |

### Phase 2 — DB 연결 모듈

| 순서 | 파일 | 모듈 | 비고 |
|------|------|------|------|
| 1 | `machbase/machbase.js` | — | 불필요 메서드 제거, 기반 정리 |
| 2 | `machbase/catalog.js` | M2 CatalogClient | TAG/LOG 판정, 컬럼 검증, n:1 금지 |
| 3 | `machbase/source_reader.js` | M4 SourceReader | RID_RANGE + _rid >= |
| 4 | `machbase/tag_meta_provider.js` | M5 TagMetaProvider | 배치 캐시 포함 |
| 5 | `machbase/integrity_checker.js` | M6 IntegrityChecker | |
| 6 | `machbase/target_writer.js` | M7 TargetWriter | stream 공유 구조 |

### Phase 3 — Worker 조합

| 순서 | 파일 | 모듈 | 비고 |
|------|------|------|------|
| 1 | `worker/worker.js` | M9 Worker | 설계 의사코드 1:1 대응 구현 |

### Phase 4 — 오케스트레이션

| 순서 | 파일 | 모듈 | 비고 |
|------|------|------|------|
| 1 | `job_runner.js` | M10 JobRunner | connection/stream 생명주기 주의 |
| 2 | `app.js` | — | 진입점, 설정 파일 경로 CLI 인수 또는 환경변수 |

---

## 6. 마일스톤 및 완료 기준

### M0 — 환경 구성
- [ ] 테스트 프레임워크 설치 및 `npm test` 정상 실행
- [ ] `tests/unit/`, `tests/integration/` 디렉토리 구조 생성
- [ ] `config.json` 샘플 작성 및 로드 확인

### M1 — 설정 + 체크포인트
**완료 기준**
- [ ] ConfigLoader: version!=3 → 오류, servers 미존재 alias → mapping 스킵
- [ ] ConfigLoader: execution 필드 레벨 merge가 필드별로 독립 동작 (batch_size / poll_interval 각각 다른 레벨일 때)
- [ ] ConfigLoader: 기본값 주입 확인 (shutdown_timeout_ms=30000, batch_size_records=5000)
- [ ] CheckpointStore: 파일 없음 → `{ exists: false }`, 파싱 실패 → `{ exists: false, err }`
- [ ] CheckpointStore: save → load 라운드트립에서 BigInt 값 일치
- [ ] CheckpointStore: `source.data_table` 불일치 → 무효화
- [ ] RetryHandler: exponential 계산값, max_delay_ms 상한, jitter 범위 검증
- [ ] RetryHandler: `sleepOrShutdown` — shutdownFlag 변경 시 즉시 반환 확인

### M2 — 소스 읽기
**완료 기준**
- [ ] CatalogClient: TAG/LOG/UNSUPPORTED 각각 판정 확인 (실 DB)
- [ ] CatalogClient: validateTagColumns — 정상/위반 케이스
- [ ] CatalogClient: Log n:1 매핑 시 두 번째 mapping 스킵 확인
- [ ] SourceReader: `startRid > 현재 max_rid` → 빈 배열 반환
- [ ] SourceReader: `getMaxRid()` 빈 테이블 → 0n 반환
- [ ] SourceReader: `getMaxRid()` 실패 → SKIP_MAPPING 처리 확인

### M3 — 기본 복제
**완료 기준**
- [ ] TAG 테이블 정상 복제 동작 (소스 → 대상 row 수 일치)
- [ ] checkpoint advance 수치 검증: max_written_rid + 1n, all-drop 시 max_rid_in_batch + 1n
- [ ] `out_rows` 비어있을 때 `targetWriter.append()` 미호출 확인
- [ ] drop_not_found 발생 시 stats.dropped_no_meta 카운트 증가 확인
- [ ] LOG 테이블 복제 — tag_id 변환 없이 그대로 쓰기 확인

### M4 — 정합성 + Shutdown
**완료 기준**
- [ ] STARTUP_INTEGRITY 진입 조건 3가지 케이스 확인 (TAG+cp존재+enabled, LOG, enabled=false)
- [ ] `safe_cp_rid = row.rid - 1n` 값이 체크포인트 파일에 정확히 기록
- [ ] SIGTERM → 배치 처리 완료 후 종료 (배치 중간 중단 없음)
- [ ] `shutdown_timeout_ms` 내 미종료 시 warn 로그 + 강제 종료 확인

### M5 — 통합 검증 (E2E)
**완료 기준**
- [ ] E2E-01: TAG 테이블 전체 복제 — 대상 row 수 = 소스 row 수, cp = max_rid + 1
- [ ] E2E-02: SIGKILL 후 재시작 — 중복 없이 이후 데이터 복제, skipped_exists > 0
- [ ] E2E-03: SIGTERM graceful — shutdown_timeout_ms 이내 종료, cp 최신 상태
- [ ] E2E-04: 다중 mapping 병렬 — data_table별 cp 파일 독립 생성/갱신
- [ ] E2E-05: LOG 테이블 복제 — STARTUP_INTEGRITY 미수행 (로그 확인)
- [ ] E2E-06: 대상 DB 연결 차단 → retry 로그 → 복구 후 자동 재개
- [ ] E2E-07: cp 파일 손상 → start_mode 기준 시작, stage="checkpoint_io" 로그

---

## 7. 미결 사항

| ID | 항목 | 현황 |
|----|------|------|
| B-02 | `on_save_failure="abort"` 세부 동작 | 코드 TODO 주석, 구현 유보 |
| — | STARTUP_INTEGRITY retry 시 배치 재처리 범위 | 의사코드상 배치 전체 재읽기로 추정, 구현 시 확정 |
