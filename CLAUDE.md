# repli-js 작업지시서

## 프로젝트 개요

Machbase TAG/LOG 테이블 간 데이터 복제(replication) 도구.
소스 DB에서 RID 기반으로 데이터를 읽어 대상 DB에 Append Stream으로 기록한다.

- **런타임**: Node.js v22 (CommonJS)
- **핵심 의존성**: `@machbase/ts-client@0.9.3` (CMI 프로토콜 기반 Machbase 네이티브 클라이언트)

## 디렉토리 구조

```
repli-js/
├── app.js                        # 진입점 — JobRunner 실행, SIGTERM/SIGINT 처리
├── job_runner.js                 # JobRunner — mapping별 Worker 병렬 실행 오케스트레이션
├── config.json                   # 실행 설정 (jobs, mappings, 접속 정보 등)
├── config/
│   └── config.js                 # 설정 파일 로드/검증 (M1)
├── worker/
│   ├── worker.js                 # Worker 상태 머신 (M6): RESOLVE_START → STARTUP_INTEGRITY → STEADY_REPLICATION
│   └── retry.js                  # retryWithBackoff 유틸리티
├── machbase/
│   ├── machbase.js               # MachbaseClient, MachbaseStream 클래스 (레거시)
│   ├── source_reader.js          # readAfterRid(), getMaxRid() (M4)
│   ├── target_writer.js          # TargetWriter — appendOpen/append/close 래퍼 (M5)
│   ├── tag_meta_provider.js      # TagMetaProvider — _TAG_META 로드/조회 (M3)
│   ├── integrity_checker.js      # IntegrityChecker — batchExists() (M7)
│   └── catalog.js                # lookupDataTables(), lookupColumns() (M2)
├── file/
│   ├── file.js                   # File — JSON atomic read/write (BigInt 지원) (M8)
│   └── checkpoint.js             # CheckpointStore — cp 파일 load/save (M9)
├── checkpoints/                  # 런타임 생성 — job별 파티션 cp 파일 저장 디렉토리
├── tests/
│   ├── unit/
│   │   ├── checkpoint.test.js    # CheckpointStore 단위 테스트
│   │   ├── config.test.js        # Config 단위 테스트
│   │   ├── retry.test.js         # retryWithBackoff 단위 테스트
│   │   ├── worker.test.js        # Worker 상태 머신 단위 테스트 (44개)
│   │   └── e2e_scenarios.test.js # E2E 시나리오 mock 테스트 (8개)
│   └── integration/              # 실 DB 연결 통합 테스트 (미구현)
├── PROJECT.md                    # 상세 설계 문서 (아키텍처, UML, 결정 이력)
├── WORKFLOW.md                   # 작업 절차 가이드
└── package.json
```

## 핵심 모듈 상세

### app.js — 진입점

- `config.json` 로드 후 `JobRunner` 실행
- `SIGTERM` / `SIGINT` 수신 시 `shutdownFlag.value = true` 설정 → graceful shutdown

### job_runner.js — JobRunner

- job별로 `data_tables` 목록을 순회하며 `runDataTableWorker`를 `Promise.all`로 병렬 실행
- 각 worker에 독립적인 `sourceConn` / `targetConn` 연결 제공

### worker/worker.js — Worker 상태 머신

`runDataTableWorker(opts)` 함수. 3단계 상태 전이:

1. **RESOLVE_START**: cp 파일 로드 → `startRid` 결정
   - cp 존재 → `last_success_rid + 1n`
   - cp 없음/손상 → `start_mode` 기준 (`full`=0n, `now`=getMaxRid())
2. **STARTUP_INTEGRITY** (TAG 테이블 + cp 존재 시만): `startRid` 부터 한 배치 읽어 대상 DB에 이미 존재하는 행 확인 → `safe_cp_rid` 산출 후 STEADY 진입
3. **STEADY_REPLICATION**: 루프 — readAfterRid → tagMeta 조회 → append → cp 저장 → sleep(poll_interval_ms) → shutdown 체크

### machbase/source_reader.js — M4

- `readAfterRid(conn, dataTable, startRid, limit?)` → `{ rows, err }`
- `getMaxRid(conn, dataTable)` → `{ maxRid, err }`
- 내부적으로 `RID_RANGE` 힌트 SQL 사용

### machbase/target_writer.js — M5

- `TargetWriter` 클래스: `open(conn, table, columns)` / `append(rows)` / `close()`
- `appendOpen()` + `AppendStreamSession` 래퍼

### machbase/tag_meta_provider.js — M3

- `TagMetaProvider` 클래스: `load(conn, metaTable)` / `resolve(tagId)` → name
- `_TAG_META`에서 `_ID → name` 맵 구성

### machbase/integrity_checker.js — M7

- `batchExists(conn, table, rows)` → `Set<"canonical\x00timeNs">` (OR-condition 단일 쿼리)
- `existKey(canonical, timeNs)` → key 문자열
- statement ID 한계(1024) 대응: 파라미터 없이 인라인 이스케이프 쿼리 사용

### file/checkpoint.js — M9

- `CheckpointStore(directory)`: `load(jobId, dataTable)` / `save(jobId, dataTable, cp, stats)`
- 파일 경로: `{directory}/{jobId}__{dataTable}.json` (예: `job-1___TAG_DATA_0.json`)
- 파싱 실패 또는 `source.data_table` 불일치 → `console.error({stage:'checkpoint_io',...})` 후 무효화

### file/file.js — M8

- `File(path)`: `read()` / `write(data)` / `exists()` / `update(partial)`
- atomic write: `.tmp` 파일 → `fs.rename`
- BigInt reviver/replacer 내장

## @machbase/ts-client API 참조

`createConnection(config)` → `Connection` 객체 반환.

### ConnectionConfig
```js
{
  host: string,
  port: number,
  user: string,
  password: string,
  database?: string,
  timezone?: string,
  showHiddenColumns?: boolean,
  connectTimeout?: number,
  queryTimeout?: number,
}
```

### Connection 주요 메서드
| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `connect()` | `() → Promise<void>` | DB 연결 |
| `end()` | `() → Promise<void>` | 연결 종료 |
| `query()` | `(sql, values?) → Promise<[rows, fields]>` | SQL 쿼리 실행 |
| `execute()` | `(sql, values?) → Promise<[result, fields]>` | SQL 실행 |
| `appendOpen()` | `(table, columns, options?) → Promise<AppendStreamSession>` | Append 스트림 오픈 |
| `appendBatch()` | `(table, columns, rows, options?) → Promise<AppendBatchResult>` | Append 배치 실행 |

### AppendStreamSession
| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `append()` | `(rows: AppendRowInput[]) → Promise<number>` | 로우 추가 |
| `close()` | `() → Promise<void>` | 스트림 닫기 |

### 컬럼 타입 매핑
| Machbase 내부 타입 코드 | 이름 |
|------------------------|------|
| 4 / 104 | short / ushort |
| 8 / 108 | integer / uinteger |
| 12 / 112 | long / ulong |
| 16 | float |
| 20 | double |
| 5 | varchar |
| 49 | text |
| 6 | datetime |
| 61 | json |

## config.json 형식

```json
{
  "jobs": [
    {
      "job_id": "job-1",
      "source": { "host": "...", "port": 5656, "user": "sys", "password": "manager", "table": "TAG" },
      "destination": { "host": "...", "port": 5656, "user": "sys", "password": "manager", "table": "TAG" },
      "mappings": [
        {
          "data_table": "_TAG_DATA_0",
          "start_mode": "full",
          "poll_interval_ms": 1000,
          "batch_size": 1000,
          "integrity": { "enabled": true },
          "retry": { "max_attempts": 5, "base_delay_ms": 100, "max_delay_ms": 30000 }
        }
      ],
      "checkpoint": { "directory": "./checkpoints" }
    }
  ]
}
```

## Machbase TAG 테이블 내부 구조

- `_TAG_META` — 태그 메타 정보 (`_ID` → name 매핑)
- `_TAG_DATA_0` ~ `_TAG_DATA_N` — 실제 데이터 파티션
- `V$STORAGE_TAG_TABLES` — 파티션별 RID 범위 등 스토리지 정보
- `M$SYS_TABLES` / `M$SYS_COLUMNS` — 시스템 카탈로그

RID_RANGE 힌트 예시:
```sql
SELECT /*+ RID_RANGE(_TAG_DATA_0, 0, 10000) */ d._RID, m.name, d.time, d.value
FROM _TAG_DATA_0 d, _TAG_META m
WHERE d.name = m._ID
LIMIT 1000
```

## 개발 규칙

- **모듈 시스템**: CommonJS (`require` / `module.exports`)
- **비동기 패턴**: `async/await`
- **BigInt 처리**: RID 값은 BigInt. JSON 직렬화 시 `BigInt → string` 변환 필요
- **에러 처리**: `@machbase/ts-client`의 `QueryError` 클래스로 DB 에러 구분
- **로깅**: `console.log` — info/warn, `console.error` — error. 항상 JSON 구조체로 출력 (`{level, stage, job_id, data_table, msg, ...}`)
- **코드 스타일**: 기존 파일의 세미콜론 스타일을 따를 것
- **단일 연결 제약**: `@machbase/ts-client` 연결 하나로 동시 query + append 불가 ("Unexpected protocol N" 오류) → Worker별 독립 연결 사용 (설계 결정 B-01)

## 테스트 실행

```bash
# 전체 단위 테스트 (52개)
node --test tests/unit/checkpoint.test.js tests/unit/config.test.js tests/unit/retry.test.js tests/unit/worker.test.js tests/unit/e2e_scenarios.test.js

# 개별 파일
node --test tests/unit/worker.test.js
node --test tests/unit/e2e_scenarios.test.js
```

현재 테스트 현황: **52 pass / 0 fail**
- checkpoint.test.js: CheckpointStore load/save/mismatch
- config.test.js: 설정 검증
- retry.test.js: retryWithBackoff 백오프 로직
- worker.test.js: Worker 상태 머신 44개
- e2e_scenarios.test.js: E2E 시나리오 8개 (E2E-02, 03, 05, 06, 07)

## 실행 방법

```bash
node app.js
```

## 알려진 한계 / TODO

1. 통합 테스트(`tests/integration/`) 미구현 — 실 DB 연결 테스트 없음
2. `config.json` 스키마 검증 불완전 — 일부 필드 누락 시 런타임 오류
3. `catalog.js` `lookupDataTables()` — 파티션 수 동적 조회 미사용 (app.js에서 하드코딩)
