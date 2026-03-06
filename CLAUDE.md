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
│   └── config.js                 # 설정 파일 로드/검증
├── core/
│   ├── types.js                  # ColumnType, Column, TableSchema — 순수 도메인 모델 (I/O 없음)
│   └── retry.js                  # RetryHandler 유틸리티
├── db/
│   ├── client.js                 # MachbaseClient, toInt64 — DB 연결·쿼리 (I/O 계층)
│   ├── schema_builder.js         # buildTagSchema(), buildLogSchema()
│   ├── reader.js                 # TagAliasCache, Reader 클래스
│   ├── writer.js                 # Writer 클래스
│   └── integrity_checker.js      # IntegrityChecker — batchExists()
├── worker/
│   └── worker.js                 # Worker 상태 머신: RESOLVE_START → STARTUP_INTEGRITY → STEADY_REPLICATION
├── checkpoint/
│   └── store.js                  # CheckpointStore — cp 파일 load/save (atomic write, BigInt 내장)
├── logger/
│   └── logger.js                 # Logger 클래스 — 날짜 로테이션, stdout/file 출력
├── checkpoints/                  # 런타임 생성 — job별 파티션 cp 파일 저장 디렉토리
├── tests/
│   ├── unit/
│   │   ├── checkpoint.test.js          # CheckpointStore 단위 테스트 (6개)
│   │   ├── client.test.js              # fixDoubleEndian 단위 테스트 (4개)
│   │   ├── config.test.js              # Config 단위 테스트 (33개)
│   │   ├── integrity_checker.test.js   # IntegrityChecker 단위 테스트 (4개)
│   │   ├── retry.test.js               # RetryHandler 단위 테스트 (19개)
│   │   ├── table_info.test.js          # TableSchema/TagAliasCache 단위 테스트 (13개)
│   │   ├── target_writer.test.js       # Writer 단위 테스트 (6개)
│   │   ├── worker.test.js              # Worker 상태 머신 단위 테스트 (19개)
│   │   └── e2e_scenarios.test.js       # E2E 시나리오 mock 테스트 (8개)
│   └── integration/
│       ├── tag_replication.test.js # TAG 테이블 통합 테스트 (11개)
│       └── log_replication.test.js # LOG 테이블 통합 테스트 (8개)
├── docs/
│   ├── PROJECT.md                # 상세 설계 문서 (아키텍처, UML, 결정 이력)
│   └── ENDIAN_BUG.md             # @machbase/ts-client endian 버그 상세 분석
└── package.json
```

## 핵심 모듈 상세

### db/client.js — MachbaseClient

- `MachbaseClient` 클래스: `@machbase/ts-client` 연결 래퍼
  - `connect()` / `close()` / `query(sql, values?)` / `appendOpen(table, columns)` / `execute(sql)`
  - `query()` 반환 직후 `fixDoubleEndian()` 자동 적용 (BE/LE 혼재 버그 우회)
  - **카탈로그 메서드** (DB 구조 조회):
    - `getTableType(table)` → `{ type: 'TAG'|'LOG'|'UNSUPPORTED' }`. 조회 실패 시 throw.
    - `listTagDataTables(logicalTable)` → `[{ data_table, table_id }]` (table_id는 BigInt 그대로)
    - `getColumnsByTableName(tableName)` → `[{ NAME, TYPE, ID }]` (META·LOG 컬럼 조회)
    - `getColumnsByTableId(tableId)` → `[{ NAME, TYPE, ID }]` (DATA 파티션, BigInt 파라미터 허용)
- `toInt64(val)` → BigInt 변환 유틸리티 (writer.js에서 import)
- `module.exports = { createConnection, QueryError, MachbaseClient, toInt64 }`

### app.js — 진입점

- `config.json` 로드 후 `new Replicator(config).run()` 실행
- SIGTERM / SIGINT 처리는 `Replicator.run()` 내부에서 담당

### job_runner.js — Replicator / Job / Worker

- **Replicator**: SIGTERM/SIGINT → `shutdownFlag.value = true`, shutdown timer 관리
- **Job**: `while(!shutdown)` 루프
  - `_discoverMapping(mapping, logCtx)` → 소스/대상 스키마 수집 + 검증 (단기 커넥션)
    - src-only 컬럼 검출: 소스에만 있고 대상에 없는 컬럼 → 해당 mapping 스킵
    - `source.columns` 유효성 검증: schema에 존재하지 않는 컬럼명 → 해당 mapping 스킵
  - `AbortController`로 Worker × N `Promise.all` 병렬 실행
  - 에러 시 abort → 루프 재시작
- **Worker**: `signal.aborted || shutdownFlag.value` proxy 생성 → `runDataTableWorker()` 호출
  - Worker별 독립 `Reader(srcConn)` + `TagAliasCache`(TAG 전용) + `Writer(dstConn)` 생성
- `module.exports = { Replicator, Job, Worker }`

### worker/worker.js — Worker 상태 머신

`runDataTableWorker({ jobId, mapping, tableType, dataTable, srcSchema, dstSchema, srcConfig, dstConfig, reader, aliasCache, writer, shutdownFlag })` 함수. 3단계 상태 전이:

1. **RESOLVE_START**: cp 파일 로드 → `startRid` 결정
   - cp 존재 → `last_success_rid + 1n`
   - cp 없음/손상 → `start_mode` 기준 (`full`=0n, `now`=reader.getMaxRid())
2. **STARTUP_INTEGRITY** (TAG 테이블 + cp 존재 + `integrity.enabled` 시만): `startRid`부터 배치 읽기 → 대상 DB 존재 확인 → `safe_cp_rid` 산출 후 STEADY 진입
3. **STEADY_REPLICATION**: 루프 — reader.readAfterRid → aliasCache.resolve → writer.append → cp 저장(maxRidInBatch) → sleep(poll_interval_ms) → shutdown 체크
   - statement ID 고갈 방지: stmtCount 추적, 900 도달 시 srcConn 재생성
- `module.exports = { runDataTableWorker }`

### core/types.js — ColumnType / Column / TableSchema

순수 도메인 모델. I/O 의존성 없음.

- `ColumnType` 클래스: Machbase 컬럼 타입 정의 (`code`, `type`, `safeNull`)
  - Static 상수: `SHORT`, `INTEGER`, `LONG`, `ULONG`, `DATETIME`, `FLOAT`, `DOUBLE`, `VARCHAR`, `TEXT`, `CLOB`, `BLOB`, `BINARY`, `IPV4`, `IPV6`, `JSON`, `UNKNOWN`
  - `safeNull`: append 패딩용 타입 안전 null 대체값 (int32→`0`, int64/datetime→`0n`, float→`0.0`, string→`''`)
  - `ColumnType.fromCode(code)` → M$SYS_COLUMNS.TYPE 코드로 인스턴스 반환
- `Column` 클래스: 테이블 컬럼 메타정보 (`name`, `columnType`, `id`, `category`)
  - `category`: `'key'`(TAG의 NAME 컬럼), `'data'`(일반 데이터 컬럼), `'metadata'`(TAG META 추가 속성)
- `TableSchema` 클래스: 불변 테이블 컬럼 구조 (`tableType`, `logicalTable`, `columns: Column[]`)
  - constructor: `(tableType, logicalTable, columns)` — columns 배열 직접 수신
- `module.exports = { ColumnType, Column, TableSchema }`

### db/schema_builder.js

스키마 빌드 함수만 담당하는 순수 함수 모듈.

- `buildTagSchema(client, logicalTable, dataTableId)` → `Promise<TableSchema>`
  - `client.getColumnsByTableName(_META)` → metadata columns
  - `client.getColumnsByTableId(dataTableId)` → data columns (NAME 컬럼은 VARCHAR 타입으로 오버라이드)
  - columns = dataColumns(NAME 포함) + metadataColumns
- `buildLogSchema(client, logicalTable)` → `Promise<TableSchema>`
  - `client.getColumnsByTableName(logicalTable)` → 전체 컬럼
- `module.exports = { buildTagSchema, buildLogSchema }`

### db/reader.js

- `TagAliasCache` 클래스: TAG alias 동적 상태 관리 (tag_id → canonical name)
  - Reader와 분리 — job_runner.js가 생성, runDataTableWorker에 직접 전달
  - `new TagAliasCache(logicalTable)` → Worker별 독립 인스턴스
  - `load(client)` → 전체 alias 일괄 로드
  - `resolve(client, tagId, tagIdentifier)` → Read-through cache, `{ canonical, status }` 반환
    - `status`: `'ok'` | `'drop_not_found'` | `'retry_error'`
  - `size` getter
- `Reader` 클래스: 소스 DB 읽기 담당 (aliasCache 소유하지 않음)
  - `new Reader(schema, client, dataTable, sourceColumns = null)`
    - `selectColumnNames`: 생성자에서 1회 계산 (metadata category 제외 + sourceColumns 필터)
    - `sourceColumns`: UPPERCASE 허용 컬럼명 배열. `null`이면 전체 데이터 컬럼 SELECT.
  - `readAfterRid(startRid, limit, rangeSize)` → `{ rows, err }`
  - `getMaxRid()` → `{ maxRid, err }` (인스턴스 메서드)
  - `refreshConnection(config)` → statement ID 고갈 시 연결 교체
  - 내부적으로 `RID_RANGE` 힌트 SQL 사용
- `module.exports = { Reader, TagAliasCache }`

### db/writer.js

- `Writer` 클래스: 대상 DB 쓰기 담당
  - `new Writer(dstSchema)` → 인스턴스 생성 (schema 소유)
  - `open(client, table, srcSchema)` → appendOpen 스트림 초기화
    - `srcNames: Set<string>` 구성 (소스 컬럼명 UPPERCASE Set)
    - client 소유권 획득 — close() 시 함께 닫힘
  - `append(rows)` → `_toCell(col, row)`로 각 셀 변환 후 스트림 append
    - 소스에 없는 컬럼(`!srcNames.has(col.name)`) → `col.columnType.safeNull`로 패딩
    - null/undefined 값 → `col.columnType.safeNull`
    - int64 컬럼 → `toInt64(val)` (BigInt 변환, `db/client.js`에서 import)
    - float/double 컬럼에서 Infinity / -Infinity / NaN → `col.columnType.safeNull`(0.0) + warn 로그
  - `close()` → 스트림 + client 닫기

### db/integrity_checker.js

- `batchExists(client, table, rows)` → `{ existSet: Set<"canonical\x00timeNs">, err }` (OR-condition 단일 쿼리)
- `existKey(canonical, timeNs)` → key 문자열
- statement ID 한계(1024) 대응: 파라미터 없이 인라인 이스케이프 쿼리 사용

### checkpoint/store.js

- `CheckpointStore(directory)`: `load(jobId, dataTable)` / `save(jobId, dataTable, cp, stats)`
- 파일 경로: `{directory}/{jobId}__{dataTable}.json` (예: `job-1___TAG_DATA_0.json`)
- atomic write 내장: `_writeFile()` — `.tmp` 파일 → `fs.rename`
- BigInt reviver/replacer 내장: `_parse()` / `_stringify()`
- 파싱 실패 또는 `source.data_table` 불일치 → logger({stage:'checkpoint_io',...}) 후 무효화

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
  "version": 3,
  "servers": {
    "src": { "host": "...", "port": 5656, "user": "sys", "password": "manager" },
    "dst": { "host": "...", "port": 5656, "user": "sys", "password": "manager" }
  },
  "replication": {
    "jobs": [{
      "id": "job-1",
      "checkpoint": { "directory": "./checkpoints" },
      "mappings": [{
        "mapping_id": "map-1",
        "source": {
          "server": "src",
          "table": "TAG",
          "columns": ["TIME", "VALUE"]
        },
        "target": { "server": "dst", "table": "TAG" },
        "execution": {
          "start_mode": "full",
          "poll_interval_ms": 1000,
          "query_limit": 1000,
          "integrity": { "enabled": true },
          "retry": { "max_attempts": 5, "base_delay_ms": 100, "max_delay_ms": 30000 }
        }
      }]
    }]
  }
}
```

`source.columns` 필드:
- 미지정(`null`) → 소스 테이블의 모든 데이터 컬럼 SELECT (기존 동작)
- `["TIME", "VALUE"]` → 지정된 컬럼만 SELECT (대소문자 무관, 내부적으로 UPPERCASE 정규화)
- 빈 배열(`[]`) 또는 비문자열 항목 → config 검증 오류, 해당 mapping 스킵

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
- **로깅**: `logger/logger.js`의 `Logger` 클래스 사용. `logger.info(stage, fields)` / `logger.warn(...)` / `logger.error(...)` 형태로 호출. 날짜 기반 로테이션, stdout/file 독립 제어 지원.
- **코드 스타일**: 기존 파일의 세미콜론 스타일을 따를 것
- **단일 연결 제약**: `@machbase/ts-client` 연결 하나로 동시 query + append 불가 ("Unexpected protocol N" 오류) → Worker별 독립 연결 사용 (설계 결정 B-01)

## 테스트 실행

```bash
# 전체 단위 테스트 (111개)
node --test tests/unit/*.test.js

# 개별 파일
node --test tests/unit/worker.test.js
node --test tests/unit/e2e_scenarios.test.js

# 통합 테스트 (실 DB 연결 필요 — 192.168.1.189:5656)
node --test tests/integration/tag_replication.test.js
node --test tests/integration/log_replication.test.js
```

현재 테스트 현황: **112 단위 + 19 통합 = 131 pass / 0 fail**
- checkpoint.test.js: CheckpointStore load/save/mismatch (6개)
- client.test.js: fixDoubleEndian (4개)
- config.test.js: 설정 검증 (33개)
- integrity_checker.test.js: IntegrityChecker batchExists (4개)
- retry.test.js: RetryHandler 백오프 로직 (19개)
- table_info.test.js: TableSchema/TagAliasCache 빌드/조회 (13개)
- target_writer.test.js: Writer safeNull 패딩 + Infinity/NaN 처리 (6개)
- worker.test.js: Worker 상태 머신 + Job/Replicator (19개)
- e2e_scenarios.test.js: E2E 시나리오 (8개)
- tag_replication.test.js: TAG 복제 통합 테스트 (11개)
- log_replication.test.js: LOG 복제 통합 테스트 (8개)

## 실행 방법

```bash
node app.js
```

## 알려진 한계 / TODO

1. `on_save_failure="abort"` 미구현 — 현재 "continue"와 동일하게 동작
