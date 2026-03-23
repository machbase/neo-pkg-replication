# repli-js 작업지시서

## 프로젝트 개요

Machbase TAG/LOG 테이블 간 데이터 복제(replication) 도구.
소스 DB에서 RID 기반으로 데이터를 읽어 대상 DB에 Append Stream으로 기록한다.

- **런타임**: machbase-neo jsh (goja 기반)
- **핵심 의존성**: `machcli` (jsh 내장 동기 DB 클라이언트)

## 디렉토리 구조

```
repli-js/
├── app.js                        # 진입점 — Config.load() → Replicator 실행
├── config.json                   # 실행 설정 (jobs, 접속 정보 등)
├── src/
│   ├── replicator.js             # Replicator -- SIGTERM/SIGINT 처리, Job 직접 실행
│   ├── job.js                    # Job, AbortController (직접 구현)
│   ├── config/
│   │   └── config.js             # Config 클래스 및 config 도메인 클래스 전체
│   ├── db/
│   │   ├── client.js             # MachbaseClient, toInt64 -- DB 연결·쿼리 (machcli 래퍼)
│   │   ├── stream.js             # MachbaseStream, _toCell -- append 스트림 래퍼
│   │   ├── table.js              # TagMetaCache, LogTable, TagTable, TagDataTable
│   │   └── checkpoint.js         # CheckpointStore -- cp 파일 load/save (atomic write, BigInt 내장)
│   ├── worker/
│   │   └── worker.js             # Worker 클래스 -- 상태 머신: RESOLVE_START -> STARTUP_INTEGRITY -> STEADY_REPLICATION
│   └── lib/
│       ├── logger.js             # Logger 클래스 -- 날짜 로테이션, stdout/file 출력
│       ├── retry.js              # RetryHandler 유틸리티
│       └── types.js              # ColumnType, Column, TableSchema -- 순수 도메인 모델 (I/O 없음)
├── data/                         # 런타임 생성 -- job별 파티션 cp 파일 저장 디렉토리 (/work/data/ 고정)
├── tests/
│   ├── unit/
│   │   ├── checkpoint.test.js          # CheckpointStore 단위 테스트 (6개)
│   │   ├── config.test.js              # Config 단위 테스트
│   │   ├── integrity_checker.test.js   # TagTable.findFirstMissRow 단위 테스트 (7개)
│   │   └── retry.test.js               # RetryHandler 단위 테스트 (15개)
│   └── integration/
│       ├── tag_replication.test.js     # TAG 테이블 통합 테스트 (11개)
│       ├── log_replication.test.js     # LOG 테이블 통합 테스트 (8개)
│       └── table.test.js               # LogTable/TagTable/TagDataTable 통합 테스트 (17개)
├── docs/
│   └── PROJECT.md                # 상세 설계 문서 (아키텍처, UML, 결정 이력)
└── package.json
```

## 핵심 모듈 상세

### app.js — 진입점

- `Config.load(configPath)` -> `initLogger(config.logging)` -> `new Replicator(config).run()`
- SIGTERM / SIGINT 처리는 `Replicator.run()` 내부에서 담당

### src/replicator.js — Replicator

- SIGTERM/SIGINT -> `shutdownFlag.value = true`, shutdown timer 관리
- `shutdownTimeoutMs`: `jobConfig.shutdownTimeoutMs` 사용 (기본 30000ms)
- `config.replication.jobs[0]` 단일 job을 `new Job(...).run()` 직접 실행
- `module.exports = { Replicator }`

### src/job.js — Job

- **AbortController**: jsh 미제공으로 job.js에 직접 구현
- **Job**: `while(!shutdown)` 루프 (job = 단일 src->dst 복제 단위)
  - `_discoverMapping(logCtx)` -> 소스/대상 스키마 수집 + 검증 (단기 커넥션)
    - TAG: `TagTable.getDataTables()` -> `TagTable.getSchema()` 호출
    - LOG: `LogTable.getSchema()` 호출
    - src-only 컬럼 검출 (metadata 제외): 소스에만 있는 컬럼 -> discover 실패
    - `source.columns` 유효성 검증: schema에 없는 컬럼명 -> discover 실패
  - `AbortController`로 Worker x N `Promise.all` 병렬 실행
  - Worker 에러 시 abort -> 루프 재시작

### src/config/config.js — Config 및 도메인 클래스

config 도메인 클래스 전체가 이 파일에 정의된다.

**config 클래스 계층**
```
Config
 +- servers: ServerConfig[]
 +- replication: ReplicationConfig
 |   +- jobs: JobConfig[]
 |       +- source: SourceConfig
 |       |   +- filter: ColumnFilterConfig[] (optional)
 |       |   +- transform: ColumnTransformConfig[] (optional)
 |       +- target: TargetConfig
 |       +- integrity: IntegrityConfig (optional)
 |       +- retry: RetryConfig (optional)
 +- logging: LoggingConfig
 |   +- file: LoggingFileConfig
 +- api: ApiConfig
```

**Config 클래스**
- `static async load(filePath?)` -> `Config` 인스턴스 반환 (기본 경로: `/work/config.json`)
- `async save()` — atomic write (tmp -> rename), 절대경로 사용
- `addJob(rawJob)` / `updateJob(id, rawJob)` / `removeJob(id)`
- `module.exports = { Config, JobConfig, ServerConfig, SourceConfig, TargetConfig, IntegrityConfig, RetryConfig, ColumnFilterConfig, ColumnTransformConfig, LoggingConfig, LoggingFileConfig, ApiConfig, ReplicationConfig, CHECKPOINT_DIRECTORY }`

**각 클래스의 `valid()` 메서드**
- 생성 후 호출하여 검증. 실패 시 throw.
- `Config._buildJob(job, servers)` 내부에서 `new XxxConfig(raw)` -> `instance.valid()` 패턴 사용

**JobConfig 필드 (flat 구조, execution 중첩 없음)**
```
id, shutdownTimeoutMs,
source (SourceConfig), target (TargetConfig),
queryLimit, ridRangeSize, pollIntervalMs,
startMode, ridAfter, onSaveFailure,
integrity (IntegrityConfig?), retry (RetryConfig?)
```
- 기본값: `queryLimit=5000`, `ridRangeSize=50000`, `pollIntervalMs=1000`, `startMode='full'`, `onSaveFailure='continue'`

**CHECKPOINT_DIRECTORY**: `/work/data` 고정 경로 (`process.cwd()` 기반, 외부 설정 불필요)

### src/worker/worker.js — Worker 클래스

`Worker(jobConfig, tableType, dataTable, srcSchema, dstSchema, srcConfig, dstConfig, shutdownFlag)` 클래스. `run(signal)` 메서드에서 3단계 상태 전이:

1. **RESOLVE_START**: cp 파일 로드 -> `startRid` 결정
   - cp 존재 -> `lastSuccessRid + 1n`
   - cp 없음 -> `startMode` 기준 (`full`=0n, `now`=srcTable.getMaxRid()+1n, `ridAfter`=BigInt(jobConfig.ridAfter))
   - TAG 테이블: `srcTable.loadTagMetaCache()` 로드
2. **STARTUP_INTEGRITY** (TAG 테이블 + cp 존재 + `integrity.enabled !== false` 시만):
   - `startRid`부터 배치 읽기 -> `dstTable.findFirstMissRow()` 대상 DB 존재 확인 (VOLATILE TABLE + JOIN)
   - firstMiss 발견 -> `safeCpRid` 저장 후 STEADY 진입
   - 배치마다 신규 `MachbaseClient(dstConfig)` 생성 (statement ID 소진 방지)
3. **STEADY_REPLICATION**: 루프 -- `srcTable.read()` -> `dstTable.append()` -> cp 저장(maxRidInBatch) -> sleep(pollIntervalMs)
   - `stmtCount` 추적, 900 도달 시 `srcTable.close()` + `srcTable.open()` (연결 재생성)
   - AbortSignal과 shutdownFlag를 합산하는 `effectiveShutdownFlag` proxy 사용
- `module.exports = { Worker }`

### src/db/types.js — ColumnType / Column / TableSchema

순수 도메인 모델. I/O 의존성 없음.

- `ColumnType` 클래스: Machbase 컬럼 타입 정의 (`ddlType`)
  - `ColumnType.fromCode(code)` -> M$SYS_COLUMNS.TYPE 코드로 인스턴스 반환
- `Column` 클래스: 테이블 컬럼 메타정보 (`name`, `columnType`, `id`, `flag`, `length`)
  - `flag`: `M$SYS_COLUMNS.FLAG` 원본값 — `FLAG_*` 상수로 비트 검사
- `FLAG_PRIMARY=0x8000000`, `FLAG_BASETIME=0x1000000`, `FLAG_SUMMARIZED=0x2000000`, `FLAG_METADATA=0x4000000`
- `TableSchema` 클래스: 불변 테이블 컬럼 구조 (`tableType`, `logicalTable`, `columns: Column[]`)
- `module.exports = { ColumnType, Column, TableSchema, FLAG_PRIMARY, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA }`

### db/client.js — MachbaseClient

- `MachbaseClient` 클래스: `machcli` (jsh 내장) 연결 래퍼
  - `connect()` / `close()` / `query(sql, values?)` / `openAppender(table, columns)` / `execute(sql)`
  - **카탈로그 메서드**: `selectTableType`, `selectTagDataTables`, `selectColumnsByTableName`, `selectColumnsByTableId`, `selectMaxRid`, `selectTagNames`, `selectTagNameByTagId`
  - **DDL 메서드**: `createTagTable(tableName, schema)`, `createLogTable(tableName, schema)` — autoCreate 기능에서 사용
- `module.exports = { MachbaseClient, ColumnType, Column, TableSchema }`

### db/stream.js — MachbaseStream

- `MachbaseStream` 클래스: machcli Appender 생명주기 래퍼
  - `open(client, table, columns)` — `client.openAppender()` 호출
  - `appender.flush()` + `appender.close()` 명시 호출
- `module.exports = { MachbaseStream }`

### db/table.js — TagMetaCache / LogTable / TagTable / TagDataTable

- `TagMetaCache`: TAG 메타 캐시 (tag_id -> `{ name, meta }` -- canonical name + metadata 컬럼 값)
  - `_applyNameRule(tagName, nameRule)`: transform의 NAME 컬럼 규칙 적용 (prefix/suffix)
- `LogTable`: LOG 테이블 스키마 조회 + read + append
  - `read(startRid, limit?, rangeSize?, filter?)` -- filter의 min/max/in/like를 WHERE절로 반영 (in/like는 파라미터 바인딩 사용)
- `TagTable`: TAG 논리 테이블 스키마 조회 + append + findFirstMissRow
  - `loadTagMetaCache(nameFilter?)` -- nameFilter: `{ in?, like? }`, WHERE절로 META 조회 범위 제한
- `TagDataTable`: TAG 데이터 파티션 단위 읽기
  - `read(startRid, limit?, rangeSize?, nameRule?, sourceColumns?, filter?)` -- nameRule로 NAME 변환, filter의 min/max/in/like를 WHERE절로 반영 (in/like는 파라미터 바인딩 사용)
- `module.exports = { TagMetaCache, LogTable, TagTable, TagDataTable }`

### checkpoint/store.js — CheckpointStore

- `CheckpointStore(directory)`: `load(dataTable)` / `save(dataTable, cp, stats, opts?)`
- 파일 경로: `{directory}/{dataTable}.json` (directory는 replicator별 하위 경로)
- atomic write 내장 (`.{Date.now()}.tmp` -> `fs.renameSync`) — `fs` 동기 API 사용
- BigInt reviver/replacer 내장 (`lastSuccessRid` 키만 BigInt 복원)

## config.json 형식

```json
{
  "source": {
    "host": "...", "port": 5656, "user": "SYS", "password": "MANAGER",
    "table": "TAG",
    "columns": ["TIME", "VALUE"],
    "filter": [
      { "column": "NAME", "in": ["sensor_a", "sensor_b"] },
      { "column": "VALUE", "min": 0, "max": 100 },
      { "column": "LABEL", "like": "sensor_%" }
    ],
    "transform": [
      { "column": "NAME", "prefix": "site1/" },
      { "column": "VALUE", "multiply": 0.001 }
    ]
  },
  "target": {
    "host": "...", "port": 5656, "user": "SYS", "password": "MANAGER",
    "table": "TAG2",
    "autoCreate": false
  },
  "logging": {
    "level": "info",
    "stdout": true,
    "file": { "enabled": false, "directory": "/work/logs" }
  },
  "shutdownTimeoutMs": 30000,
  "startMode": "full",
  "pollIntervalMs": 1000,
  "queryLimit": 1000,
  "ridRangeSize": 50000,
  "onSaveFailure": "continue",
  "integrity": { "enabled": true },
  "retry": { "maxAttempts": 5, "baseDelayMs": 100, "maxDelayMs": 30000 }
}
```

**구조 변경:**
- `servers` 배열 제거 — 접속 정보(`host`, `port`, `user`, `password`)를 `source`/`target` 안에 직접 포함
- `replication.jobs` 계층 제거 — 모든 필드 최상위 flat 구조
- `checkpoint` 설정 제거 — `/work/data/` 디렉토리로 고정
- `logging.file.directory`: 절대경로 `/work/logs` 사용 권장

`source.columns` 필드:
- 미지정(`null`) -> 소스 테이블의 모든 데이터 컬럼 SELECT
- `["TIME", "VALUE"]` -> 지정된 컬럼만 SELECT (대소문자 무관, UPPERCASE 정규화)
- 빈 배열(`[]`) 또는 비문자열 항목 -> config 검증 오류 (throw)

`source.filter` 필드 (WHERE절 필터, read 전 적용):
- 미지정(`null`) -> 필터 없음 (기본값)
- 각 항목: `{ "column": "COLNAME", "min": ..., "max": ..., "in": [...], "like": "..." }`
  - `column`: 대상 컬럼명 (대소문자 무관, UPPERCASE 정규화), 필수
  - `min` / `max`: WHERE절 필터 (숫자형 컬럼에만 적용). 각각 optional
  - `in`: VARCHAR/TEXT 컬럼에 WHERE `column IN (?, ?, ...)` 필터 적용 (문자열 배열, 파라미터 바인딩)
  - `like`: VARCHAR/TEXT 컬럼에 WHERE `column LIKE ?` 필터 적용 (문자열, 파라미터 바인딩)
  - TAG 테이블의 NAME 컬럼 `in`/`like` 필터: META 테이블 조회 시 WHERE절로 처리 (파티션 WHERE에는 미포함)
  - 중복 column 항목 -> config 검증 오류 (throw)
  - `min > max` -> config 검증 오류 (throw)

`source.transform` 필드 (post-read 값 변환, read 후 적용):
- 미지정(`null`) -> 변환 없음 (기본값)
- 각 항목: `{ "column": "COLNAME", "add": 0, "multiply": 1, "prefix": "...", "suffix": "..." }`
  - `column`: 대상 컬럼명 (대소문자 무관, UPPERCASE 정규화), 필수
  - `add`: 수치 변환 덧셈 오프셋 (기본 `0`). 적용 공식: `(value + add) * multiply`
  - `multiply`: 수치 변환 배율 (기본 `1`). BigInt 컬럼(datetime/long)은 skip
  - `prefix` / `suffix`: 문자열 컬럼 앞/뒤에 붙이는 값. TAG/LOG 모두 지원
  - 중복 column 항목 -> config 검증 오류 (throw)

`target.autoCreate` 필드:
- 미지정 또는 `false` (기본): 대상 테이블 사전 생성 필요. 없으면 job skip.
- `true`: 대상 테이블 없으면 src 스키마 기반으로 자동 CREATE 후 복제 시작.
  - `table: ""` 허용 -> `source.table` 이름 그대로 사용
  - TAG: PRIMARY KEY / BASETIME / SUMMARIZED / METADATA 포함 DDL 자동 생성
  - LOG: 컬럼 그대로 CREATE TABLE

`start_mode` 필드:
- `"full"` -> RID 0부터 전체 복제
- `"now"` -> 현재 최대 RID+1부터 시작 (이전 데이터 무시)
- `"rid_after"` -> `rid_after` 값 이후부터 시작 (`rid_after` 필드 필수)

## machcli API 참조 (현재 사용: machcli)

jsh 내장 동기 DB 클라이언트. 모든 메서드 동기 실행 (async/await 불필요).

### 연결

```js
const machcli = require('machcli');
const client = new machcli.Client({
  host: string,
  port: number,
  user: string,
  password: string,
});
const conn = client.connect();  // Connection 반환
conn.close();
```

### Connection 주요 메서드

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `query()` | `(sql, ...params) -> Rows` | SQL 쿼리 실행 (for...of 순회 후 rows.close() 필요) |
| `exec()` | `(sql, ...params) -> result` | DDL/DML 실행 (파라미터 바인딩 지원) |
| `append()` | `(table) -> Appender` | Append 스트림 오픈 |

### Appender 사용

```js
const appender = conn.append(tableName);
appender.append(v1, v2, v3, ...);  // spread 방식
appender.flush();   // 명시 호출 필요
appender.close();   // 명시 호출 필요
```

- VOLATILE TABLE은 append 미지원 -> `exec('INSERT INTO ... VALUES (?,?,?)', v1, v2, v3)` 사용

### machcli 쿼리 결과 타입 주의사항

- 컬럼명은 대문자 그대로 반환 (`_RID`, `NAME`, `TIME`)
- TAG 파티션의 `NAME`: `typeof number` (tag ID, 숫자)
- `TIME`: Go `time.Time` 객체
  - `BigInt(row.TIME)` -> NaN (불가)
  - `row.TIME.unixNano()` -> number (정밀도 손실)
  - **TIME 값은 반드시 `?` 파라미터 바인딩으로 전달** (정밀도 유지)

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

## jsh http 모듈 API

```js
const http = require('http');
const svr = new http.Server({ network: 'tcp', address: 'host:port' });
svr.get('/path/:param', (ctx) => {
  const id = ctx.param('name');
  const body = ctx.request.body;
  ctx.json(http.status.OK, data);
});
svr.post('/path', (ctx) => { ... });
svr.put('/path/:id', (ctx) => { ... });
svr.delete('/path/:id', (ctx) => { ... });
svr.options('/path', (ctx) => { ... });
svr.serve(callback);  // 서버 시작
svr.close();          // 서버 종료
```

## Machbase TAG 테이블 내부 구조

- `_TAG_META` -- 태그 메타 정보 (`_ID` -> name 매핑)
- `_TAG_DATA_0` ~ `_TAG_DATA_N` -- 실제 데이터 파티션
- `V$STORAGE_TAG_TABLES` -- 파티션별 RID 범위 등 스토리지 정보
- `M$SYS_TABLES` / `M$SYS_COLUMNS` -- 시스템 카탈로그

RID_RANGE 힌트 예시:
```sql
SELECT /*+ RID_RANGE(_TAG_DATA_0, 0, 50000) */ _RID, name, time, value
FROM _TAG_DATA_0
WHERE _RID >= 0
LIMIT 1000
```

## 개발 규칙

- **모듈 시스템**: CommonJS (`require` / `module.exports`)
- **비동기 패턴**: `async/await` (jsh에서 지원)
- **BigInt 처리**: RID 값은 BigInt. JSON 직렬화 시 `BigInt -> string` 변환 필요
  - `typeof bigint`가 goja에서 다르게 동작 -> `_isBigInt()` 헬퍼 사용
- **에러 처리**: `QueryError` 클래스로 DB 에러 구분 (db/client.js 내 정의)
- **로깅**: `lib/logger.js`의 `Logger` 클래스 사용. `logger.trace(...)` / `logger.debug(...)` / `logger.info(...)` / `logger.warn(...)` / `logger.error(...)` 형태로 호출.
  - `trace`: 매우 상세한 값 변환 로그
  - `debug`: 반복성 내부 상태 진단 로그 (예: stmtCount 갱신, STARTUP_INTEGRITY 배치 진행)
  - `info`: 상태 전환 및 정상 동작 로그 (예: job start/stop, checkpoint_saved, STEADY 진입)
  - `warn`: 예상치 못한 상황, 계속 실행 가능 (예: alias cache miss, MAX(_RID) fallback)
  - `error`: 실패·스킵·오류
  - **로그 메시지에 유니코드 특수문자(`->`, `--`, `-`) 사용**: ASCII 대체 필수 (`->`, `-`, `--`) — 유니코드(`->`, `—`, `—`) 사용 금지
- **코드 스타일**: 기존 파일의 세미콜론 스타일을 따를 것
- **단일 연결 제약**: machcli 연결 하나로 동시 query + append 불가 -> Worker별 독립 연결 사용 (설계 결정 B-01)

## jsh 환경 제약사항

- `process`는 `require('process')` 필요 (전역 미제공)
- `__dirname` 미제공 -> `process.cwd()` 사용 (cwd = `/work`, 실제 경로 `/home/machbase/repli`)
- `AbortController` 미제공 -> job.js에 직접 구현
- `typeof bigint`가 goja에서 다르게 동작 -> `_isBigInt()` 헬퍼 사용
- `process.hrtime.bigint()` 미지원 -> `Date.now()` 사용
- `fs.createWriteStream`에서 유니코드 문자 쓰기 시 `write(str, 'utf8')` 인코딩 명시 필요
- 로그 메시지에 유니코드 특수문자(`->`, `—`, `—`) 사용 금지, ASCII 대체(`->`, `-`, `--`)
- 파일 I/O: `fs/promises` 미사용 -> `fs` 동기 API (`readFileSync`, `writeFileSync`, `renameSync` 등)
- 파일 쓰기는 반드시 절대경로 사용: `/work/logs/`, `/work/data/`

## 테스트 실행

```bash
# 단위 테스트
node --test tests/unit/*.test.js

# 통합 테스트 (실 DB 연결 필요 -- 127.0.0.1:5656)
node --test tests/integration/tag_replication.test.js
node --test tests/integration/log_replication.test.js
node --test tests/integration/table.test.js
```

현재 테스트 현황: (`node --test tests/unit/*.test.js`)
- checkpoint.test.js: CheckpointStore load/save/mismatch (6개)
- config.test.js: 설정 검증 + addJob/updateJob/removeJob/save + autoCreate + filter/transform
- integrity_checker.test.js: TagTable.findFirstMissRow (7개)
- retry.test.js: RetryHandler 백오프 로직 (15개)
- worker-state.test.js: Worker 상태 머신 + E2E mock 시나리오 + transform 적용 (22개)

## 실행 방법

```bash
# jsh로 실행 (machbase-neo 경로는 환경에 따라 다름)
../machbase-neo/machbase-neo jsh app.js
../machbase-neo/machbase-neo jsh app.js /work/config.json  # config 경로 명시
```

- jsh cwd = `/work` (심볼릭 링크 -> 실제 `/home/machbase/repli`)
- config.json의 파일 경로(logging.file.directory 등)는 절대경로 `/work/...` 사용 권장

## 알려진 한계 / TODO

1. `on_save_failure="abort"` -> checkpoint 저장 실패 시 throw 전파는 구현됨. Worker 레벨 abort 처리는 미구현.
