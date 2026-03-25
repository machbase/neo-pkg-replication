# repli-js 프로젝트 문서

**프로젝트**: Machbase TAG / Log 테이블 복제 도구
**런타임**: machbase-neo jsh (goja 기반 JavaScript 런타임)
**최종 수정**: 2026-03-24 (CGI-direct 아키텍처 전환. neo-admin.js/manager.js/http_server.js 제거. CGI 파일이 conf.d 직접 접근. neo-repli.js가 단일 replicator 실행. Column.dataType() -> sqlType() 수정. 통합 테스트 jsh 환경으로 재작성.)

---

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [시스템 아키텍처](#2-시스템-아키텍처)
3. [설정 스키마](#3-설정-스키마)
4. [모듈 명세](#4-모듈-명세)
5. [핵심 동작 흐름](#5-핵심-동작-흐름)
6. [경계 조건 및 예외 시나리오](#6-경계-조건-및-예외-시나리오)
7. [에러 처리 정책](#7-에러-처리-정책)
8. [테이블 타입별 동작 비교](#8-테이블-타입별-동작-비교)
9. [확정 설계 결정 사항](#9-확정-설계-결정-사항)
10. [미결 사항 및 향후 과제](#10-미결-사항-및-향후-과제)

---

## 1. 프로젝트 개요

### 1.1 목적

원본 Database의 TAG / Log 테이블 데이터를 대상 Database 테이블로 지속 복제한다.
트랜잭션·PK가 없는 환경에서 `_rid` 기반 체크포인트를 활용하여 **at-least-once** 복제를 달성하고, 가능한 범위 내에서 정합성을 최대화한다.

### 1.2 목표 / 비목표

| 구분 | 항목 |
|------|------|
| **목표** | at-least-once 복제, 정합성 최대화 (Tag 테이블), Graceful Shutdown, 대상 테이블 자동 생성 (`autoCreate`) |
| **비목표** | Exactly-once 보장, Update/Delete 복제, 대상 테이블 스키마 마이그레이션 |

### 1.3 핵심 제약

- DB 트랜잭션 없음, PK 없음 -> 중복 발생 허용 (at-least-once)
- 복제 단위: `_rid` 기반 배치
- 설정 변경 시 프로세스 재시작 필요 (핫 리로드 미지원)
- replicator는 conf.d 파일 하나당 독립 프로세스로 실행

### 1.4 핵심 의존성

- `machcli` - jsh 내장 동기 DB 클라이언트 (machbase-neo jsh 전용)

### 1.5 용어 정의

| 용어 | 정의 |
|------|------|
| 논리 테이블 | 원본 테이블. 실제 데이터를 저장하지 않고 메타 및 데이터 테이블 구성 정보만 보유 |
| 데이터 테이블 | 실제 데이터가 저장되는 테이블. Tag 테이블의 경우 `{logical}_DATA_{index}` 형태 |
| `_rid` | 데이터 테이블별 순차적이고 unique한 일련번호 (단조 증가) |
| 체크포인트 | 데이터 테이블별 마지막 성공 복제 `_rid` (파일로 저장) |
| canonical tag_name | tag_id -> tag_name 변환 후 transform의 NAME 규칙(prefix/suffix)을 적용한 최종 tag_name |
| replicator | 하나의 conf.d/*.json 설정에 대응하는 복제 실행 단위. 독립 프로세스로 실행. |
| Worker | data_table 1개당 생성되는 독립 복제 실행 단위 |
| STARTUP_INTEGRITY | 재시작 직후 수행하는 중복 skip 및 시작 위치 보정 단계 (Tag 전용) |
| STEADY_REPLICATION | 정상 복제 루프 |
| maxRidInBatch | STEADY에서 checkpoint advance 기준이 되는 `_rid` 값 -- 배치 내 최대 RID |

---

## 2. 시스템 아키텍처

### 2.1 디렉토리 구조

```
cgi-bin/
├── neo-repli.js                  # replicator 진입점 -- conf.d/{name}.json 하나를 읽어 Replicator 실행
├── replicators.js                # CGI: GET(목록 조회) / POST(등록)
├── replicator.js                 # CGI: GET/PUT/DELETE ?name=xxx
├── replicator-start.js           # CGI: POST ?name=xxx -- 시작 (데몬 연동 예정)
├── replicator-stop.js            # CGI: POST ?name=xxx -- 종료 (데몬 연동 예정)
├── conf.d/
│   └── {name}.json               # replicator별 설정 파일 (ReplicatorConfig 형식)
├── src/
│   ├── replication/
│   │   ├── replicator.js         # Replicator -- discover -> syncMeta -> Workers 루프
│   │   └── worker.js             # Worker -- 상태 머신: RESOLVE_START -> STARTUP_INTEGRITY -> STEADY_REPLICATION
│   ├── admin/
│   │   └── cgi_util.js           # CGI 유틸 -- conf.d CRUD + parseQuery + readBody + reply
│   ├── db/
│   │   ├── client.js             # MachbaseClient -- DB 연결/쿼리 (machcli 래퍼)
│   │   ├── stream.js             # MachbaseStream -- append 스트림 래퍼
│   │   ├── table.js              # TagMetaCache, LogTable, TagTable, TagDataTable
│   │   ├── checkpoint.js         # CheckpointStore -- cp 파일 load/save
│   │   └── types.js              # ColumnType, Column, TableSchema (순수 도메인 모델)
│   └── lib/
│       ├── logger.js             # Logger -- 날짜 로테이션, stdout/file 출력
│       ├── retry.js              # RetryHandler
│       ├── json_file.js          # JsonFile -- atomic read/write
│       └── signal.js             # (미사용) 구 signal 모듈
├── data/                         # 런타임 생성 -- replicator별 파티션 cp 파일 저장 (/work/data/ 고정)
└── docs/
    ├── PROJECT.md                # 본 문서
    └── API.md                    # CGI REST API 명세
```

### 2.2 컴포넌트 구성

```
machbase-neo HTTP 서버
  └─ CGI 요청 -> replicators.js / replicator.js / replicator-start.js / replicator-stop.js
                   └─ cgi_util.js: conf.d 직접 CRUD (listConfigs / readConfig / writeConfig / deleteConfig)

사용자 (jsh 직접 실행)
  └─ neo-repli.js <conf.d/{name}.json>
       └─ Replicator
           ├─ discover() -- 소스/대상 스키마 수집, 파티션 목록 조회
           ├─ syncMeta() -- TAG 메타 동기화 (TAG 전용)
           └─ runWorkers()
               └─ Worker x N  (Promise.all -- cooperative multitasking)
                   ├─ TagDataTable/LogTable -- 소스 DB 읽기 (machcli 동기)
                   ├─ TagTable/LogTable     -- 대상 DB 쓰기 (machcli 동기)
                   └─ Worker.run()          -- 상태 머신
```

**설계 원칙**: jsh의 `svr.serve()`는 Go 레벨에서 이벤트 루프를 완전히 블로킹한다. 따라서 HTTP 서버와 replicator를 같은 프로세스에서 실행할 수 없다. CGI 파일은 직접 conf.d를 읽고 쓰고, replicator는 독립 프로세스로 실행된다.

### 2.3 Connection 관리 원칙 (설계 결정 B-01)

**확정 구조**: data_table(Worker)당 srcConn + dstConn 각 1개 생성

```
[DISCOVER]   sourceConn: 1개 -- 타입/파티션 조회 후 close

[Worker_0]   srcTable(srcConn_0) + dstTable(dstConn_0)  (append 포함)
[Worker_1]   srcTable(srcConn_1) + dstTable(dstConn_1)  (append 포함)
...
[Worker_N]   srcTable(srcConn_N) + dstTable(dstConn_N)  (append 포함)
```

- srcTable(TagDataTable/LogTable)이 srcConn을 소유, dstTable(TagTable/LogTable)이 dstConn을 소유 (close 책임도 각자)
- STARTUP_INTEGRITY에서 intConn(integrity 전용)은 배치마다 신규 생성 후 close
  - machcli 연결은 close 후 재연결 불가 -> 재사용 금지

### 2.4 Worker 동시성 모델

`Promise.all(workers.map(w => w.run(signal)))` 으로 모든 Worker를 동시에 시작.
machcli DB 쿼리는 동기(blocking)이므로 진정한 병렬 실행이 아니라 **cooperative multitasking**:

- Worker A: DB read -> DB write -> **await sleepOrShutdown** -> (B, C 실행) -> DB read -> ...
- Worker B: (A가 sleep 중일 때) DB read -> DB write -> **await sleepOrShutdown** -> ...

각 Worker는 `await` 지점(sleep)에서 이벤트 루프를 양보한다. 복제 용도로 충분히 동작한다.

### 2.5 Machbase TAG 테이블 내부 구조

| 시스템 테이블 | 역할 |
|--------------|------|
| `_TAG_META` | 태그 메타 정보 (태그 이름 -> `_ID` 매핑) |
| `_TAG_DATA_0` ~ `_TAG_DATA_N` | 실제 데이터 파티션 |
| `V$STORAGE_TAG_TABLES` | 파티션별 RID 범위 등 스토리지 정보 |
| `M$SYS_TABLES` / `M$SYS_COLUMNS` | 시스템 카탈로그 |

### 2.6 시스템 상태 머신

**Replicator 레벨**
```
neo-repli.js <config> -> Replicator.start()
  while(!shutdown):
    discover() -> syncMeta(TAG only) -> runWorkers()
      (에러 -> AbortController 전체 취소) -> 재시작
  -> process.exit(0)
```

**Worker 레벨 (data_table 1개당)**
```
RESOLVE_START -> (STARTUP_INTEGRITY, TAG+체크포인트 존재 시) -> STEADY_REPLICATION
```

---

## 3. 설정 스키마

### 3.1 ReplicatorConfig (conf.d/{name}.json)

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| `id` | string\|null | | `"{source.table}_{target.table}"` | replicator 고유 ID. 미설정 시 자동 생성. |
| `logging` | object | | - | 로깅 설정 (LoggingConfig 참조) |
| `source` | object | yes | - | 소스 DB + 테이블 설정 |
| `source.host` | string | yes | - | 소스 DB 호스트 |
| `source.port` | number | yes | - | 소스 DB 포트 |
| `source.user` | string | yes | - | 소스 DB 사용자명 |
| `source.password` | string | yes | - | 소스 DB 비밀번호 |
| `source.table` | string | yes | - | 원본 테이블명 |
| `source.columns` | string[]\|null | | null | SELECT 컬럼 목록 (null=전체). TAG 테이블이면 NAME, TIME 필수 포함. |
| `source.filter` | object[]\|null | | null | WHERE절 필터 목록 |
| `source.transform` | object[]\|null | | null | read 후 값 변환 목록 |
| `target` | object | yes | - | 대상 DB + 테이블 설정 |
| `target.host` | string | yes | - | 대상 DB 호스트 |
| `target.port` | number | yes | - | 대상 DB 포트 |
| `target.user` | string | yes | - | 대상 DB 사용자명 |
| `target.password` | string | yes | - | 대상 DB 비밀번호 |
| `target.table` | string | yes | - | 대상 테이블명. `autoCreate: true`이면 빈 문자열 허용 (source.table 이름 사용). |
| `target.autoCreate` | boolean | | false | 대상 테이블 미존재 시 src 스키마로 자동 생성 |
| `startMode` | string | | `"full"` | `"full"` \| `"now"` \| `"ridAfter"` |
| `ridAfter` | number\|null | | null | `startMode: "ridAfter"` 시 기준 RID |
| `pollIntervalMs` | number | | 1000 | 폴링 주기 (ms) |
| `queryLimit` | number | | 5000 | 배치당 최대 레코드 수 |
| `ridRangeSize` | number | | 50000 | RID 범위 힌트 크기 |
| `shutdownTimeoutMs` | number | | 30000 | 종료 대기 타임아웃 (ms) |
| `onSaveFailure` | string | | `"continue"` | `"continue"` \| `"abort"` |
| `integrity` | boolean\|null | | null | `false`=비활성화, 그 외=활성화 |
| `retry` | object\|null | | null | RetryConfig 참조 |

### 3.2 LoggingConfig

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `level` | string | `"info"` | `"trace"` \| `"debug"` \| `"info"` \| `"warn"` \| `"error"` |
| `stdout` | boolean | true | 표준 출력 여부 |
| `file.enabled` | boolean | false | 파일 출력 여부 |
| `file.directory` | string | `"/work/logs"` | 로그 파일 디렉토리 (절대경로) |

### 3.3 RetryConfig

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `maxAttempts` | number | 5 | 최대 재시도 횟수 |
| `baseDelayMs` | number | 100 | 초기 재시도 지연 (ms) |
| `maxDelayMs` | number | 30000 | 최대 재시도 지연 (ms) |

### 3.4 설정 예시

```json
{
  "id": "repli-a",
  "logging": {
    "level": "info",
    "stdout": true,
    "file": { "enabled": true, "directory": "/work/logs" }
  },
  "source": {
    "host": "192.168.1.183", "port": 5656, "user": "SYS", "password": "MANAGER",
    "table": "TAG",
    "columns": null,
    "filter": null,
    "transform": null
  },
  "target": {
    "host": "192.168.1.183", "port": 5656, "user": "SYS", "password": "MANAGER",
    "table": "TAG_COPY",
    "autoCreate": true
  },
  "startMode": "now",
  "ridAfter": null,
  "pollIntervalMs": 1000,
  "queryLimit": 5000,
  "ridRangeSize": 50000,
  "shutdownTimeoutMs": 30000,
  "onSaveFailure": "continue",
  "integrity": true,
  "retry": { "maxAttempts": 5, "baseDelayMs": 100, "maxDelayMs": 30000 }
}
```

### 3.5 체크포인트 파일 포맷

**저장 경로**: `/work/data/{replicatorId}/{dataTable}.json`

```json
{
  "lastSuccessRid": "12345678",
  "sourceHost": "192.168.1.183",
  "sourceTable": "TAG"
}
```

- `lastSuccessRid`: BigInt를 string으로 직렬화
- 경로 고정 (`/work/data/` = `/home/machbase/repli/data/`), 설정 불필요

---

## 4. 모듈 명세

### M1. neo-repli.js -- 진입점

```bash
../machbase-neo/machbase-neo jsh neo-repli.js <conf.d/{name}.json>
```

- conf.d/{name}.json을 읽어 `Replicator` 생성 및 실행
- `process.addShutdownHook`: Ctrl+C -> `replicator.shutdown()` -> `process.exit(0)`
- ROOT 경로: `path.resolve(path.dirname(process.argv[1]))` (jsh에서 `__dirname` 미제공)

### M2. CGI 파일 (replicators.js, replicator.js, replicator-start.js, replicator-stop.js)

- 모두 `cgi_util.js`의 `{ listConfigs, readConfig, writeConfig, deleteConfig, parseQuery, readBody, reply }` 사용
- `'use strict'` 없음 (jsh에서 top-level `return` 사용 시 silent 실패)
- 조건 분기는 `if/else` (top-level `return` 금지)
- API 상세는 `docs/API.md` 참조

### M3. cgi_util.js -- CGI 유틸

```js
listConfigs()              // conf.d/*.json 파일명 목록 (server.json 제외)
readConfig(name)           // conf.d/{name}.json 읽기, 없으면 null
writeConfig(name, config)  // conf.d/{name}.json atomic write (tmp -> rename)
deleteConfig(name)         // conf.d/{name}.json 삭제
parseQuery()               // process.env.get('QUERY_STRING') 파싱 -> { key: value }
readBody()                 // /dev/stdin 에서 JSON body 읽기
reply(status, data)        // CGI 응답 출력 (Status: / Content-Type: / Content-Length: + body)
```

- `CONF_DIR`: `path.join(process.cwd(), 'cgi-bin', 'conf.d')` (process.cwd() = `/work`)
- 환경변수: `process.env.get('QUERY_STRING')` (jsh에서 `process.env.KEY` 접근 불가)
- byte 길이: `unescape(encodeURIComponent(body)).length` (jsh에 Buffer 없음)

### M4. Replicator (`src/replication/replicator.js`)

```js
const replicator = new Replicator(config, shutdownFlag);
replicator.start()   // async, 메인 루프 실행
replicator.shutdown()  // shutdownFlag.value = true
```

**메인 루프**
```
while(!shutdown):
  1. discover()   -- 소스/대상 타입/스키마/파티션 조회
  2. syncMeta()   -- TAG 전용: 태그 메타 동기화 (name, metadata 컬럼)
  3. runWorkers() -- Worker x N 병렬 실행 (Promise.all)
  -> 에러 시 5초 대기 후 재시작
```

**discover() 반환값**: `{ tableType, dataTables, srcSchema, dstSchema }` 또는 `null`

- TAG 테이블: `TagTable.getDataTables()` -> 파티션별 `Worker` 생성
- LOG 테이블: 단일 데이터 테이블 -> Worker 1개 생성
- `autoCreate: true` + 대상 테이블 없음 -> 자동 CREATE 후 계속
- source.columns에 NAME/TIME 누락 (TAG) -> null 반환, job skip

**syncMeta()**: 소스의 TAG META 값을 대상에 동기화 (NAME rename, metadata 컬럼 값 일치)

### M5. Worker (`src/replication/worker.js`)

```js
new Worker(config, dataTable, srcSchema, dstSchema, shutdownFlag)
worker.run(signal)  // async
```

**상태 머신**

```
RESOLVE_START:
  - CheckpointStore.load(dataTable)
  - cp 존재 -> startRid = lastSuccessRid + 1n
  - cp 없음 -> startMode 기준 (full=0n, now=srcMaxRid+1n, ridAfter=BigInt(ridAfter))
  - TAG: srcTable.cacheTagMetaAll()

STARTUP_INTEGRITY (TAG + cp 존재 + integrity !== false):
  - startRid부터 배치 읽기
  - dstTable.findFirstMissRow() 로 대상 DB 존재 확인
  - firstMiss 발견 -> safeCpRid 저장 후 STEADY 진입
  - 모든 행 확인 완료 -> STEADY 진입

STEADY_REPLICATION:
  while(!shutdown):
    srcTable.read(startRid, batchSize, ridRangeSize, ...)
    rows 없음 -> sleepOrShutdown(pollIntervalMs) -> continue
    rows 있음 -> _applyTransform() -> dstTable.append() -> checkpointStore.save()
    startRid = maxRidInBatch + 1n
```

### M6. MachbaseClient (`src/db/client.js`)

모든 메서드 동기 (machcli 기반).

```js
client.connect()
client.close()
client.selectTableType(tableName)      // { type: "TAG"|"LOG"|"UNSUPPORTED" }
client.selectTagDataTables(table)      // [{ data_table, table_id }]
client.selectColumnsByTableName(name)
client.selectColumnsByTableId(id)
client.selectMaxRid(tableName)         // BigInt
client.selectTagMeta(table, cols, nameFilter?)  // [{ _ID, name, ...metaCols }]
client.updateTagMeta(table, oldName, sets)
client.createTagTable(tableName, schema)
client.createLogTable(tableName, schema)
```

### M7. CheckpointStore (`src/db/checkpoint.js`)

```js
checkpointStore.load(dataTable)   // { cp, exists }
checkpointStore.save(dataTable, cp, stats, opts)
```

- 파일 경로: `{directory}/{dataTable}.json`
- atomic write (`.tmp` -> `renameSync`)
- BigInt(lastSuccessRid) <-> string 변환 내장

### M8. TagMetaCache / LogTable / TagTable / TagDataTable (`src/db/table.js`)

- `TagDataTable.read(startRid, limit, rangeSize, nameRule, sourceColumns, filter)`: RID_RANGE 힌트 쿼리, filter WHERE절 적용, canonical name resolve
- `TagTable.findFirstMissRow(rows, client, dataTable)`: VOLATILE TABLE + JOIN으로 첫 miss row 탐색 (STARTUP_INTEGRITY 전용)
- `LogTable.read(startRid, limit, rangeSize, filter)`: RID_RANGE 힌트 쿼리, filter WHERE절 적용

### M9. RetryHandler (`src/lib/retry.js`)

```js
retry.sleepOrShutdown(ms, shutdownFlag)  // "timeout"|"shutdown"
retry.nextDelay(attempt)                 // ms (exponential backoff)
retry.isExhausted(attempt)               // bool
retry.shouldRetry(err)                   // bool
```

---

## 5. 핵심 동작 흐름

### 5.1 신규 replicator 등록 및 실행

```
1. CGI POST /cgi-bin/replicators  { name, config }
   -> cgi_util.writeConfig(name, config)
   -> conf.d/{name}.json 생성

2. 수동 실행:
   ../machbase-neo/machbase-neo jsh cgi-bin/neo-repli.js cgi-bin/conf.d/{name}.json
```

### 5.2 최초 실행 (startMode: "now")

```
neo-repli.js -> Replicator.start()
  discover(): TAG 타입 확인, 파티션 목록, 스키마 수집
  syncMeta(): 태그 이름/메타 동기화
  runWorkers():
    Worker (파티션별):
      RESOLVE_START: cp 없음 -> startRid = srcMaxRid + 1n
      STEADY_REPLICATION: 신규 데이터만 복제
```

### 5.3 재시작 후 정합성 복구 (STARTUP_INTEGRITY)

```
Worker:
  RESOLVE_START: cp 존재 -> startRid = lastSuccessRid + 1n
  STARTUP_INTEGRITY:
    배치 읽기 -> findFirstMissRow() -> 대상 DB 존재 확인
    firstMiss 발견 -> safeCpRid = firstMissRid - 1n 저장
    startRid = firstMissRid -> STEADY 진입
  STEADY_REPLICATION: firstMiss부터 재복제
```

### 5.4 종료 (Ctrl+C)

```
process.addShutdownHook:
  replicator.shutdown() -> shutdownFlag.value = true
  Worker들: sleepOrShutdown() -> "shutdown" 반환 -> return
  Promise.all 완료 -> replicator.start() 루프 종료
  -> process.exit(0)
```

---

## 6. 경계 조건 및 예외 시나리오

| 시나리오 | 동작 |
|----------|------|
| 대상 테이블 없음 + autoCreate=false | discover() null 반환 -> 5초 후 재시도 |
| 대상 테이블 없음 + autoCreate=true | DDL 자동 실행 후 복제 시작 |
| source.columns에 NAME/TIME 누락 (TAG) | discover() null 반환 -> 5초 후 재시도 |
| 소스 컬럼이 대상에 없음 | discover() null 반환 -> 5초 후 재시도 |
| read 실패 (DB 에러) | Worker 종료 -> AbortController -> replicator 루프 재시작 |
| append 실패 | RetryHandler 백오프 후 재시도, 한도 초과 시 Worker 종료 |
| checkpoint 저장 실패 (onSaveFailure=continue) | 오류 로그 후 계속 (메모리 기준 rid 유지) |
| RID 범위 내 데이터 없음 | sleep(pollIntervalMs) 후 재시도 |
| 빈 배치 반복 (catchUpRid 패턴) | startRid < catchUpRid 이면 sleep 없이 전진 |

---

## 7. 에러 처리 정책

| 레이어 | 정책 |
|--------|------|
| discover 실패 | 오류 로그 + 5초 후 전체 재시작 |
| syncMeta 실패 | 오류 로그 + 5초 후 전체 재시작 |
| Worker read 실패 | Worker 즉시 종료 -> AbortController |
| Worker append 실패 | RetryHandler 백오프, 한도 초과 시 종료 |
| Worker 예상치 못한 종료 | 경고 로그 + AbortController -> 전체 재시작 |
| checkpoint 저장 실패 | onSaveFailure에 따라 continue 또는 abort |

---

## 8. 테이블 타입별 동작 비교

| 항목 | TAG 테이블 | LOG 테이블 |
|------|-----------|-----------|
| 데이터 파티션 | `_TAG_DATA_0` ~ `_TAG_DATA_N` (N개 Worker) | 단일 테이블 (1개 Worker) |
| 메타 동기화 | `syncMeta()` 실행 (name, metadata 컬럼) | 없음 |
| STARTUP_INTEGRITY | 실행 (cp 존재 + integrity != false) | 없음 |
| read() | RID_RANGE 힌트 + tag_id -> canonical name 변환 | RID_RANGE 힌트 |
| append() | TagTable (논리 테이블에 append) | LogTable |
| NAME/TIME 필수 여부 | source.columns 지정 시 필수 | 해당 없음 |

---

## 9. 확정 설계 결정 사항

| ID | 결정 | 이유 |
|----|------|------|
| A-01 | CGI 파일이 conf.d 직접 접근 | jsh `svr.serve()`가 Go 레벨에서 이벤트 루프 블로킹 -> HTTP 서버와 Worker 동시 실행 불가 |
| A-02 | replicator는 독립 프로세스 | config별 격리, 장애 격리, 단순한 생명주기 |
| A-03 | `process.addShutdownHook` 으로 종료 처리 | jsh에서 `setTimeout` 기반 signal 처리는 비동기 동작 후 실행되지 않음 |
| A-04 | start/stop CGI는 503 반환 | jsh `child_process` 미지원, 비동기 exec API 없음. 지원 시 `process.exec()` + PID 파일로 구현 예정 |
| B-01 | Worker별 독립 machcli 연결 | 단일 연결에서 동시 query + append 시 충돌 오류 |
| B-02 | VOLATILE TABLE + JOIN으로 miss row 탐색 | TAG 테이블 JOIN 드라이빙 불가, PK 없음 |
| B-03 | TIME 값은 `?` 파라미터 바인딩으로 전달 | BigInt 리터럴 SQL 삽입 시 정밀도 손실 |
| B-04 | catchUpRid 패턴 | ridRangeSize 단위 빈 배치마다 sleep 발생 시 catch-up 지연 방지 |
| B-05 | `c.sqlType()` 사용 (구 `c.dataType()` 제거) | Column 클래스에 dataType() 미존재. sqlType()이 동일 역할 수행 |
| C-01 | 로그 메시지 ASCII만 사용 | jsh fs.write 유니코드 특수문자 출력 문제 |

---

## 10. 미결 사항 및 향후 과제

1. **replicator-start/stop CGI**: 현재 503 반환 (수동 실행 안내). 데몬 연동 구현 예정.
2. **onSaveFailure="abort"**: checkpoint 저장 실패 시 abort 동작 미구현 (continue와 동일).

---

## 부록: jsh 실행 참조

### jsh 환경 제약

- `process`: `require('process')` 필요 (전역 미제공)
- `__dirname`: 미제공 -> `path.resolve(path.dirname(process.argv[1]))` 사용
- `process.env.KEY`: 접근 불가 -> `process.env.get('KEY')` 사용 (`-e KEY=VALUE` 플래그로 전달)
- `AbortController`: 미제공 -> replicator.js에 직접 구현
- `Buffer`: 미제공 -> byte 길이는 `unescape(encodeURIComponent(str)).length` 사용
- `fs/promises`: 미지원 -> `fs` 동기 API만 사용
- `svr.serve()`: Go 레벨 블로킹 -> 이후 setTimeout/Promise microtask/signal 모두 중단

### CGI 테스트 (jsh 직접 실행)

```bash
# 실행 위치: /home/machbase/repli

# GET 목록
../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=GET cgi-bin/replicators.js

# GET 단건
../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=GET -e QUERY_STRING=name=repli-a cgi-bin/replicator.js

# POST 등록
echo '{"name":"repli-b","config":{...}}' | \
  ../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=POST cgi-bin/replicators.js

# PUT 수정
echo '{...config...}' | \
  ../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=PUT -e QUERY_STRING=name=repli-a cgi-bin/replicator.js

# DELETE 삭제
../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=DELETE -e QUERY_STRING=name=repli-a cgi-bin/replicator.js
```

### replicator 실행

```bash
# 실행 위치: /home/machbase/repli
../machbase-neo/machbase-neo jsh cgi-bin/neo-repli.js cgi-bin/conf.d/repli-a.json
```
