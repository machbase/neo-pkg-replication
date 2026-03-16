# repli-js 작업지시서

## 프로젝트 개요

Machbase TAG/LOG 테이블 간 데이터 복제(replication) 도구.
소스 DB에서 RID 기반으로 데이터를 읽어 대상 DB에 Append Stream으로 기록한다.

- **런타임**: Node.js v22 (CommonJS)
- **핵심 의존성**: `@machbase/ts-client@0.9.3` (CMI 프로토콜 기반 Machbase 네이티브 클라이언트)

## 디렉토리 구조

```
repli-js/
├── app.js                        # 진입점 — ConfigLoader → Replicator 실행
├── job_runner.js                 # Replicator, Job — Worker 병렬 실행 오케스트레이션
├── config.json                   # 실행 설정 (jobs, 접속 정보 등)
├── config/
│   └── config.js                 # ConfigLoader — 설정 파일 로드/검증
├── core/
│   ├── types.js                  # ColumnType, Column, TableSchema — 순수 도메인 모델 (I/O 없음)
│   └── retry.js                  # RetryHandler 유틸리티
├── db/
│   ├── client.js                 # MachbaseClient, toInt64 — DB 연결·쿼리 (I/O 계층)
│   ├── stream.js                 # MachbaseStream, _toCell — append 스트림 래퍼
│   └── table.js                  # TagAliasCache, LogTable, TagTable, TagDataTable
├── worker/
│   └── worker.js                 # Worker 클래스 — 상태 머신: RESOLVE_START → STARTUP_INTEGRITY → STEADY_REPLICATION
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
│   │   ├── integrity_checker.test.js   # TagTable.findFirstMissRow 단위 테스트 (7개)
│   │   ├── retry.test.js               # RetryHandler 단위 테스트 (19개)
│   │   └── worker.test.js              # Worker 상태 머신 + Job/Replicator + E2E mock 시나리오 (27개)
│   └── integration/
│       ├── tag_replication.test.js     # TAG 테이블 통합 테스트 (11개)
│       ├── log_replication.test.js     # LOG 테이블 통합 테스트 (8개)
│       └── table.test.js               # LogTable/TagTable/TagDataTable 통합 테스트 (17개)
├── docs/
│   ├── PROJECT.md                # 상세 설계 문서 (아키텍처, UML, 결정 이력)
│   └── ENDIAN_BUG.md             # @machbase/ts-client endian 버그 상세 분석
└── package.json
```

## 핵심 모듈 상세

### app.js — 진입점

- `ConfigLoader.load(configPath)` → `initLogger(config.logging)` → `new Replicator(config).run()`
- SIGTERM / SIGINT 처리는 `Replicator.run()` 내부에서 담당

### config/config.js — ConfigLoader

- `ConfigLoader.load(filePath)` → config 객체 반환
- version 3 필수 검증, servers/jobs 구조 검증
- `_processJob()`: job별 source/target/execution 검증, source.columns UPPERCASE 정규화, tag_identifier/retry/integrity 검증
- `_mergeExecution(...layers)`: EXECUTION_DEFAULTS → job.execution 2-level merge

### job_runner.js — Replicator / Job

- **Replicator**: SIGTERM/SIGINT → `shutdownFlag.value = true`, shutdown timer 관리
  - `shutdown_timeout_ms`: 활성 job 중 최댓값 사용 (기본 30000ms)
  - `module.exports = { Replicator, Job, Worker }`
- **Job**: `while(!shutdown)` 루프 (job = 단일 src→dst 복제 단위)
  - `_discoverMapping(jobConfig, logCtx)` → 소스/대상 스키마 수집 + 검증 (단기 커넥션)
    - TAG: `TagTable.getDataTables()` → `TagTable.getSchema(dataTableId)` 호출
    - LOG: `LogTable.getSchema()` 호출
    - src-only 컬럼 검출 (metadata 제외): 소스에만 있는 컬럼 → discover 실패
    - `source.columns` 유효성 검증: schema에 없는 컬럼명 → discover 실패
  - `AbortController`로 Worker × N `Promise.all` 병렬 실행
  - Worker 에러 시 abort → 루프 재시작

### worker/worker.js — Worker 클래스

`Worker(jobId, jobCheckpoint, mapping, tableType, dataTable, srcSchema, dstSchema, srcConfig, dstConfig, shutdownFlag)` 클래스. `run(signal)` 메서드에서 3단계 상태 전이:

1. **RESOLVE_START**: cp 파일 로드 → `startRid` 결정
   - cp 존재 → `last_success_rid + 1n`
   - cp 없음 → `start_mode` 기준 (`full`=0n, `now`=srcTable.getMaxRid()+1n, `rid_after`=BigInt(exec.rid_after))
   - TAG 테이블: `srcTable.loadTagAliasCache()` 로드
2. **STARTUP_INTEGRITY** (TAG 테이블 + cp 존재 + `integrity.enabled !== false` 시만):
   - `startRid`부터 배치 읽기 → `dstTable.findFirstMissRow()` 대상 DB 존재 확인 (VOLATILE TABLE + JOIN)
   - first miss 발견 → `safe_cp_rid` 저장 후 STEADY 진입
   - 배치마다 신규 `MachbaseClient(dstConfig)` 생성 (statement ID 소진 방지)
3. **STEADY_REPLICATION**: 루프 — `srcTable.read()` → `dstTable.append()` → cp 저장(maxRidInBatch) → sleep(poll_interval_ms)
   - `stmtCount` 추적, 900 도달 시 `srcTable.close()` + `srcTable.open()` (연결 재생성)
   - AbortSignal과 shutdownFlag를 합산하는 `effectiveShutdownFlag` proxy 사용
- `module.exports = { Worker }`

### core/types.js — ColumnType / Column / TableSchema

순수 도메인 모델. I/O 의존성 없음.

- `ColumnType` 클래스: Machbase 컬럼 타입 정의 (`code`, `type`, `safeNull`)
  - Static 상수: `SHORT`, `USHORT`, `INTEGER`, `UINTEGER`, `LONG`, `ULONG`, `DATETIME`, `FLOAT`, `DOUBLE`, `VARCHAR`, `TEXT`, `CLOB`, `BLOB`, `BINARY`, `IPV4`, `IPV6`, `JSON`, `UNKNOWN`
  - `safeNull`: append 패딩용 타입 안전 null 대체값 (int32→`0`, int64/datetime→`0n`, float→`0.0`, string→`''`)
  - `ColumnType.fromCode(code)` → M$SYS_COLUMNS.TYPE 코드로 인스턴스 반환
- `Column` 클래스: 테이블 컬럼 메타정보 (`name`, `columnType`, `id`, `category`)
  - `category`: `'key'`(TAG의 NAME 컬럼), `'data'`(일반 데이터 컬럼), `'metadata'`(TAG META 추가 속성)
- `TableSchema` 클래스: 불변 테이블 컬럼 구조 (`tableType`, `logicalTable`, `columns: Column[]`)
  - constructor: `(tableType, logicalTable, columns)`
- `module.exports = { ColumnType, Column, TableSchema }`

### db/client.js — MachbaseClient

- `MachbaseClient` 클래스: `@machbase/ts-client` 연결 래퍼
  - `connect()` / `close()` / `query(sql, values?)` / `appendOpen(table, columns)` / `execute(sql)`
  - `query()` 반환 직후 `fixDoubleEndian()` 자동 적용 (BE/LE 혼재 버그 우회)
  - **카탈로그 메서드** (DB 구조 조회):
    - `selectTableType(table)` → `{ type: 'TAG'|'LOG'|'UNSUPPORTED' }`
    - `selectTagDataTables(logicalTable)` → `[{ data_table, table_id }]` (table_id는 BigInt 그대로)
    - `selectColumnsByTableName(tableName)` → `[{ NAME, TYPE, ID }]` (META·LOG 컬럼 조회)
    - `selectColumnsByTableId(tableId)` → `[{ NAME, TYPE, ID }]` (DATA 파티션, BigInt 파라미터 허용)
    - `selectMaxRid(tableName)` → `BigInt` (빈 테이블이면 `0n`)
    - `selectTagNames(logicalTable)` → `[{ _ID, name }]` (TAG META 전체 조회)
    - `selectTagNameByTagId(logicalTable, tagId)` → `string|null` (단건 조회)
- `toInt64(val)` → BigInt 변환 유틸리티 (stream.js에서 import)
- `module.exports = { createConnection, QueryError, MachbaseClient, toInt64, ColumnType, Column, TableSchema }`

### db/stream.js — MachbaseStream / _toCell

- `_toCell(col, val)` → append 가능한 형태로 셀 변환 (순수 변환, 로그 없음)
  - null/undefined → `col.columnType.safeNull`
  - int64 → `toInt64(val)` (BigInt 변환)
  - non-finite float → `col.columnType.safeNull`
- `MachbaseStream` 클래스: appendOpen 스트림 생명주기 래퍼 (client 생명주기는 호출자 관리)
  - `open(client, table, columns)` → `Error|null`
  - `append(matrix)` → `Error|null`
  - `close()` → `Error|null`
- `module.exports = { MachbaseStream, _toCell }`

### db/table.js — TagAliasCache / LogTable / TagTable / TagDataTable

- `TagAliasCache` 클래스: TAG alias 캐시 (tag_id → canonical name)
  - `set(tagId, name)` / `get(tagId)` / `size` getter
    - `set()`: name에 `\x00` 포함 시 throw (existSet key 충돌 방지)
  - `resolve(tagId, tagIdentifier)` → `{ canonical, status: 'ok'|'drop_not_found' }` (캐시에서만 조회)
  - `TagAliasCache._applyIdentifier(tagName, tagIdentifier)` → prefix/suffix/none 변환
- `LogTable` 클래스: LOG 테이블의 스키마 조회 + read + append 담당
  - `constructor(logicalTable, config)` → `MachbaseClient` 내부 생성
  - `getSchema()` → `Promise<TableSchema>`
  - `open(useStream?)` / `close()` → DB 연결 + 선택적 append 스트림 열기/닫기
  - `read(startRid, limit?, rangeSize?)` → `{ rows: [{rid, data}], err }`
  - `append(rows)` → `Error|null`
  - `getMaxRid()` → `Promise<BigInt>`
- `TagTable` 클래스: TAG 논리 테이블의 스키마 조회 + append 담당
  - `constructor(logicalTable, config)` → `MachbaseClient` 내부 생성
  - `getSchema(dataTableId)` → `Promise<TableSchema>` (META + DATA 파티션 두 곳 조회)
  - `getDataTables()` → `Promise<[{ data_table, table_id }]>`
  - `open(useStream?)` / `close()` / `append(rows)` / `read()` — LogTable과 동일한 인터페이스
- `TagDataTable` 클래스: TAG 데이터 파티션 단위 읽기 담당
  - `constructor(dataTable, config)` → `logicalTable`을 `dataTable`에서 역산
  - `loadTagAliasCache()` → `_TAG_META` 전체 로드 후 내부 `aliasCache` 구성
  - `read(startRid, limit?, rangeSize?, tagIdentifier?, sourceColumns?)` → `{ rows, err }`
    - `aliasCache` 설정 시 tagId → canonical name resolve
    - `drop_not_found` 행: 단건 DB 조회 후 캐시 갱신, 그래도 없으면 제외
  - `getMaxRid()` / `open()` / `close()`
- `module.exports = { TagAliasCache, LogTable, TagTable, TagDataTable }`

### checkpoint/store.js

- `CheckpointStore(directory)`: `load(jobId, dataTable)` / `save(jobId, dataTable, cp, stats, opts?)`
- 파일 경로: `{directory}/{jobId}{dataTable}.json` (예: `job-1_TAG_DATA_0.json`)
- atomic write 내장: `_writeFile()` — `.{hrtime}.tmp` 파일 → `fs.rename`
- BigInt reviver/replacer 내장: `_parse()` / `_stringify()` (`last_success_rid` 키만 BigInt 복원)
- `source.data_table` 불일치 또는 파싱 실패 → logger 후 `{ cp: null, exists: false }` 반환
- `opts.on_save_failure === 'abort'` 시 저장 실패를 throw로 전파

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
  "logging": {
    "level": "info",
    "stdout": true,
    "file": { "enabled": false, "directory": "./logs" }
  },
  "replication": {
    "jobs": [{
      "id": "job-1",
      "enabled": true,
      "shutdown_timeout_ms": 30000,
      "checkpoint": { "directory": "./checkpoints" },
      "source": {
        "server": "src",
        "table": "TAG",
        "columns": ["TIME", "VALUE"],
        "tag_identifier": { "mode": "none" }
      },
      "target": { "server": "dst", "table": "TAG2" },
      "execution": {
        "start_mode": "full",
        "poll_interval_ms": 1000,
        "query_limit": 1000,
        "rid_range_size": 50000,
        "on_save_failure": "continue",
        "integrity": { "enabled": true },
        "retry": { "max_attempts": 5, "base_delay_ms": 100, "max_delay_ms": 30000 }
      }
    }]
  }
}
```

`source.columns` 필드:
- 미지정(`null`) → 소스 테이블의 모든 데이터 컬럼 SELECT
- `["TIME", "VALUE"]` → 지정된 컬럼만 SELECT (대소문자 무관, 내부적으로 UPPERCASE 정규화)
- 빈 배열(`[]`) 또는 비문자열 항목 → config 검증 오류 (throw)

`source.tag_identifier` 필드:
- `{ "mode": "none" }` → 태그명 그대로 사용 (기본값)
- `{ "mode": "prefix", "value": "site1/" }` → 태그명 앞에 prefix 추가
- `{ "mode": "suffix", "value": "_copy" }` → 태그명 뒤에 suffix 추가

`execution.start_mode` 필드:
- `"full"` → RID 0부터 전체 복제
- `"now"` → 현재 최대 RID+1부터 시작 (이전 데이터 무시)
- `"rid_after"` → `rid_after` 값 이후부터 시작 (`rid_after` 필드 필수)

## Machbase TAG 테이블 내부 구조

- `_TAG_META` — 태그 메타 정보 (`_ID` → name 매핑)
- `_TAG_DATA_0` ~ `_TAG_DATA_N` — 실제 데이터 파티션
- `V$STORAGE_TAG_TABLES` — 파티션별 RID 범위 등 스토리지 정보
- `M$SYS_TABLES` / `M$SYS_COLUMNS` — 시스템 카탈로그

RID_RANGE 힌트 예시:
```sql
SELECT /*+ RID_RANGE(_TAG_DATA_0, 0, 50000) */ _RID, name, time, value
FROM _TAG_DATA_0
WHERE _RID >= 0
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
# 단위 테스트
node --test tests/unit/*.test.js

# 통합 테스트 (실 DB 연결 필요 — 127.0.0.1:5656)
node --test tests/integration/tag_replication.test.js
node --test tests/integration/log_replication.test.js
node --test tests/integration/table.test.js
```

현재 테스트 현황: **92 단위 = 92 pass / 0 fail** (`node --test tests/unit/*.test.js`)
- checkpoint.test.js: CheckpointStore load/save/mismatch (6개)
- client.test.js: fixDoubleEndian (4개)
- config.test.js: 설정 검증 (33개)
- integrity_checker.test.js: TagTable.findFirstMissRow (7개)
- retry.test.js: RetryHandler 백오프 로직 (15개)
- worker.test.js: Worker 상태 머신 + Job/Replicator + E2E mock 시나리오 (27개)
- tag_replication.test.js: TAG 복제 통합 테스트 (11개)
- log_replication.test.js: LOG 복제 통합 테스트 (8개)
- table.test.js: LogTable/TagTable/TagDataTable 통합 테스트 (17개)

## 실행 방법

```bash
node app.js [config.json 경로]  # 경로 미지정 시 ./config.json 사용
```

## @machbase/ts-client double endian 버그 우회 (중요)

- **버그**: `decodeFixedField()`가 FLT32/FLT64를 항상 `readFloatLE`/`readDoubleLE`로 읽음
- **현상**: TAG 파티션에 따라 BE로 저장된 값을 LE로 읽어 denormal(극소값) 발생
- **우회**: `db/client.js`의 `fixDoubleEndian()` — `MachbaseClient.query()` 반환 직전 자동 적용
  - `FLOAT_MIN_NORMAL(1.175e-38)` 미만 nonzero → DOUBLE BE→LE 복원 시도, 실패 시 FLOAT 시도
  - 상세: `docs/ENDIAN_BUG.md`

## 알려진 한계 / TODO

1. `on_save_failure="abort"` → checkpoint 저장 실패 시 throw 전파는 구현됨. Worker 레벨 abort 처리는 미구현.
