# repli-js 작업지시서

## 프로젝트 개요

Machbase TAG/LOG 테이블 간 데이터 복제(replication) 도구.
소스 DB에서 RID 기반으로 데이터를 읽어 대상 DB에 Append Stream으로 기록한다.

- **런타임**: Node.js v22 (CommonJS)
- **핵심 의존성**: `@machbase/ts-client@0.9.3` (CMI 프로토콜 기반 Machbase 네이티브 클라이언트)

## 디렉토리 구조

```
repli-js/
├── app.js                        # 진입점 — Config.load() → Replicator 실행
├── config.json                   # 실행 설정 (jobs, 접속 정보 등)
├── src/
│   ├── replicator.js             # Replicator — SIGTERM/SIGINT 처리, JobScheduler 관리
│   ├── job.js                    # JobScheduler, Job
│   ├── api/
│   │   └── http_server.js        # HttpServer — REST API (JobScheduler에만 의존)
│   ├── config/
│   │   └── config.js             # Config 클래스 및 config 도메인 클래스 전체
│   ├── db/
│   │   ├── client.js             # MachbaseClient, toInt64 — DB 연결·쿼리 (I/O 계층)
│   │   ├── stream.js             # MachbaseStream, _toCell — append 스트림 래퍼
│   │   ├── table.js              # TagAliasCache, LogTable, TagTable, TagDataTable
│   │   └── checkpoint.js         # CheckpointStore — cp 파일 load/save (atomic write, BigInt 내장)
│   ├── worker/
│   │   └── worker.js             # Worker 클래스 — 상태 머신: RESOLVE_START → STARTUP_INTEGRITY → STEADY_REPLICATION
│   └── lib/
│       ├── logger.js             # Logger 클래스 — 날짜 로테이션, stdout/file 출력
│       ├── retry.js              # RetryHandler 유틸리티
│       └── types.js              # ColumnType, Column, TableSchema — 순수 도메인 모델 (I/O 없음)
├── data/                         # 런타임 생성 — job별 파티션 cp 파일 저장 디렉토리 (고정 경로)
├── tests/
│   ├── unit/
│   │   ├── checkpoint.test.js          # CheckpointStore 단위 테스트 (6개)
│   │   ├── client.test.js              # fixDoubleEndian 단위 테스트 (4개)
│   │   ├── config.test.js              # Config 단위 테스트 (30개)
│   │   ├── integrity_checker.test.js   # TagTable.findFirstMissRow 단위 테스트 (7개)
│   │   ├── retry.test.js               # RetryHandler 단위 테스트 (15개)
│   │   └── worker.test.js              # Worker 상태 머신 + Job/JobScheduler/Replicator + E2E mock 시나리오 (31개)
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

- `Config.load(configPath)` → `initLogger(config.logging)` → `new Replicator(config).run()`
- SIGTERM / SIGINT 처리는 `Replicator.run()` 내부에서 담당

### src/replicator.js — Replicator

- SIGTERM/SIGINT → `scheduler.stopAll()` → `httpServer.stop()`, shutdown timer 관리
- `shutdownTimeoutMs`: 활성 job 중 최댓값 사용 (기본 30000ms)
- `config.api.enabled` 시 `HttpServer` 생성 후 시작
- job은 자동 시작하지 않음 — API를 통해 개별 시작
- `module.exports = { Replicator }`

### src/job.js — JobScheduler / Job

- **JobScheduler**: job 생명주기 관리 (`registry: Map`)
  - `register(jobConfig)` / `unregister(id)` / `update(jobConfig)` — stopped 상태에서만 가능
  - `start(id)` → `new Job(...).run()` 실행, status='running'
  - `stop(id)` → shutdownFlag 설정 후 promise 대기
  - `stopAll()` → 모든 running entry에 shutdownFlag 설정 후 `Promise.all` 대기
  - `getEntry(id)` / `listEntries()`
  - `module.exports = { JobScheduler, Job, Worker }`
- **Job**: `while(!shutdown)` 루프 (job = 단일 src→dst 복제 단위)
  - `_discoverMapping(logCtx)` → 소스/대상 스키마 수집 + 검증 (단기 커넥션)
    - TAG: `TagTable.getDataTables()` → `TagTable.getSchema()` 호출
    - LOG: `LogTable.getSchema()` 호출
    - src-only 컬럼 검출 (metadata 제외): 소스에만 있는 컬럼 → discover 실패
    - `source.columns` 유효성 검증: schema에 없는 컬럼명 → discover 실패
  - `AbortController`로 Worker × N `Promise.all` 병렬 실행
  - Worker 에러 시 abort → 루프 재시작

### src/api/http_server.js — HttpServer

- `HttpServer(scheduler, config)` — JobScheduler + Config 인스턴스에만 의존
- Job CRUD REST API: `GET/POST /api/jobs`, `GET/PUT/DELETE /api/jobs/:id`, `POST /api/jobs/:id/start|stop`
- `config.addJob()` / `config.updateJob()` / `config.removeJob()` + `config.save()` 연동
- `module.exports = { HttpServer }`

### src/config/config.js — Config 및 도메인 클래스

config 도메인 클래스 전체가 이 파일에 정의된다.

**config 클래스 계층**
```
Config
 ├─ servers: ServerConfig[]
 ├─ replication: ReplicationConfig
 │   └─ jobs: JobConfig[]
 │       ├─ source: SourceConfig
 │       │   └─ tagIdentifier: TagIdentifierConfig
 │       ├─ target: TargetConfig
 │       ├─ integrity: IntegrityConfig (optional)
 │       └─ retry: RetryConfig (optional)
 ├─ logging: LoggingConfig
 │   └─ file: LoggingFileConfig
 └─ api: ApiConfig
```

**Config 클래스**
- `static async load(filePath?)` → `Config` 인스턴스 반환 (기본 경로: `../../config.json`)
- `async save()` — atomic write (tmp → rename)
- `addJob(rawJob)` / `updateJob(id, rawJob)` / `removeJob(id)`
- `module.exports = { Config, JobConfig, ServerConfig, SourceConfig, TargetConfig, IntegrityConfig, RetryConfig, TagIdentifierConfig, LoggingConfig, LoggingFileConfig, ApiConfig, ReplicationConfig, CHECKPOINT_DIRECTORY }`

**각 클래스의 `valid()` 메서드**
- 생성 후 호출하여 검증. 실패 시 throw.
- `Config._buildJob(job, servers)` 내부에서 `new XxxConfig(raw)` → `instance.valid()` 패턴 사용

**JobConfig 필드 (flat 구조, execution 중첩 없음)**
```
id, shutdownTimeoutMs,
source (SourceConfig), target (TargetConfig),
queryLimit, ridRangeSize, pollIntervalMs,
startMode, ridAfter, onSaveFailure,
integrity (IntegrityConfig?), retry (RetryConfig?)
```
- 기본값: `queryLimit=5000`, `ridRangeSize=50000`, `pollIntervalMs=1000`, `startMode='full'`, `onSaveFailure='continue'`

**CHECKPOINT_DIRECTORY**: `path.join(__dirname, '../../data')` 고정 경로 (외부 설정 불필요)

### src/worker/worker.js — Worker 클래스

`Worker(jobConfig, tableType, dataTable, srcSchema, dstSchema, srcConfig, dstConfig, shutdownFlag)` 클래스. `run(signal)` 메서드에서 3단계 상태 전이:

1. **RESOLVE_START**: cp 파일 로드 → `startRid` 결정
   - cp 존재 → `lastSuccessRid + 1n`
   - cp 없음 → `startMode` 기준 (`full`=0n, `now`=srcTable.getMaxRid()+1n, `ridAfter`=BigInt(jobConfig.ridAfter))
   - TAG 테이블: `srcTable.loadTagAliasCache()` 로드
2. **STARTUP_INTEGRITY** (TAG 테이블 + cp 존재 + `integrity.enabled !== false` 시만):
   - `startRid`부터 배치 읽기 → `dstTable.findFirstMissRow()` 대상 DB 존재 확인 (VOLATILE TABLE + JOIN)
   - firstMiss 발견 → `safeCpRid` 저장 후 STEADY 진입
   - 배치마다 신규 `MachbaseClient(dstConfig)` 생성 (statement ID 소진 방지)
3. **STEADY_REPLICATION**: 루프 — `srcTable.read()` → `dstTable.append()` → cp 저장(maxRidInBatch) → sleep(pollIntervalMs)
   - `stmtCount` 추적, 900 도달 시 `srcTable.close()` + `srcTable.open()` (연결 재생성)
   - AbortSignal과 shutdownFlag를 합산하는 `effectiveShutdownFlag` proxy 사용
- `module.exports = { Worker }`

### src/db/types.js — ColumnType / Column / TableSchema

순수 도메인 모델. I/O 의존성 없음.

- `ColumnType` 클래스: Machbase 컬럼 타입 정의 (`code`, `type`, `safeNull`)
  - `safeNull`: append 패딩용 타입 안전 null 대체값 (int32→`0`, int64/datetime→`0n`, float→`0.0`, string→`''`)
  - `ColumnType.fromCode(code)` → M$SYS_COLUMNS.TYPE 코드로 인스턴스 반환
- `Column` 클래스: 테이블 컬럼 메타정보 (`name`, `columnType`, `id`, `flag`, `length`)
  - `flag`: `M$SYS_COLUMNS.FLAG` 원본값 — `FLAG_*` 상수로 비트 검사
- `FLAG_PRIMARY=0x8000000`, `FLAG_BASETIME=0x1000000`, `FLAG_SUMMARIZED=0x2000000`, `FLAG_METADATA=0x4000000`
- `TableSchema` 클래스: 불변 테이블 컬럼 구조 (`tableType`, `logicalTable`, `columns: Column[]`)
- `module.exports = { ColumnType, Column, TableSchema, FLAG_PRIMARY, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA }`

### db/client.js — MachbaseClient

- `MachbaseClient` 클래스: `@machbase/ts-client` 연결 래퍼
  - `connect()` / `close()` / `query(sql, values?)` / `appendOpen(table, columns)` / `execute(sql)`
  - `query()` 반환 직후 `fixDoubleEndian()` 자동 적용 (BE/LE 혼재 버그 우회)
  - **카탈로그 메서드**: `selectTableType`, `selectTagDataTables`, `selectColumnsByTableName`, `selectColumnsByTableId`, `selectMaxRid`, `selectTagNames`, `selectTagNameByTagId`
  - **DDL 메서드**: `createTagTable(tableName, srcSchema)`, `createLogTable(tableName, srcSchema)` — autoCreate 기능에서 사용
- `toInt64(val)` → BigInt 변환 유틸리티
- `module.exports = { createConnection, QueryError, MachbaseClient, toInt64, ColumnType, Column, TableSchema }`

### db/stream.js — MachbaseStream / _toCell

- `_toCell(col, val)` → append 가능한 형태로 셀 변환 (순수 변환, 로그 없음)
- `MachbaseStream` 클래스: appendOpen 스트림 생명주기 래퍼
- `module.exports = { MachbaseStream, _toCell }`

### db/table.js — TagAliasCache / LogTable / TagTable / TagDataTable

- `TagAliasCache`: TAG alias 캐시 (tag_id → canonical name)
- `LogTable`: LOG 테이블 스키마 조회 + read + append
- `TagTable`: TAG 논리 테이블 스키마 조회 + append + findFirstMissRow
- `TagDataTable`: TAG 데이터 파티션 단위 읽기
- `module.exports = { TagAliasCache, LogTable, TagTable, TagDataTable }`

### checkpoint/store.js — CheckpointStore

- `CheckpointStore(directory)`: `load(jobId, dataTable)` / `save(jobId, dataTable, cp, stats, opts?)`
- 파일 경로: `{directory}/{jobId}_{dataTable}.json`
- atomic write 내장 (`.{hrtime}.tmp` → `fs.rename`)
- BigInt reviver/replacer 내장 (`lastSuccessRid` 키만 BigInt 복원)

## config.json 형식

```json
{
  "version": 3,
  "servers": [
    { "name": "src", "host": "...", "port": 5656, "user": "SYS", "password": "MANAGER" },
    { "name": "dst", "host": "...", "port": 5656, "user": "SYS", "password": "MANAGER" }
  ],
  "logging": {
    "level": "info",
    "stdout": true,
    "file": { "enabled": false, "directory": "./logs" }
  },
  "api": { "enabled": true, "port": 8080, "cors": { "origin": "*" } },
  "replication": {
    "jobs": [{
      "id": "job-1",
      "shutdownTimeoutMs": 30000,
      "source": {
        "server": "src",
        "table": "TAG",
        "columns": ["TIME", "VALUE"],
        "tagIdentifier": { "mode": "none" }
      },
      "target": { "server": "dst", "table": "TAG2", "autoCreate": false },
      "startMode": "full",
      "pollIntervalMs": 1000,
      "queryLimit": 1000,
      "ridRangeSize": 50000,
      "onSaveFailure": "continue",
      "integrity": { "enabled": true },
      "retry": { "maxAttempts": 5, "baseDelayMs": 100, "maxDelayMs": 30000 }
    }]
  }
}
```

**주요 변경 (v3):**
- `servers`: object(Map) → array, 각 항목에 `name` 필드 추가
- `execution` 블록 제거 — job 필드로 flat하게 통합
- `checkpoint` 설정 제거 — `data/` 디렉토리로 고정

`source.columns` 필드:
- 미지정(`null`) → 소스 테이블의 모든 데이터 컬럼 SELECT
- `["TIME", "VALUE"]` → 지정된 컬럼만 SELECT (대소문자 무관, UPPERCASE 정규화)
- 빈 배열(`[]`) 또는 비문자열 항목 → config 검증 오류 (throw)

`source.tag_identifier` 필드:
- `{ "mode": "none" }` → 태그명 그대로 사용 (기본값)
- `{ "mode": "prefix", "value": "site1/" }` → 태그명 앞에 prefix 추가
- `{ "mode": "suffix", "value": "_copy" }` → 태그명 뒤에 suffix 추가

`target.autoCreate` 필드:
- 미지정 또는 `false` (기본): 대상 테이블 사전 생성 필요. 없으면 job skip.
- `true`: 대상 테이블 없으면 src 스키마 기반으로 자동 CREATE 후 복제 시작.
  - `table: ""` 허용 → `source.table` 이름 그대로 사용
  - TAG: PRIMARY KEY / BASETIME / SUMMARIZED / METADATA 포함 DDL 자동 생성
  - LOG: 컬럼 그대로 CREATE TABLE

`start_mode` 필드:
- `"full"` → RID 0부터 전체 복제
- `"now"` → 현재 최대 RID+1부터 시작 (이전 데이터 무시)
- `"rid_after"` → `rid_after` 값 이후부터 시작 (`rid_after` 필드 필수)

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
- **로깅**: `lib/logger.js`의 `Logger` 클래스 사용. `logger.trace(...)` / `logger.debug(...)` / `logger.info(...)` / `logger.warn(...)` / `logger.error(...)` 형태로 호출.
  - `trace`: 매우 상세한 값 변환 로그 (예: fixDoubleEndian)
  - `debug`: 반복성 내부 상태 진단 로그 (예: stmtCount 갱신, STARTUP_INTEGRITY 배치 진행)
  - `info`: 상태 전환 및 정상 동작 로그 (예: job start/stop, checkpoint_saved, STEADY 진입)
  - `warn`: 예상치 못한 상황, 계속 실행 가능 (예: alias cache miss, MAX(_RID) fallback)
  - `error`: 실패·스킵·오류
- **코드 스타일**: 기존 파일의 세미콜론 스타일을 따를 것
- **단일 연결 제약**: `@machbase/ts-client` 연결 하나로 동시 query + append 불가 → Worker별 독립 연결 사용 (설계 결정 B-01)

## 테스트 실행

```bash
# 단위 테스트
node --test tests/unit/*.test.js

# 통합 테스트 (실 DB 연결 필요 — 127.0.0.1:5656)
node --test tests/integration/tag_replication.test.js
node --test tests/integration/log_replication.test.js
node --test tests/integration/table.test.js
```

현재 테스트 현황: **161 단위 = 161 pass / 0 fail** (`node --test tests/unit/*.test.js`)
- checkpoint.test.js: CheckpointStore load/save/mismatch (6개)
- client.test.js: fixDoubleEndian (4개)
- config.test.js: 설정 검증 + addJob/updateJob/removeJob/save + autoCreate (47개)
- http_server.test.js: Jobs REST API 7개 엔드포인트 (19개)
- http_server_servers.test.js: Servers REST API 8개 엔드포인트 (23개)
- integrity_checker.test.js: TagTable.findFirstMissRow (7개)
- job-scheduler.test.js: Job._discoverMapping + autoCreate + AbortController 전파 + JobScheduler (19개)
- replicator.test.js: Replicator SIGTERM (1개)
- retry.test.js: RetryHandler 백오프 로직 (15개)
- worker-state.test.js: Worker 상태 머신 + E2E mock 시나리오 (stmtCount 갱신 포함) (20개)

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
