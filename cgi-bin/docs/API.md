# neo-pkg-replication CGI API

## 개요

- CGI 경로 기준 루트: `127.0.0.1:5654/public/neo-pkg-replication/cgi-bin`
- 이 문서의 경로는 extensionless 형식(`/api/rc/list`)을 표준으로 적는다. Machbase Neo CGI 라우팅에서는 대응하는 `.js` 경로(`/api/rc/list.js`)도 허용된다.
- 설정 파일:
  - replication: `conf.d/{name}.json`
  - server profile: `conf.d/server/{name}.json`
- service name은 API name 앞에 `"_rpl_"` 를 붙여 사용한다.
- `POST /api/rc` 는 config 저장 후 service `install` 까지 수행한다.
- `PUT /api/rc` 는 config 저장 후 service가 실행 중일 때만 `stop -> start` 한다.
- `DELETE /api/rc` 는 실행 중인 service를 먼저 `stop` 하고, service `uninstall` 후 service definition, config, pid, checkpoint/data를 정리한다.

## 공통 응답

```json
{
  "ok": true,
  "data": {}
}
```

실패 시:

```json
{
  "ok": false,
  "reason": "error message"
}
```

## Server Profile

### 저장 위치

- `conf.d/server/{name}.json`

### 필드

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `name` | string | ✓ | profile 이름 |
| `host` | string | ✓ | DB host |
| `port` | number | ✓ | DB port |
| `user` | string | 조건부 | `native`, `mqtt-publish` 에서 사용 가능 |
| `password` | string | 조건부 | `native`, `mqtt-publish` 에서 사용 가능 |
| `token` | string | 조건부 | `http`, `mqtt-api`, `mqtt-publish` 에서 사용 가능 |
| `type` | string | | `"native"` \| `"http"` \| `"mqtt-api"` \| `"mqtt-publish"` |
| `protocol` | string | 선택 | `http`에서 `"http"` 또는 `"https"` |
| `qos` | number | 선택 | `mqtt-api`, `mqtt-publish` publish QoS |
| `retain` | boolean | 선택 | `mqtt-publish` retain flag |

### 규칙

- 저장된 profile 조회/list 응답에는 `password`, `token`을 포함하지 않는다. `default` 템플릿 응답은 생성 form 초기값이므로 빈 `password`, `token` 필드를 포함한다.
- `GET` 응답에는 `targetOnly` 가 포함되며, `mqtt-api`, `mqtt-publish` 는 `true` 이다.
- MQTT `clientId` 는 runtime connection마다 내부 생성되며 profile에 저장하지 않는다.
- `PUT`에서 `password`, `token`이 없거나 `null` 또는 `""` 이면 기존 값을 유지한다.
- 다른 replication config가 참조 중인 server profile은 `DELETE` 할 수 없다.
- source로 사용할 수 있는 type은 현재 `native`, `http` 뿐이다.
- `mqtt-api`, `mqtt-publish` 는 target 전용이다.

### 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/server/list` | server profile 목록 |
| `GET` | `/api/server/default?type=...` | type별 server profile 기본 템플릿 |
| `POST` | `/api/server` | server profile 생성 |
| `GET` | `/api/server?name=...` | server profile 단건 조회 |
| `PUT` | `/api/server?name=...` | server profile 수정 |
| `DELETE` | `/api/server?name=...` | server profile 삭제 |
| `POST` | `/api/server/test` | 저장된 server 또는 미저장 profile 연결 테스트 |

### 예시

### `GET /api/server/default?type=...`

- `type` 은 필수이며 `native`, `http`, `mqtt-api`, `mqtt-publish` 중 하나여야 한다.
- 응답의 `profile` 은 `POST /api/server` 와 같은 key 구조를 가진 create 템플릿이다.
- `targetOnly` 는 저장되지 않는 파생 정보이며, 프론트엔드가 source 선택 가능 여부를 판단할 때 사용한다.

응답 예시:

```json
{
  "ok": true,
  "data": {
    "profile": {
      "name": "",
      "host": "127.0.0.1",
      "port": 5654,
      "user": null,
      "password": "",
      "token": "",
      "protocol": "http",
      "qos": null,
      "retain": null,
      "type": "http"
    },
    "targetOnly": false
  }
}
```

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  --data '{"name":"local","host":"127.0.0.1","port":5656,"user":"SYS","password":"manager","type":"native"}' \
  http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin/api/server
```

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  --data '{"name":"local_http","host":"127.0.0.1","port":5654,"type":"http","protocol":"http","token":""}' \
  http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin/api/server
```

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  --data '{"name":"local_mqtt","host":"127.0.0.1","port":5653,"type":"mqtt-api","token":"","qos":1}' \
  http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin/api/server
```

### `POST /api/server/test`

- 요청 body는 `{ "name": "saved_profile_name" }` 또는 `{ "profile": { ... } }` 둘 중 하나만 허용한다.
- 저장 전 테스트에서는 `profile.name` 이 없어도 된다.
- probe 방식은 transport 제약에 따라 달라진다.
  - `native`, `http`, `mqtt-api`: lightweight query probe
  - `mqtt-publish`: connect-only probe

저장된 server 테스트 예시:

```json
{
  "name": "local_http"
}
```

미저장 profile 테스트 예시:

```json
{
  "profile": {
    "name": "",
    "host": "127.0.0.1",
    "port": 5654,
    "user": null,
    "password": "",
    "token": "",
    "protocol": "http",
    "qos": null,
    "retain": null,
    "type": "http"
  }
}
```

응답 예시:

```json
{
  "ok": true,
  "data": {
    "mode": "profile",
    "type": "http",
    "targetOnly": false,
    "probe": "query"
  }
}
```

## ReplicatorConfig

### 상위 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `id` | string | 미지정 시 `{source.table}_{target.table}` |
| `source` | object | source endpoint + mapping + filter/transform |
| `target` | object | target endpoint + mapping |
| `startMode` | string | `"full"` \| `"now"` \| `"ridAfter"` |
| `ridAfter` | number \| null | `startMode: "ridAfter"` 에서 사용 |
| `queryLimit` | number | batch 크기 |
| `pollIntervalMs` | number | idle poll 주기 |
| `shutdownTimeoutMs` | number | shutdown timeout |
| `onSaveFailure` | string | `"continue"` \| `"abort"` |
| `retry` | object \| null | 재시도 설정 |
| `logging` | object | 로그 설정 |

### EndpointConfig

`source`, `target` 공통 필드.

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `server` | string | ✓ | `conf.d/server/{name}.json` 참조 |
| `table` | string | ✓ | 테이블명, 저장 시 대문자 정규화 |
| `topic` | string \| null | 조건부 | `mqtt-publish` target publish topic, 대소문자 유지 |
| `columns` | array | ✓ | data column mapping |
| `meta` | array | ✓ | metadata column mapping, LOG는 보통 `[]` |

참조하는 server profile의 `type` 기준 제약:

- `native`
  - source/target 모두 가능
- `http`
  - source/target 모두 가능
  - target TAG metadata는 별도 `insert metadata`, data append는 batch HTTP write
- `mqtt-api`
  - target 전용
  - CGI 메타조회(`table/list`, `table/columns`) 지원
  - runtime은 write-only target
- `mqtt-publish`
  - target 전용
  - generic MQTT sink
  - `target.topic` 이 있으면 그 값으로 publish 한다.
  - `target.topic` 이 없으면 legacy 호환을 위해 `target.table.toLowerCase()` 를 topic으로 사용한다.
  - `table/list`, `table/columns` 미지원

`target.topic` 정책:

- `mqtt-publish` target에서만 사용할 수 있다.
- 빈 문자열, `+`, `#`, null 문자, 공백 문자는 허용하지 않는다.
- `$` 로 시작할 수 없다.
- `//`, 시작 `/`, 끝 `/` 는 허용하지 않는다.
- 허용 문자는 영문자, 숫자, `.`, `_`, `-`, `/` 이다.
- UTF-8 인코딩 길이는 65535 bytes 이하여야 한다.

### Column Mapping 규칙

- `source.columns.length === target.columns.length`
- `source.meta.length === target.meta.length`
- `target.columns` 의 non-null 항목은 target 실제 data column 순서와 정확히 같아야 한다.
- `target.meta` 의 non-null 항목은 target 실제 metadata column 순서와 정확히 같아야 한다.
- trailing `null` 은 길이 맞춤용 padding 으로 허용된다.
- `source.columns` / `source.meta` 의 `null` 또는 `""` 는 해당 target slot에 `null` 값을 넣는다.
- 타입은 위치 기준으로 비교한다.
- 숫자 타입끼리는 상호 호환한다.
- TAG target key(PRIMARY) / base time(BASETIME) slot은 source mapping이 반드시 있어야 한다.

### Source Filtering / Transform

#### `source.rep_target_cond`

```json
{ "column": "NAME", "op": "IN", "value": ["A", "B"] }
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `column` | string \| null | `ALL`이 아니면 필수 |
| `op` | string | `ALL` \| `IN` \| `LIKE` |
| `value` | array | `IN`, `LIKE` 에서 사용 |

규칙:

- TAG에서는 `column` 이 PRIMARY KEY 컬럼이어야 한다.
- `ALL` 은 전체를 의미한다.
- `IN` 은 `value` 배열 중 하나와 일치.
- `LIKE` 는 `value[0]` 을 SQL `LIKE` 로 사용한다.
- TAG에서 name filter는 prefix/suffix 적용 전 원본 tag name 기준으로 평가된다.

#### `source.transform`

```json
[
  {
    "criteria": { "op": "ALL", "value": [] },
    "expr": [
      { "column": "NAME", "type": "prefix", "value": "SRC1." }
    ]
  }
]
```

`criteria` 와 `rep_target_cond` 는 같은 형식이다.

`expr.type`:

| type | 설명 |
|------|------|
| `prefix` | 문자열 앞에 추가 |
| `suffix` | 문자열 뒤에 추가 |
| `calc` | `calcOrder` 에 따라 `bm` 또는 `mb` |
| `filter` | `value < min` 또는 `value > max` 인 row 제외 |

규칙:

- `prefix` / `suffix` 는 string-like 컬럼에만 허용된다.
- `calc` / `filter` 는 numeric 컬럼에만 허용된다.
- `calcOrder`
  - `"bm"`: `(value + bias) * multiplier`
  - `"mb"`: `value * multiplier + bias`
  - 생략 시 기본값은 `"bm"`
- `filter` 는 query 단계에서 SQL WHERE로 내려간다.
- `prefix` / `suffix` / `calc` 는 read 후 메모리에서 적용된다.
- transform criteria는 원본 source row 값을 기준으로 판단하고, expr 적용은 순서대로 누적된다.

### RetryConfig

| 필드 | 타입 | 기본값 |
|------|------|--------|
| `maxAttempts` | number | `5` |
| `baseDelayMs` | number | `100` |
| `maxDelayMs` | number | `30000` |

위 기본값은 `GET /api/rc/default` 템플릿 기준이다. config에서 `retry` 자체를 생략하면 런타임 fallback은 `maxAttempts: null`(무제한), `baseDelayMs: 1000`, `maxDelayMs: 60000` 이다.

### LoggingConfig

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `level` | string | `"info"` | `trace/debug/info/warn/error` |
| `maxFiles` | number | `10` | 10MB rotation file count |

현재 구현:

- 모든 로그 파일 경로는 `/work/public/neo-pkg-replication/logs`
- 파일당 최대 크기 10MB
- service process lifecycle 로그(`start`, `stopped`)는 stdout에도 함께 출력
- `logging.level` 이 `trace` 이면 source data read에 사용하는 SQL과 바인딩 파라미터를 로그에 남긴다.

## Replication API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/rc/list` | replication 목록 (`installed`, `running`) |
| `GET` | `/api/rc/default` | replication create 기본 템플릿 |
| `POST` | `/api/rc` | replication 생성 + service install |
| `GET` | `/api/rc?name=...` | replication 단건 조회 + checkpoint + metaSync |
| `PUT` | `/api/rc?name=...` | replication 수정 |
| `DELETE` | `/api/rc?name=...` | replication 삭제 + cleanup |
| `POST` | `/api/rc/install?name=...` | 기존 config 기준 service install |
| `POST` | `/api/rc/start?name=...` | service start |
| `POST` | `/api/rc/stop?name=...` | service stop |
| `POST` | `/api/rc/dryrun` | config dry-run validation |

### `GET /api/rc/list`

응답 예시:

```json
{
  "ok": true,
  "data": [
    { "name": "repli-a", "installed": true, "running": false }
  ]
}
```

### `GET /api/rc?name=...`

- `metaSync` 는 TAG + native/http target 조합에서만 의미가 있다.
- 초기 TAG metadata 전체 동기화 또는 data-driven catch-up 이 진행 중이면 `status`, `progress`, `message` 로 상태를 확인할 수 있다.
- 실행 중 catch-up 은 source data batch에서 실제로 관찰한 최대 tag id 범위까지만 metadata를 전진시킨다.
- 설정 변화가 없는 일반 재시작은 metadata-only tag까지 다시 bootstrap하지 않으며, 이후 data batch가 더 큰 tag id를 관찰할 때만 catch-up 이 재개된다.
- 그 외 조합이거나 아직 상태 파일이 없으면 `metaSync` 는 `null` 일 수 있다.

응답 예시:

```json
{
  "ok": true,
  "data": {
    "name": "repli-a",
    "config": {},
    "checkpoints": {
      "_HOME_DATA_0": {
        "lastSuccessRid": "2799971",
        "totalRowsWritten": "2799972",
        "hasMore": false,
        "max_rid": "2799971"
      }
    },
    "metaSync": {
      "enabled": true,
      "status": "ready",
      "message": "metadata sync ready",
      "progress": 100,
      "lastMetaId": "2799971",
      "goalMetaId": "2799971",
      "repTargetCond": {
        "column": "NAME",
        "op": "LIKE",
        "value": ["SENSOR_%"]
      },
      "startedAt": "2026-04-17T06:02:47.395Z",
      "updatedAt": "2026-04-17T06:02:47.412Z"
    }
  }
}
```

### `GET /api/rc/default`

- 응답의 `config` 는 `POST /api/rc` 와 호환되는 기본 템플릿이다.
- 템플릿은 저장 형식 참고용이므로, `source.server`, `source.table`, `target.server`, `target.table` 같은 필수 값은 호출 측에서 채워야 한다.
- `guide` 는 저장 대상이 아닌 참고 정보이며, `rep_target_cond` / `transform` 의 기본 구조 예시를 포함한다.
- `mqtt-publish` target을 만들 때는 `target.topic` 을 함께 채우는 것을 권장한다.

응답 예시:

```json
{
  "ok": true,
  "data": {
    "config": {
      "id": "",
      "source": {
        "server": "",
        "table": "",
        "columns": null,
        "meta": null,
        "rep_target_cond": { "column": null, "op": "ALL", "value": [] },
        "transform": []
      },
      "target": {
        "server": "",
        "table": "",
        "topic": null,
        "columns": null,
        "meta": null
      },
      "startMode": "full",
      "ridAfter": null,
      "queryLimit": 5000,
      "pollIntervalMs": 1000,
      "shutdownTimeoutMs": 30000,
      "onSaveFailure": "continue",
      "retry": {
        "maxAttempts": 5,
        "baseDelayMs": 100,
        "maxDelayMs": 30000
      },
      "logging": {
        "level": "info",
        "maxFiles": 10
      }
    },
    "guide": {
      "requiredOnCreate": [
        "source.server",
        "source.table",
        "target.server",
        "target.table"
      ],
      "recommendedOnMqttPublish": [
        "target.topic"
      ]
    }
  }
}
```

### `POST /api/rc`

요청 예시:

```json
{
  "name": "repli-a",
  "config": {
    "id": "repli-a",
    "source": {
      "server": "local",
      "table": "HOME",
      "columns": ["NAME", "TIME", "VALUE"],
      "meta": [],
      "rep_target_cond": { "op": "ALL", "value": [] },
      "transform": null
    },
    "target": {
      "server": "local",
      "table": "HOME_COPY",
      "topic": null,
      "columns": ["NAME", "TIME", "VALUE"],
      "meta": []
    },
    "startMode": "now",
    "queryLimit": 100,
    "pollIntervalMs": 1000,
    "shutdownTimeoutMs": 30000,
    "onSaveFailure": "continue",
    "retry": {
      "maxAttempts": 5,
      "baseDelayMs": 100,
      "maxDelayMs": 30000
    },
    "logging": {
      "level": "info",
      "maxFiles": 5
    }
  }
}
```

### `PUT /api/rc?name=...`

- service가 install되지 않았거나 running이 아니면 config만 저장한다.

### `DELETE /api/rc?name=...`

- service가 실행 중이면 먼저 stop 한다.
- service uninstall 후 service definition, pid file, config file, checkpoint/data directory를 정리한다.
- 로그 파일은 삭제하지 않는다.

### `POST /api/rc/start?name=...`

- config가 없으면 실패한다.
- 이미 running 상태면 실패한다.

### `POST /api/rc/stop?name=...`

- config가 없으면 실패한다.
- service stop 후 pid file을 정리한다.

### `POST /api/rc/dryrun`

- body는 `config` 또는 `{ "config": ... }` 둘 다 허용한다.
- 실제 저장/설치 없이 DB 연결, 테이블 존재, columns/meta 길이/타입, `startMode`/`ridAfter`, 수치 설정 범위, filter/transform 구조를 검증한다.
- `mqtt-publish` target의 `target.topic` 도 같은 규칙으로 검증하며, 값이 없으면 legacy fallback warning을 반환할 수 있다.
- TAG 테이블에서는 `target.columns` 의 PRIMARY KEY 슬롯이 반드시 source PRIMARY KEY 컬럼에 매핑되는지 추가로 검증한다.
- `VARCHAR` 길이 초과 가능성은 오류가 아니라 warning으로 반환한다.
- 응답에는 정규화된 config, source/target schema 요약, `warnings` 배열이 포함된다.
- startup integrity는 user config가 아니라 내부 동작이며, TAG + native/http target 재기동 경로에서만 자동 수행된다.
- `mqtt-publish` target은 actual target schema 조회를 하지 않고, configured mapping 기준으로 payload schema를 구성한다.

## Table Columns API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/table/list` | 테이블 목록 조회 |
| `POST` | `/api/table/columns` | 테이블 컬럼 정보 조회 |
| `POST` | `/api/table/tags` | TAG 이름 목록 페이지 조회 |

표준 요청은 server profile 참조 방식이다. 이전 호환을 위해 `server` 대신 inline connection 필드(`host`, `port`, `user`, `password`, `token`, `type`, `protocol`, `qos`, `retain`)도 허용한다. `table` 값은 `TABLE_NAME` 또는 `OWNER.TABLE_NAME` 둘 다 허용한다.

지원 type:

- `native`
- `http`
- `mqtt-api`

`mqtt-publish` 는 query-capable transport가 아니므로 `table/list`, `table/columns` 대상이 아니다.

요청 예시:

```json
{
  "server": "local",
  "table": "HOME"
}
```

응답 예시:

```json
{
  "ok": true,
  "data": {
    "table": "HOME",
    "tableType": "TAG",
    "columns": [
      { "name": "NAME", "type": "VARCHAR(25)", "isPrimary": true, "isBasetime": false, "isSummarized": false, "isMetadata": false }
    ],
    "meta": [
      { "name": "EQPID", "type": "VARCHAR(20)", "isPrimary": false, "isBasetime": false, "isSummarized": false, "isMetadata": true }
    ]
  }
}
```

### `POST /api/table/list`

요청은 `table` 없이 server profile만 전달한다.

```json
{
  "server": "local"
}
```

응답 예시:

```json
{
  "ok": true,
  "data": {
    "tables": [
      { "name": "HOME", "tableType": "TAG", "owner": "SYS" },
      { "name": "LOG_TABLE", "tableType": "LOG", "owner": "SYS" }
    ]
  }
}
```

### `POST /api/table/tags`

요청:

```json
{
  "server": "local",
  "table": "TAG_REAL",
  "page": 1,
  "size": 50
}
```

- `table` 값은 `TABLE_NAME` 또는 `OWNER.TABLE_NAME` 둘 다 허용한다.
- 내부적으로 `_{table}_META` 또는 `OWNER._{table}_META` 를 조회한다.

응답 예시:

```json
{
  "ok": true,
  "data": {
    "total_tags": 4,
    "tags": ["TAG-01", "TAG-02", "TAG-03", "TAG-04"]
  }
}
```

## Log API

### 로그 경로

- `/work/public/neo-pkg-replication/logs`

### `GET /api/log/list`

- `name` query parameter를 주면 해당 문자열로 시작하는 로그 파일만 반환한다.
- 반환 순서는 최신 생성 파일이 먼저 오도록 정렬한다.

응답 예시:

```json
{
  "ok": true,
  "data": {
    "files": [
      { "name": "repli-a.log", "size": 4096 },
      { "name": "repli-a_20260415_034234.log", "size": 10485760 }
    ]
  }
}
```

### `GET /api/log/tail?name=...&intervalMs=...`

- SSE(`text/event-stream`) 기반 active 로그 tail API이다.
- `name`은 로그 파일명이 아니라 replication job name이다.
- tail 대상 파일은 내부적으로 `{name}.log` active 로그 파일로 고정된다.
- 기존 로그 내용은 전송하지 않고, 연결 이후 append되는 최신 로그 라인만 전송한다.
- 로그 파일이 아직 없으면 연결을 유지하고, 파일이 생성된 뒤부터 follow 한다.
- `intervalMs`는 polling 주기이며 기본값은 `500`이다. 허용 범위는 `250`부터 `5000`까지이다.
- event name은 `line`이고, payload는 JSON이 아닌 로그 라인 문자열이다.

프론트엔드 사용 예시:

```js
const es = new EventSource(
  `${API_BASE}/log/tail?name=${encodeURIComponent(jobId)}&intervalMs=500`
);

es.addEventListener("line", (event) => {
  appendLine(event.data);
});
```

### `GET /api/log/content?name=...&start=...&end=...`

- `name`은 로그 파일명이다. 경로 구분자를 포함할 수 없고 파일명만 허용한다.
- `start`, `end`는 1-based line number
- `start/end`를 생략하면 전체 내용을 반환한다.

응답 예시:

```json
{
  "ok": true,
  "data": {
    "name": "repli-a.log",
    "start": 1,
    "end": 3,
    "totalLines": 125438,
    "lines": ["line1", "line2", "line3"]
  }
}
```

### `GET /api/log/content/all?name=...`

- `name`은 로그 파일명이다. 경로 구분자를 포함할 수 없고 파일명만 허용한다.
- 파일 전체 내용을 문자열로 반환한다.

응답 예시:

```json
{
  "ok": true,
  "data": {
    "name": "repli-a.log",
    "content": "[INFO] 2026-04-15 ..."
  }
}
```
