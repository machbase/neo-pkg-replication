# repli-js 작업지시서

## 프로젝트 개요

Machbase TAG/LOG 테이블 간 데이터 복제(replication) 도구.
소스 DB에서 RID 기반으로 데이터를 읽어 대상 DB에 Append Stream으로 기록한다.

- **런타임**: machbase-neo jsh (goja 기반)
- **핵심 의존성**: `machcli` (jsh 내장 동기 DB 클라이언트)

## 디렉토리 구조

```
cgi-bin/
├── replication.js                # replicator 진입점 -- conf.d/{name}.json 하나를 읽어 Replicator 실행, PID 파일 관리
├── api/
│   ├── rc.js                     # CGI: POST(등록) / GET/PUT/DELETE ?name=xxx
│   ├── rc/
│   │   ├── list.js               # CGI: GET 목록 조회 (install된 service만 반환)
│   │   ├── start.js              # CGI: POST ?name=xxx -- service 시작
│   │   └── stop.js               # CGI: POST ?name=xxx -- service 종료
│   └── table/
│       └── columns.js            # CGI: POST 테이블 컬럼 정보 조회
├── conf.d/
│   └── {name}.json               # replicator별 설정 파일 (ReplicatorConfig 형식)
├── data/                         # 런타임 생성 -- replicator별 파티션 cp 파일 저장
├── run/                          # 런타임 생성 -- PID 파일 저장
├── src/
│   ├── replication/
│   │   ├── replicator.js         # Replicator -- discover -> syncMeta -> Workers 루프
│   │   └── worker.js             # Worker -- 상태 머신: RESOLVE_START -> STARTUP_INTEGRITY -> STEADY_REPLICATION
│   ├── cgi/
│   │   └── cgi_util.js           # CGI 유틸 (CGI class) -- conf.d CRUD + service install/start/stop/uninstall + checkpoint 조회/정리
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
│       └── signal.js             # SIGTERM/SIGINT 핸들러 (registerSignals)
├── tests/
│   ├── test.js                   # jsh 테스트 프레임워크 (suite/test/assert/run)
│   ├── fixtures.js               # 테스트 DB 접속 정보
│   ├── client.test.js            # MachbaseClient 통합 테스트 (7개)
│   ├── table.test.js             # TagTable/TagDataTable 통합 테스트 (13개)
│   ├── replication.test.js       # Replicator 통합 테스트 (6개)
│   └── run_all.js                # 전체 테스트 일괄 실행
└── docs/
    ├── PROJECT.md                # 상세 설계 문서
    ├── API.md                    # CGI REST API 명세
    └── JSH_REFERENCE.md          # jsh 런타임 API 참조
```

## 핵심 모듈 상세

### replication.js — 진입점

```bash
../machbase-neo/machbase-neo jsh cgi-bin/replication.js cgi-bin/conf.d/{name}.json
```

- conf.d/{name}.json 읽기 -> `initLogger(config.logging)` -> `new Replicator(config, shutdownFlag).start()`
- `process.addShutdownHook`: Ctrl+C -> PID 파일 삭제 -> `replicator.shutdown()` -> `process.exit(0)`
- PID 파일: `{ROOT}/run/{configName}.pid` (ROOT = `path.resolve(path.dirname(process.argv[1]))` = cgi-bin/)
- ROOT: `path.resolve(path.dirname(process.argv[1]))` (`__dirname` 미제공)
- `logging.file.directory` 의 `${CWD}` 는 `cgi-bin` 부모 경로, 즉 package root로 치환한다.

### src/replication/replicator.js — Replicator

- `new Replicator(config, shutdownFlag)`
- `start()` async -- 메인 루프:
  1. `discover()` -- 소스/대상 타입/스키마/파티션 조회. null 반환 시 5초 후 재시도.
  2. `syncMeta(srcSchema)` -- TAG 전용, `metaSync !== false`일 때만 실행: 태그 이름/메타 동기화. null 반환 시 5초 후 재시도.
  3. `runWorkers(discovered)` -- Worker x N `Promise.all` 실행. AbortController로 전체 취소 연동.
- `shutdown()` -- `shutdownFlag.value = true`
- AbortController/AbortSignal: jsh 미제공으로 파일 내 직접 구현

### src/replication/worker.js — Worker

`Worker(config, dataTable, srcSchema, dstSchema, shutdownFlag)` -- `run(signal)` async

1. **RESOLVE_START**: CheckpointStore.load() -> startRid 결정
   - cp 존재 -> `lastSuccessRid + 1n`
   - cp 없음 -> startMode 기준 (`full`=0n, `now`=srcMaxRid+1n, `ridAfter`=BigInt)
   - TAG: `srcTable.cacheTagMetaAll()`
2. **STARTUP_INTEGRITY** (TAG + cp 존재 + `integrity !== false`):
   - 배치 읽기 -> `dstTable.findFirstMissRow()` -> firstMiss 발견 시 safeCpRid 저장 후 STEADY 진입
3. **STEADY_REPLICATION**:
   - `srcTable.read()` -> `_applyTransform()` -> `dstTable.append()` -> `checkpointStore.save()`
   - rows 없음 + `rangeMaxRid > 0n` (필터 전량 차단) -> checkpoint 진행 후 sleep 없이 continue
   - rows 없음 + `rangeMaxRid == 0n` -> `sleepOrShutdown(pollIntervalMs)`
   - 체크포인트 경로: `cgi-bin/data/{config.id}/{dataTable}.json`

### src/cgi/cgi_util.js — CGI 유틸 (CGI class)

```js
CGI.listConfigs()              // conf.d/*.json 목록 (server.json 제외)
CGI.readConfig(name)           // conf.d/{name}.json, 없으면 null
CGI.writeConfig(name, config)  // atomic write (tmp -> rename)
CGI.deleteConfig(name)
CGI.deletePid(name)
CGI.parseQuery()               // process.env.get('QUERY_STRING') 파싱
CGI.readBody()                 // process.stdin.read() 로 JSON 파싱
CGI.reply(data)                // CGI 응답 (Content-Type: application/json + body)
CGI.installService(name, cb)   // service install
CGI.getServiceStatus(name, cb) // service status
CGI.startService(name, cb)     // service start
CGI.stopService(name, cb)      // service stop
CGI.uninstallService(name, cb) // service uninstall
CGI.stopServiceIfRunning(name, cb)
CGI.restartServiceIfRunning(name, cb)
CGI.hasInstalledService(name)  // install된 service 정의 파일 존재 여부
CGI.readCheckpoints(name, config)   // checkpoint 파일 취합 -> { [dataTable]: { lastSuccessRid, hasMore } }
CGI.deleteCheckpoints(name, config) // 관련 checkpoint 디렉토리 정리
```

- ROOT 경로: `_argv.slice(0, _argv.lastIndexOf('/cgi-bin/') + '/cgi-bin'.length)`
- `CONF_DIR`: `path.join(ROOT, 'conf.d')`
- `RUN_DIR`: `path.join(ROOT, 'run')`
- `DATA_DIR`: `path.join(ROOT, 'data')`
- service 등록 시 executable은 `cgi-bin/replication.js` 자체를 사용한다.
- 실제 Machbase Neo service name은 API name 앞에 `"_rpl_"` prefix를 붙여 사용한다.
- service args에는 `cgi-bin/conf.d/{name}.json` 의 절대경로를 넣는다.
- service working dir은 `cgi-bin` 부모인 package root다.
- 환경변수: `process.env.get('KEY')` (jsh에서 `process.env.KEY` 불가)

## service lifecycle 구현 메모

- 등록은 `POST /api/rc` 에서 처리한다.
  - config 저장
  - source/target 데이터 컬럼을 순서 기준으로 타입 검증
  - service install
- 수정은 `PUT /api/rc?name=...` 에서 처리한다.
  - config 저장
  - `source.password`/`target.password`는 각각 키가 누락되었거나 빈 문자열(`""`)인 경우 기존 값 유지
  - source/target 데이터 컬럼을 순서 기준으로 타입 검증
  - service가 `RUNNING` 상태일 때만 `stop -> start`
- 시작/종료는 `POST /api/rc/start`, `POST /api/rc/stop`
  - JSH `service` 모듈 사용
- 삭제는 `DELETE /api/rc?name=...`
  - service가 실행 중이면 stop
  - service uninstall
  - service가 이미 없어도 service 정의 파일, config, pid, checkpoint 정리는 계속 시도
  - 로그 파일은 유지
- 목록은 `GET /api/rc/list`
  - `conf.d` 전체가 아니라 install된 service만 반환
- 직접 JSH로 service-aware CGI를 검증할 때는 `/public`, `/etc` mount 와 `SERVICE_CONTROLLER`가 필요할 수 있다.

### src/db/client.js — MachbaseClient

모든 메서드 동기 (machcli 기반).

```js
client.connect() / client.close()
client.selectTableType(table)            // { type: 'TAG'|'LOG'|'UNSUPPORTED' }
client.selectTagDataTables(table)        // [{ data_table }]
client.selectAllTables()                 // [{ NAME, TYPE }] TAG/LOG 테이블 목록
client.selectColumnsByTableName(name)
client.selectMaxRid(table)               // BigInt
client.selectTagNames(table)             // [{ _ID, name }]
client.selectTagMetaById(table, id, cols)
client.selectTagMeta(table, cols, nameFilter?)
client.updateTagMeta(table, oldName, sets)
client.createTagTable(table, schema)     // autoCreate
client.createLogTable(table, schema)     // autoCreate
client.openAppender(table, columns)      // Appender
client.execute(sql, ...values)
```

### src/db/table.js — TagMetaCache / TagTable / TagDataTable / LogTable

```js
// TagTable
table.open() / table.close()
table.getSchema()                          // TableSchema (META + DATA 컬럼 조합)
table.setSchema(schema)
table.getDataTables()                      // [{ data_table, table_id }]
table.loadTagMetaCache(nameFilter?)        // TagMetaCache
table.append(rows)                         // Error|null
table.findFirstMissRow(resolved, client, suffix)  // { firstMissIdx, err } -- STARTUP_INTEGRITY 전용

// TagDataTable
dataTable.open() / dataTable.close()
dataTable.setSchema(schema)
dataTable.cacheTagMetaAll()                // Error|null (내부 aliasCache 구성)
dataTable.read(startRid, limit, rangeSize, nameRule, sourceColumns, filter)
  // { rows, rangeMaxRid, err }
  //   rows: 복제 대상 행 목록
  //   rangeMaxRid: 쿼리 RID 범위 내 실제 최대 RID (필터로 전량 차단된 경우에도 > 0n)
dataTable.getMaxRid()                      // BigInt

// LogTable
logTable.open() / logTable.close()
logTable.getSchema()
logTable.read(startRid, limit, rangeSize, filter)  // { rows, rangeMaxRid, err }
logTable.append(rows)
logTable.getMaxRid()
```

### src/db/types.js — ColumnType / Column / TableSchema

```js
ColumnType.fromCode(code)   // M$SYS_COLUMNS.TYPE 코드 -> 인스턴스
col.sqlType()               // DDL 타입 문자열 (예: 'VARCHAR(80)', 'DOUBLE')
FLAG_PRIMARY, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA  // M$SYS_COLUMNS.FLAG 비트 상수
```

### src/db/checkpoint.js — CheckpointStore

```js
new CheckpointStore(directory, dataTable)  // directory = cgi-bin/data/{replicatorId}, dataTable 생성자에서 수신
store.load()                               // { cp, exists, err } -- dataTable 인자 불필요
store.save(cp, stats, opts)
```

**저장 파일 형식** (`cgi-bin/data/{id}/{dataTable}.json`):
```json
{
  "version": 1,
  "source": { "server": "192.168.1.183", "table": "TAG", "dataTable": "_TAG_DATA_0" },
  "checkpoint": { "lastSuccessRid": "12345678", "updatedAt": "2026-03-31T...", "hasMore": false }
}
```

- `lastSuccessRid`: BigInt <-> string 변환 내장
- `hasMore`: `rowsRead === queryLimit` 기준으로 다음 작업이 남아있을 가능성 표시
- atomic write (`.tmp` -> `renameSync`), `fs.mkdirSync({ recursive: true })` 내장
- `source.dataTable` 불일치 시 손상으로 처리

### src/lib/retry.js — RetryHandler

```js
new RetryHandler({ maxAttempts, baseDelayMs, maxDelayMs })
retry.sleepOrShutdown(ms, shutdownFlag)  // 'timeout'|'shutdown'
retry.nextDelay(attempt)                 // ms (exponential backoff)
retry.isExhausted(attempt)              // bool
retry.shouldRetry(err)                  // bool
```

### src/lib/signal.js — registerSignals

```js
registerSignals(shutdownFlag, timeoutMs)
// SIGTERM / SIGINT 수신 -> shutdownFlag.value = true -> timeout 초과 시 process.exit(1)
```

## conf.d/{name}.json 형식 (ReplicatorConfig)

```json
{
  "id": "repli-a",
  "logging": {
    "level": "info",
    "stdout": true,
    "file": { "enabled": true, "directory": "/work/logs" }
  },
  "source": {
    "host": "...", "port": 5656, "user": "SYS", "password": "MANAGER",
    "table": "TAG",
    "columns": null,
    "filter": null,
    "transform": null
  },
  "target": {
    "host": "...", "port": 5656, "user": "SYS", "password": "MANAGER",
    "table": "TAG_COPY",
    "autoCreate": true
  },
  "startMode": "now",
  "ridAfter": null,
  "metaSync": false,
  "pollIntervalMs": 1000,
  "queryLimit": 5000,
  "ridRangeSize": 50000,
  "shutdownTimeoutMs": 30000,
  "onSaveFailure": "continue",
  "integrity": true,
  "retry": { "maxAttempts": 5, "baseDelayMs": 100, "maxDelayMs": 30000 }
}
```

**필드 설명**
- `id`: 미설정 시 `"{source.table}_{target.table}"` 자동 생성
- `startMode`: `"full"` (RID 0부터) | `"now"` (현재 최대 RID+1) | `"ridAfter"` (ridAfter 값 이후)
- `metaSync`: `false`(기본값)=비활성화, 그 외=TAG META 동기화 활성화 (syncMeta 실행)
- `integrity`: TAG 테이블 재시작 시 STARTUP_INTEGRITY 실행 여부. `false`=비활성화, 그 외=활성화
- `target.autoCreate`: `true`이면 대상 테이블 없을 때 src 스키마로 자동 CREATE
- `target.table`: `""` + `autoCreate: true` -> source.table 이름 사용
- `source.columns`: `null`=전체, 배열 지정 시 target 데이터 컬럼 순서에 맞춰야 하며 TAG는 key(PRIMARY)/base time(BASETIME) 컬럼 필수 포함
- `logging.file.directory`: 절대경로 `/work/logs` 사용 권장

## 테스트 실행

### jsh 통합 테스트

```bash
# 실행 위치: /home/machbase/repli

# 개별 실행
../machbase-neo/machbase-neo jsh cgi-bin/tests/client.test.js
../machbase-neo/machbase-neo jsh cgi-bin/tests/table.test.js
../machbase-neo/machbase-neo jsh cgi-bin/tests/replication.test.js

# 전체 실행
../machbase-neo/machbase-neo jsh cgi-bin/tests/run_all.js
```

테스트 현황 (실 DB 연결 필요: 192.168.1.183:5656):
- client.test.js: MachbaseClient 7개
- table.test.js: TagTable/TagDataTable/filter 13개
- replication.test.js: Replicator discover/replication/syncMeta 6개

### neo-regress 통합 테스트 (커밋 조건)

**커밋 전 반드시 neo-regress 테스트를 수행해야 하며, diff가 없을 때만 커밋 가능하다.**

```bash
# 실행 위치: /home/machbase/neo-regress
# 전제: machbase-neo 서버가 repli 디렉토리를 WebDir(--ui)로 실행 중이어야 함
# 전제: jq 설치 필요

ntf testsuite/package/replication/replication.ts
```

테스트 파일: `~/neo-regress/testsuite/package/replication/`

## 실행 방법

```bash
# replicator 실행
../machbase-neo/machbase-neo jsh cgi-bin/replication.js cgi-bin/conf.d/repli-a.json

# CGI 테스트 (-e 플래그는 스크립트 파일 앞에 위치)
../machbase-neo/machbase-neo jsh -v /etc=$(pwd)/etc -e REQUEST_METHOD=GET cgi-bin/api/rc/list.js
../machbase-neo/machbase-neo jsh -e REQUEST_METHOD=GET -e QUERY_STRING=name=repli-a cgi-bin/api/rc.js
../machbase-neo/machbase-neo jsh -v /etc=$(pwd)/etc -e SERVICE_CONTROLLER=${SERVICE_CONTROLLER} -e REQUEST_METHOD=POST -e QUERY_STRING=name=repli-a cgi-bin/api/rc/start.js
```

## jsh 환경 제약사항

- `process`: `require('process')` 필요 (전역 미제공)
- `__dirname`: 미제공 -> `path.resolve(path.dirname(process.argv[1]))` 사용
- `process.env.KEY`: 불가 -> `process.env.get('KEY')` 사용
- `-e KEY=VALUE` 플래그는 스크립트 파일 **앞**에 위치해야 함
- `AbortController`: 미제공 -> replicator.js에 직접 구현
- `Buffer`: 미제공 -> byte 길이는 `unescape(encodeURIComponent(str)).length`
- `child_process`: 미지원 -> 백그라운드 프로세스 실행 불가
- `fs/promises`: 미지원 -> `fs` 동기 API만 사용
- `svr.serve()`: Go 레벨 블로킹 -> 이후 setTimeout/Promise microtask 모두 중단
- BigInt: `typeof bigint`가 goja에서 다르게 동작 -> `_isBigInt()` 헬퍼 사용
- 로그 메시지 유니코드 특수문자 (`->`, `—`) 금지, ASCII 대체 (`->`, `--`)
- 파일 쓰기는 절대경로 사용: `/work/logs/`, `/work/data/`

## machcli API 참조

jsh 내장 동기 DB 클라이언트.

```js
const machcli = require('machcli');
const conn = new machcli.Client({ host, port, user, password }).connect();

// 쿼리
const rows = conn.query(sql, ...params);  // for...of 후 rows.close() 필요
conn.exec(sql, ...params);               // DDL/DML

// Append
const appender = conn.append(tableName);
appender.append(v1, v2, ...);
appender.flush();
appender.close();

conn.close();
```

**주의사항**
- TAG 파티션의 key(PRIMARY) 컬럼: `typeof number` (tag ID), 물리 컬럼명은 테이블마다 다를 수 있음
- TAG 파티션의 base time(BASETIME) 컬럼: Go `time.Time` 객체, 물리 컬럼명은 테이블마다 다를 수 있음. `BigInt(row.TIME)` 불가, `?` 파라미터 바인딩으로만 전달
- VOLATILE TABLE: append 미지원 -> `exec('INSERT INTO ... VALUES (?,?,?)', ...)` 사용
- 단일 연결에서 동시 query + append 불가 -> Worker별 독립 연결 사용

## 확정 설계 결정 사항

| ID | 결정 | 이유 |
|----|------|------|
| A-01 | CGI가 conf.d 직접 접근 | jsh `svr.serve()` Go 레벨 블로킹으로 HTTP 서버 + Worker 동시 실행 불가 |
| A-02 | replicator는 독립 프로세스 | config별 격리, 장애 격리, 단순한 생명주기 |
| A-03 | `process.addShutdownHook`으로 종료 처리 | setTimeout 기반 signal은 비동기 이후 실행 안 됨 |
| A-04 | start/stop/register/delete는 JSH `service` 모듈로 제어 | 수동 프로세스 실행 대신 Machbase Neo service lifecycle에 맞춤 |
| B-01 | Worker별 독립 machcli 연결 | 단일 연결 동시 query + append 충돌 |
| B-02 | VOLATILE TABLE + JOIN으로 miss row 탐색 | TAG 테이블 JOIN 드라이빙 불가, PK 없음 |
| B-03 | TIME 값은 `?` 파라미터 바인딩 전달 | BigInt 리터럴 SQL 삽입 시 정밀도 손실 |
| B-04 | `c.sqlType()` 사용 | Column에 dataType() 미존재, sqlType()이 동일 역할 |
| B-05 | 필터 전량 차단 시 sleep 없이 checkpoint 진행 | ridRangeSize 단위 빈 배치마다 sleep 발생 시 catch-up 지연 방지 |
| B-06 | CheckpointStore 생성자에 dataTable 포함 | load/save 호출 시 인자 누락 방지, 파일 내 source.dataTable 검증 가능 |
