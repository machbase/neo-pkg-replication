# neo-pkg-replication 프로젝트 메모

## 현재 기준 요약

- runtime: Machbase Neo JSH
- service 실행 entrypoint: `cgi-bin/replication.js`
- replication config: `cgi-bin/conf.d/{name}.json`
- server profile: `cgi-bin/conf.d/server/{name}.json`
- checkpoint/state: `cgi-bin/data/{replicatorId}/{dataTable}.json`
- 실제 Machbase service name: `"_rpl_" + name`
- 로그 파일 경로: `/work/public/logs/neo-pkg-replication`

## 현재 CGI API

- `api/server.js`
  - `POST` create
  - `GET ?name=...` get
  - `PUT ?name=...` update
  - `DELETE ?name=...` delete
- `api/server/list.js`
  - `GET` list
- `api/rc.js`
  - `POST` create + service install
  - `GET ?name=...` get config + checkpoints
  - `PUT ?name=...` update config
  - `DELETE ?name=...` delete + cleanup
- `api/rc/install.js`
  - `POST ?name=...` install only
- `api/rc/start.js`
  - `POST ?name=...` start
- `api/rc/stop.js`
  - `POST ?name=...` stop
- `api/rc/dryrun.js`
  - `POST` validate only
- `api/table/columns.js`
  - `POST` table schema lookup

## Server Profile 규칙

- 저장 위치: `conf.d/server/{name}.json`
- 필드:
  - 공통: `name`, `host`, `port`, `type`
  - `native`: `user`, `password`
  - `http`: `protocol`, `token`
  - `mqtt-api`: `clientId`, `token`, `qos`
  - `mqtt-publish`: `clientId`, `token`, `qos`, `retain`, 필요시 `user`, `password`
- `type` 지원:
  - `native`
  - `http`
  - `mqtt-api`
  - `mqtt-publish`
- `GET` 응답에서는 `password`, `token` 제외
- `PUT`에서 `password`, `token`이 없거나 `null` 또는 `""` 이면 기존값 유지
- 다른 replication config가 참조 중이면 `DELETE` 거부
- source로 사용할 수 있는 type은 `native`, `http` 뿐이다
- `mqtt-api`, `mqtt-publish` 는 target 전용이다

## ReplicatorConfig 핵심 규칙

### 접속정보

- `source.server`, `target.server` 로 server profile을 참조하는 것이 기본
- legacy inline 접속정보(`host`, `port`, `user`, `password`)도 여전히 해석된다

### 컬럼/메타 매핑

- `source.columns.length === target.columns.length`
- `source.meta.length === target.meta.length`
- `target.columns` non-null 순서는 target 실제 data column 순서와 같아야 한다
- `target.meta` non-null 순서는 target 실제 metadata column 순서와 같아야 한다
- trailing `null` 은 padding으로만 허용한다
- source 쪽 `null` 또는 `""` slot은 target에 `null` 로 채운다
- 숫자 타입끼리는 상호 호환으로 본다
- TAG target key(PRIMARY)와 base time(BASETIME) slot은 source mapping이 반드시 있어야 한다

### filtering / transform

- top-level source filter: `source.rep_target_cond`
- row transform: `source.transform[]`
- `criteria` 는 `ALL`, `IN`, `LIKE`
- `expr.type` 은 `prefix`, `suffix`, `calc`, `filter`
- `calc` 수식: `(value + bias) * multiplier`
- `expr.type == filter` 는 메모리 단계가 아니라 SQL WHERE 단계로 내려간다
- transform criteria는 원본 source row 기준으로 평가하고, expr 적용은 순서대로 누적한다
- legacy 구형 `source.filter`, 구형 `source.transform`, `surfix`, `multplier`, `add` 입력은 save/validate 시 새 모델로 정규화한다

## TAG 관련 현재 동작

- TAG primary/base time 컬럼명은 물리적으로 달라도 flag 기준으로 해석한다
- source TAG data read 시 파티션 테이블의 primary 값(tag id)을 source meta cache로 원본 tag name으로 복원한다
- TAG `rep_target_cond` / transform criteria가 primary 컬럼일 때 SQL은 `_TAG_META` subquery로 name 조건을 푼다
- target type별 metadata 동작:
  - `native`: 신규 target tag name을 만나면 append 전에 `INSERT INTO <table> METADATA VALUES (...)` 로 metadata를 먼저 등록한다
  - `http`: `native`와 동일하게 metadata를 먼저 insert한다. append payload는 현재 Machbase HTTP API 제약 때문에 metadata 컬럼 자리를 포함하지만 값은 `null`로 채운다
  - `mqtt-api`: metadata를 별도 insert하지 않고 data write payload에 meta 컬럼을 함께 포함한다
  - `mqtt-publish`: metadata를 별도 insert하지 않고 publish payload columns/rows에 meta 컬럼을 함께 포함한다
- target에 이미 있는 tag name은 메모리 cache로 건너뛴다
- integrity check는 재기동 시 source batch를 읽고 target의 `PRIMARY + BASETIME` 존재 여부를 row-by-row로 확인한다
- `mqtt-api`, `mqtt-publish` target은 integrity를 지원하지 않는다

## runtime 배치 루프

현재 worker는 아래 순서로 동작한다.

1. checkpoint 로드 후 `startRid` 결정
2. TAG면 source meta cache 로드
3. 필요 시 startup integrity 수행
4. steady loop:
   - `maxRid` 조회
   - `startRid > maxRid` 이면 checkpoint `hasMore=false` 저장 후 sleep
   - 아니면 `endRid = min(startRid + queryLimit - 1, maxRid)`
   - `RID_RANGE(startRid, endRid)` + WHERE(`rep_target_cond` + filter expr) + `ORDER BY _RID`
   - 메모리에서 `prefix/suffix/calc` 적용
   - source/target mapping 기준으로 append payload 구성
   - 신규 TAG metadata insert
   - append
   - checkpoint `lastSuccessRid = endRid`, `totalRowsWritten += 성공 append row 수`

## checkpoint 규칙

- 파일: `data/{replicatorId}/{dataTable}.json`
- `lastSuccessRid` 는 문자열로 저장되며 load 시 `BigInt` 로 복원
- `totalRowsWritten` 는 파티션별 누적 전송 성공 row 수이며 문자열로 저장 후 load 시 `BigInt` 로 복원
- `hasMore` 는 runtime이 직접 override 한다
  - `true`: 현재 batch 이후 읽을 RID 구간이 남음
  - `false`: 현재 시점 maxRid까지 따라잡음
- startup integrity로 재시작 지점을 앞당길 때도 target에서 존재가 확인된 row 수만큼 `totalRowsWritten` 을 함께 올린다

## logging 규칙

- 파일 경로 고정: `/work/public/logs/neo-pkg-replication`
- 파일당 최대 10MB
- `maxFiles` 개수만큼 rotation
- config에서 실제 사용하는 logging 필드는 `level`, `maxFiles`
- `stdout:true` 로 기록한 로그만 파일 + stdout 동시 출력
- 현재 service lifecycle 로그(`app`, `replicator start/stopped`)는 stdout으로도 출력한다
- `logging.level=trace` 이면 source data read SQL과 바인딩 파라미터를 `table_read_query` 로그로 남긴다

## 파일별 역할

- `src/cgi/config.js`
  - config/server profile 정규화
  - legacy filter/transform -> 새 모델 변환
  - server 참조 resolve
- `src/cgi/validation.js`
  - server profile 검증
  - replication config 검증
  - source/target columns/meta 길이/순서/타입 체크
- `src/cgi/handler.js`
  - CGI business logic
  - config/server CRUD
  - service install/start/stop/uninstall
  - checkpoint 취합
- `src/replication/rules.js`
  - criteria 평가
  - transform 적용
  - SQL WHERE 조각 생성
- `src/replication/replicator.js`
  - discover
  - worker orchestration
- `src/replication/worker.js`
  - steady replication
  - startup integrity
  - metadata insert
- `src/db/table.js`
  - source read SQL
  - appender wrapper
  - target existence check
- `src/db/client.js`
  - machcli wrapper
  - metadata select/insert helpers
- `src/db/remote.js`
  - HTTP API query/write helper
  - MQTT API query helper
  - MQTT API write-only target helper
  - generic MQTT publish helper

## 배포 테스트 메모

- 배포 테스트 경로: `/home/thlee/machbase-neo/public/neo-pkg-replication`
- 접근 URL: `http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin/...`
- 배포 동기화 시 runtime state 보존을 위해 보통 아래는 제외한다
  - `cgi-bin/conf.d/`
  - `cgi-bin/data/`
  - `cgi-bin/run/`
  - `logs/`

## 최근 작업 체크포인트

- `55b52cf` Add server profiles and dry-run validation
- `738297e` Rewrite replication runtime for mapped queries
