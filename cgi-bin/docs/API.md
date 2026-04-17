# neo-pkg-replication CGI API

## 개요

- CGI 경로 기준 루트: `127.0.0.1:5654/public/neo-pkg-replication/cgi-bin`
- 설정 파일:
  - replication: `conf.d/{name}.json`
  - server profile: `conf.d/server/{name}.json`
- service name은 API name 앞에 `"_rpl_"` 를 붙여 사용한다.
- `POST /api/rc` 는 config 저장 후 service `install` 까지 수행한다.
- `PUT /api/rc` 는 config 저장 후 service가 실행 중일 때만 `stop -> start` 한다.
- `DELETE /api/rc` 는 service `uninstall` 후 config, pid, checkpoint/data를 정리한다.

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
| `clientId` | string | 선택 | `mqtt-api`, `mqtt-publish` client id |
| `qos` | number | 선택 | `mqtt-api`, `mqtt-publish` publish QoS |
| `retain` | boolean | 선택 | `mqtt-publish` retain flag |

### 규칙

- `GET` 응답에는 `password`, `token`을 포함하지 않는다.
- `GET` 응답에는 `targetOnly` 가 포함되며, `mqtt-api`, `mqtt-publish` 는 `true` 이다.
- `PUT`에서 `password`, `token`이 없거나 `null` 또는 `""` 이면 기존 값을 유지한다.
- 다른 replication config가 참조 중인 server profile은 `DELETE` 할 수 없다.
- source로 사용할 수 있는 type은 현재 `native`, `http` 뿐이다.
- `mqtt-api`, `mqtt-publish` 는 target 전용이다.

### 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/server/list.js` | server profile 목록 |
| `POST` | `/api/server.js` | server profile 생성 |
| `GET` | `/api/server.js?name=...` | server profile 단건 조회 |
| `PUT` | `/api/server.js?name=...` | server profile 수정 |
| `DELETE` | `/api/server.js?name=...` | server profile 삭제 |
| `GET` | `/api/log/list` | 로그 파일 목록 조회 |
| `GET` | `/api/log/content?name=...` | 로그 파일 라인 범위 조회 |
| `GET` | `/api/log/content/all?name=...` | 로그 파일 전체 내용 조회 |

### 예시

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  --data '{"name":"local","host":"127.0.0.1","port":5656,"user":"SYS","password":"manager","type":"native"}' \
  http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin/api/server.js
```

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  --data '{"name":"local_http","host":"127.0.0.1","port":5654,"type":"http","protocol":"http","token":""}' \
  http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin/api/server.js
```

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  --data '{"name":"local_mqtt","host":"127.0.0.1","port":5653,"type":"mqtt-api","clientId":"rpl-mqtt-api","token":"","qos":1}' \
  http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin/api/server.js
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
| `integrity` | boolean \| null | TAG 재기동 integrity check 사용 여부 |
| `retry` | object \| null | 재시도 설정 |
| `logging` | object | 로그 설정 |

### EndpointConfig

`source`, `target` 공통 필드.

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `server` | string | 권장 | `conf.d/server/{name}.json` 참조 |
| `host` | string | legacy | inline 접속정보. `server`가 없을 때만 사용 |
| `port` | number | legacy | inline 접속정보 |
| `user` | string | legacy | inline 접속정보 |
| `password` | string | legacy | inline 접속정보 |
| `token` | string | legacy | inline token |
| `type` | string | legacy | `"native"` \| `"http"` \| `"mqtt-api"` \| `"mqtt-publish"` |
| `protocol` | string | legacy | inline HTTP protocol |
| `clientId` | string | legacy | inline MQTT client id |
| `qos` | number | legacy | inline MQTT QoS |
| `retain` | boolean | legacy | inline MQTT retain |
| `table` | string | ✓ | 테이블명, 저장 시 대문자 정규화 |
| `columns` | array | ✓ | data column mapping |
| `meta` | array | ✓ | metadata column mapping, LOG는 보통 `[]` |

type별 제약:

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
  - `table/list`, `table/columns` 미지원

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
- legacy `surfix`, `multplier`, `add`, 기존 `filter`/구형 `transform` 형식도 입력 시 새 형식으로 정규화한다.

### RetryConfig

| 필드 | 타입 | 기본값 |
|------|------|--------|
| `maxAttempts` | number | `5` |
| `baseDelayMs` | number | `100` |
| `maxDelayMs` | number | `30000` |

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
| `GET` | `/api/rc/list.js` | replication 목록 (`installed`, `running`) |
| `POST` | `/api/rc.js` | replication 생성 + service install |
| `GET` | `/api/rc.js?name=...` | replication 단건 조회 + checkpoint |
| `PUT` | `/api/rc.js?name=...` | replication 수정 |
| `DELETE` | `/api/rc.js?name=...` | replication 삭제 + cleanup |
| `POST` | `/api/rc/install.js?name=...` | 기존 config 기준 service install |
| `POST` | `/api/rc/start.js?name=...` | service start |
| `POST` | `/api/rc/stop.js?name=...` | service stop |
| `POST` | `/api/rc/dryrun.js` | config dry-run validation |

### `GET /api/rc/list.js`

응답 예시:

```json
{
  "ok": true,
  "data": [
    { "name": "repli-a", "installed": true, "running": false }
  ]
}
```

### `GET /api/rc.js?name=...`

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
    }
  }
}
```

### `POST /api/rc.js`

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
      "columns": ["NAME", "TIME", "VALUE"],
      "meta": []
    },
    "startMode": "now",
    "queryLimit": 100,
    "pollIntervalMs": 1000,
    "shutdownTimeoutMs": 30000,
    "onSaveFailure": "continue",
    "integrity": true,
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

### `PUT /api/rc.js?name=...`

- inline 접속정보를 사용하는 legacy config에서는 `source.password` / `target.password` 가 없거나 `null` 또는 `""` 이면 기존 값을 유지한다.
- service가 install되지 않았거나 running이 아니면 config만 저장한다.

### `POST /api/rc/dryrun.js`

- body는 `config` 또는 `{ "config": ... }` 둘 다 허용한다.
- 실제 저장/설치 없이 DB 연결, 테이블 존재, columns/meta 길이/타입, `startMode`/`ridAfter`, 수치 설정 범위, filter/transform 구조를 검증한다.
- TAG 테이블에서는 `target.columns` 의 PRIMARY KEY 슬롯이 반드시 source PRIMARY KEY 컬럼에 매핑되는지 추가로 검증한다.
- `VARCHAR` 길이 초과 가능성은 오류가 아니라 warning으로 반환한다.
- 응답에는 정규화된 config, source/target schema 요약, `warnings` 배열이 포함된다.
- `mqtt-api`, `mqtt-publish` target은 `integrity=false` 로 강제 정규화되며 warning이 추가된다.
- `mqtt-publish` target은 actual target schema 조회를 하지 않고, configured mapping 기준으로 payload schema를 구성한다.

## Table Columns API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/table/list.js` | 테이블 목록 조회 |
| `POST` | `/api/table/columns.js` | 테이블 컬럼 정보 조회 |
| `POST` | `/api/table/tags.js` | TAG 이름 목록 페이지 조회 |

요청은 아래 두 방식 중 하나를 사용한다. `table` 값은 `TABLE_NAME` 또는 `OWNER.TABLE_NAME` 둘 다 허용한다.

지원 type:

- `native`
- `http`
- `mqtt-api`

`mqtt-publish` 는 query-capable transport가 아니므로 `table/list`, `table/columns` 대상이 아니다.

1. server profile 참조

```json
{
  "server": "local",
  "table": "HOME"
}
```

2. inline 접속정보

```json
{
  "host": "127.0.0.1",
  "port": 5656,
  "user": "SYS",
  "password": "manager",
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

### `POST /api/table/list.js`

요청은 `table` 없이 접속정보만 전달한다.

1. server profile 참조

```json
{
  "server": "local"
}
```

### `POST /api/table/tags.js`

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
      { "name": "collector-a.log", "size": 4096 },
      { "name": "collector-a_20260415_034234.log", "size": 10485760 }
    ]
  }
}
```

### `GET /api/log/content?name=...&start=...&end=...`

- `name`은 로그 파일명
- `start`, `end`는 1-based line number
- `start/end`를 생략하면 전체 내용을 반환한다.

응답 예시:

```json
{
  "ok": true,
  "data": {
    "name": "repli.log",
    "start": 1,
    "end": 3,
    "totalLines": 125438,
    "lines": ["line1", "line2", "line3"]
  }
}
```

### `GET /api/log/content/all?name=...`

- `name`은 로그 파일명
- 파일 전체 내용을 문자열로 반환한다.

응답 예시:

```json
{
  "ok": true,
  "data": {
    "name": "collector-a.log",
    "content": "[INFO] 2026-04-15 ..."
  }
}
```

2. inline 접속정보

```json
{
  "host": "127.0.0.1",
  "port": 5656,
  "user": "SYS",
  "password": "manager"
}
```

응답 예시:

```json
{
  "ok": true,
  "data": {
    "tables": [
      { "name": "HOME", "tableType": "TAG", "owner": "SYS" },
      { "name": "HOME_LOG", "tableType": "LOG", "owner": "SYS" }
    ]
  }
}
```
