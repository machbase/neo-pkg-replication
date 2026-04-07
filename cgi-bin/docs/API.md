# repli-js CGI API 명세

## 접근 방식

CGI 파일을 machbase-neo jsh로 직접 실행한다.
각 CGI 파일은 `conf.d/` 디렉토리를 직접 읽고 쓴다.
`api/rc*.js` 는 Machbase Neo JSH `service` 모듈을 통해 replication service를 등록/제어한다.

요청 본문은 `process.stdin.read()`로 읽는다 (`/dev/stdin` 미지원).

### service 연동 관련 주의

- `GET /cgi-bin/api/rc/list` 는 `conf.d/*.json` 전체가 아니라 install된 service만 반환한다.
- `POST /cgi-bin/api/rc` 는 config 저장 후 service `install` 까지 수행한다.
- `PUT /cgi-bin/api/rc` 는 config 저장 후, service가 실행 중이면 `stop -> start` 로 재적용한다. `source.password`/`target.password` 키가 없거나 빈 문자열(`""`)인 항목은 기존 값을 유지한다.
- `DELETE /cgi-bin/api/rc` 는 service `uninstall` 후 config, pid, checkpoint 파일을 함께 정리한다. 로그 파일은 유지한다.
- 직접 JSH로 service 관련 CGI를 테스트할 때는 `/etc` mount 와 `SERVICE_CONTROLLER` 환경값이 필요할 수 있다.
- `logging.file.directory` 에 `${CWD}` 를 쓰면 `cgi-bin` 의 부모 경로, 즉 패키지 루트로 치환된다.

### jsh 직접 실행 (테스트용)

```bash
# 실행 위치: machbase-neo 설치 디렉토리
# neo-pkg-replication은 public/ 하위에 위치해야 함
# 주의: -e 플래그는 반드시 스크립트 파일 앞에 위치해야 함

# GET 목록
./machbase-neo jsh -v /public=$(pwd)/public -v /etc=$(pwd)/etc -e REQUEST_METHOD=GET /public/neo-pkg-replication/cgi-bin/api/rc/list.js

# GET 단건
./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=GET -e QUERY_STRING=name=repli-a /public/neo-pkg-replication/cgi-bin/api/rc.js

# POST 등록
echo '{"name":"repli-a","config":{"id":"repli-a","source":{"host":"192.168.1.10","port":5656,"user":"SYS","password":"MANAGER","table":"TAG","columns":null,"filter":null,"transform":null},"target":{"host":"192.168.1.20","port":5656,"user":"SYS","password":"MANAGER","table":"TAG_COPY","autoCreate":true},"startMode":"now","ridAfter":null,"metaSync":false,"pollIntervalMs":1000,"queryLimit":5000,"ridRangeSize":50000,"shutdownTimeoutMs":30000,"onSaveFailure":"continue","integrity":null,"retry":null}}' | \
  ./machbase-neo jsh -v /public=$(pwd)/public -v /etc=$(pwd)/etc -e SERVICE_CONTROLLER=${SERVICE_CONTROLLER} -e REQUEST_METHOD=POST /public/neo-pkg-replication/cgi-bin/api/rc.js

# PUT 수정
echo '{"id":"repli-a","source":{"host":"192.168.1.10","port":5656,"user":"SYS","password":"MANAGER","table":"TAG","columns":null,"filter":null,"transform":null},"target":{"host":"192.168.1.20","port":5656,"user":"SYS","password":"MANAGER","table":"TAG_COPY","autoCreate":true},"startMode":"now","ridAfter":null,"metaSync":false,"pollIntervalMs":2000,"queryLimit":5000,"ridRangeSize":50000,"shutdownTimeoutMs":30000,"onSaveFailure":"continue","integrity":null,"retry":null}' | \
  ./machbase-neo jsh -v /public=$(pwd)/public -v /etc=$(pwd)/etc -e SERVICE_CONTROLLER=${SERVICE_CONTROLLER} -e REQUEST_METHOD=PUT -e QUERY_STRING=name=repli-a /public/neo-pkg-replication/cgi-bin/api/rc.js

# DELETE 삭제
./machbase-neo jsh -v /public=$(pwd)/public -v /etc=$(pwd)/etc -e SERVICE_CONTROLLER=${SERVICE_CONTROLLER} -e REQUEST_METHOD=DELETE -e QUERY_STRING=name=repli-a /public/neo-pkg-replication/cgi-bin/api/rc.js

# POST 시작
./machbase-neo jsh -v /public=$(pwd)/public -v /etc=$(pwd)/etc -e SERVICE_CONTROLLER=${SERVICE_CONTROLLER} -e REQUEST_METHOD=POST -e QUERY_STRING=name=repli-a /public/neo-pkg-replication/cgi-bin/api/rc/start.js

# POST 종료
./machbase-neo jsh -v /public=$(pwd)/public -v /etc=$(pwd)/etc -e SERVICE_CONTROLLER=${SERVICE_CONTROLLER} -e REQUEST_METHOD=POST -e QUERY_STRING=name=repli-a /public/neo-pkg-replication/cgi-bin/api/rc/stop.js

# POST 테이블 컬럼 정보 조회
echo '{"host":"127.0.0.1","port":5656,"user":"SYS","password":"MANAGER","table":"TAG"}' | \
  ./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=POST /public/neo-pkg-replication/cgi-bin/api/table/columns.js
```

### CGI 파일 목록

| CGI 파일 | 메서드 | 설명 |
|----------|--------|------|
| `api/rc/list.js` | GET | install된 replication service 목록 조회 |
| `api/rc.js` | POST, GET, PUT, DELETE | 등록(service install) / 단건 조회 / 수정(실행 중이면 재시작) / 제거(service uninstall + 관련 파일 정리) |
| `api/rc/start.js?name=xxx` | POST | service 시작 |
| `api/rc/stop.js?name=xxx` | POST | service 종료 |
| `api/table/columns.js` | POST | 테이블 컬럼 정보 조회 |

---

## 공통 응답 구조

```json
{
  "ok":     true | false,
  "reason": "<오류 메시지>",
  "data":   "<object | array>"
}
```

| 필드 | 설명 |
|------|------|
| `ok` | `true` (성공) / `false` (실패) |
| `reason` | 실패 시 오류 메시지, 성공 시 생략 |
| `data` | 성공 시 응답 데이터, 없으면 생략 |

---

## ReplicatorConfig

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| `id` | string \| null | | `"{source.table}_{target.table}"` | replicator 고유 ID. 미설정 시 자동 생성. |
| `logging` | object | | — | 로깅 설정 (LoggingConfig 참조) |
| `source` | object | ✓ | — | 소스 DB + 테이블 설정 |
| `source.host` | string | ✓ | — | 소스 DB 호스트 |
| `source.port` | number | ✓ | — | 소스 DB 포트 |
| `source.user` | string | ✓ | — | 소스 DB 사용자명 |
| `source.password` | string | ✓ | — | 소스 DB 비밀번호 |
| `source.table` | string | ✓ | — | 원본 테이블명 |
| `source.columns` | string[] \| null | | null | SELECT 컬럼 목록 (null=전체). TAG 테이블이면 NAME, TIME 필수 포함. |
| `source.filter` | object[] \| null | | null | 복제 필터 목록 (FilterRule 참조) |
| `source.transform` | object[] \| null | | null | read 후 값 변환 목록 (TransformRule 참조) |
| `target` | object | ✓ | — | 대상 DB + 테이블 설정 |
| `target.host` | string | ✓ | — | 대상 DB 호스트 |
| `target.port` | number | ✓ | — | 대상 DB 포트 |
| `target.user` | string | ✓ | — | 대상 DB 사용자명 |
| `target.password` | string | ✓ | — | 대상 DB 비밀번호 |
| `target.table` | string | ✓ | — | 대상 테이블명. `autoCreate: true`이면 빈 문자열 허용 (source.table 이름 사용). |
| `target.autoCreate` | boolean | | false | 대상 테이블 미존재 시 src 스키마로 자동 생성 |
| `startMode` | string | | `"full"` | `"full"` \| `"now"` \| `"ridAfter"` |
| `ridAfter` | number \| null | | null | `startMode: "ridAfter"` 시 기준 RID |
| `pollIntervalMs` | number | | 1000 | 폴링 주기 (ms) |
| `queryLimit` | number | | 5000 | 배치당 최대 레코드 수 |
| `ridRangeSize` | number | | 50000 | RID 범위 힌트 크기 |
| `shutdownTimeoutMs` | number | | 30000 | 종료 대기 타임아웃 (ms) |
| `onSaveFailure` | string | | `"continue"` | `"continue"` \| `"abort"` |
| `integrity` | boolean \| null | | null | `false`=비활성화, 그 외=활성화 |
| `retry` | object \| null | | null | RetryConfig 참조 |

### RetryConfig

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `maxAttempts` | number | 5 | 최대 재시도 횟수 |
| `baseDelayMs` | number | 100 | 초기 재시도 지연 (ms) |
| `maxDelayMs` | number | 30000 | 최대 재시도 지연 (ms) |

### LoggingConfig

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `level` | string | `"info"` | `"trace"` \| `"debug"` \| `"info"` \| `"warn"` \| `"error"` |
| `stdout` | boolean | true | 표준 출력 여부 |
| `file.enabled` | boolean | false | 파일 출력 여부 |
| `file.directory` | string | `"/work/logs"` | 로그 파일 디렉토리 (절대경로). `${CWD}` 사용 시 `cgi-bin` 부모 경로로 치환 |

### FilterRule

`source.filter` 배열의 각 항목. 조건을 모두 AND로 평가하며, 하나라도 불통과하면 해당 행은 복제하지 않는다.

| 필드 | 타입 | 적용 대상 | 설명 |
|------|------|-----------|------|
| `column` | string | 모두 | 필터를 적용할 컬럼명 |
| `in` | string[] | NAME, VARCHAR, TEXT | 허용할 값 목록. 목록에 없으면 해당 행 제외. |
| `like` | string | NAME, VARCHAR, TEXT | SQL LIKE 패턴 (`%`=0개 이상 임의 문자, `_`=임의 1개 문자). 대소문자 무시. |
| `min` | number | 숫자 컬럼 (SHORT/INTEGER/LONG/FLOAT/DOUBLE) | 이 값 미만이면 해당 행 제외 (inclusive: `value >= min`) |
| `max` | number | 숫자 컬럼 (SHORT/INTEGER/LONG/FLOAT/DOUBLE) | 이 값 초과이면 해당 행 제외 (inclusive: `value <= max`) |

> - 숫자 컬럼에는 `min` / `max` 만 적용된다. `in` / `like` 는 무시된다.
> - `NAME` 컬럼에는 `in` / `like` 만 적용된다. `min` / `max` 는 무시된다.

**예시**
```json
"filter": [
  { "column": "NAME", "like": "sensor_%" },
  { "column": "VALUE", "min": 0, "max": 100 },
  { "column": "STATUS", "in": ["active", "idle"] }
]
```

### TransformRule

`source.transform` 배열의 각 항목. read 후 대상 DB에 쓰기 직전에 값을 변환한다.

| 필드 | 타입 | 적용 대상 | 설명 |
|------|------|-----------|------|
| `column` | string | 모두 | 변환을 적용할 컬럼명 |
| `add` | number | 숫자 컬럼 | 더할 값. 수식: `(value + add) * multiply` |
| `multiply` | number | 숫자 컬럼 | 곱할 값. 수식: `(value + add) * multiply` |
| `prefix` | string | NAME 컬럼 | tag name 앞에 붙일 문자열 |
| `suffix` | string | NAME 컬럼 | tag name 뒤에 붙일 문자열 |

> `add` / `multiply` 는 숫자 타입 컬럼에만 적용된다. `BigInt`, `null`, 문자열은 변환하지 않는다.  
> `prefix` / `suffix` 는 TAG 테이블의 `NAME` 컬럼에만 적용된다.

**예시**
```json
"transform": [
  { "column": "VALUE", "add": 0, "multiply": 1.5 },
  { "column": "NAME", "prefix": "copy_", "suffix": "" }
]
```

---

## 엔드포인트

### GET /cgi-bin/api/rc/list

현재 install된 replicator service 목록 조회.

**응답**
```json
{
  "ok": true,
  "data": [
    {
      "name": "repli-a",
      "running": false
    }
  ]
}
```

| 필드 | 설명 |
|------|------|
| `name` | replicator 이름 |
| `running` | service 실행 중 여부 |

---

### POST /cgi-bin/api/rc

새 replicator 등록. `conf.d/{name}.json` 저장 후 service `install` 까지 수행한다.

**요청 본문**
```json
{
  "name": "repli-a",
  "config": {
    "id": "repli-a",
    "logging": {
      "level": "info",
      "stdout": true,
      "file": { "enabled": false, "directory": "/work/logs" }
    },
    "source": {
      "host": "192.168.1.10",
      "port": 5656,
      "user": "SYS",
      "password": "MANAGER",
      "table": "TAG",
      "columns": ["NAME", "TIME", "VALUE"],
      "filter": [
        { "column": "NAME", "like": "sensor_%" },
        { "column": "VALUE", "min": 0, "max": 100 }
      ],
      "transform": [
        { "column": "VALUE", "add": 0, "multiply": 1.5 },
        { "column": "NAME", "prefix": "copy_", "suffix": "" }
      ]
    },
    "target": {
      "host": "192.168.1.20",
      "port": 5656,
      "user": "SYS",
      "password": "MANAGER",
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
    "integrity": null,
    "retry": null
  }
}
```

**응답**
```json
{ "ok": true, "data": { "name": "repli-a" } }
```

**실패**
```json
{ "ok": false, "reason": "replicator 'repli-a' already exists" }
```

---

### GET /cgi-bin/api/rc?name=xxx

특정 replicator config 조회.

**응답**
```json
{
  "ok": true,
  "data": {
    "name": "repli-a",
    "config": {
      "id": "repli-a",
      "logging": {
        "level": "info",
        "stdout": true,
        "file": { "enabled": false, "directory": "/work/logs" }
      },
      "source": {
        "host": "192.168.1.10",
        "port": 5656,
        "user": "SYS",
        "table": "TAG",
        "columns": ["NAME", "TIME", "VALUE"],
        "filter": [
          { "column": "NAME", "like": "sensor_%" },
          { "column": "VALUE", "min": 0, "max": 100 }
        ],
        "transform": [
          { "column": "VALUE", "add": 0, "multiply": 1.5 },
          { "column": "NAME", "prefix": "copy_", "suffix": "" }
        ]
      },
      "target": {
        "host": "192.168.1.20",
        "port": 5656,
        "user": "SYS",
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
      "integrity": null,
      "retry": null
    },
    "checkpoints": {
      "_TAG_DATA_0": { "lastSuccessRid": "12345", "hasMore": true },
      "_TAG_DATA_1": { "lastSuccessRid": "6789", "hasMore": false }
    }
  }
}
```

| 필드 | 설명 |
|------|------|
| `name` | replicator 이름 |
| `config` | ReplicatorConfig (password 필드 제외) |
| `checkpoints` | 파티션별 checkpoint 정보. `lastSuccessRid`는 문자열, `hasMore`는 `rowsRead === queryLimit` 기준 추정값 |

**실패**
```json
{ "ok": false, "reason": "replicator 'xxx' not found" }
```

---

### PUT /cgi-bin/api/rc?name=xxx

replicator config 수정. `conf.d/{name}.json` 파일이 갱신되며, service가 실행 중이면 `stop -> start` 로 재적용된다. `source.password` 또는 `target.password` 키가 요청 본문에 없거나 빈 문자열(`""`)이면 해당 항목은 기존 비밀번호를 유지한다.

**요청 본문**
```json
{
  "id": "repli-a",
  "logging": {
    "level": "info",
    "stdout": true,
    "file": { "enabled": false, "directory": "/work/logs" }
  },
  "source": {
    "host": "192.168.1.10",
    "port": 5656,
    "user": "SYS",
    "password": "MANAGER",
    "table": "TAG",
    "columns": ["NAME", "TIME", "VALUE"],
    "filter": [
      { "column": "NAME", "like": "sensor_%" },
      { "column": "VALUE", "min": 0, "max": 100 }
    ],
    "transform": [
      { "column": "VALUE", "add": 0, "multiply": 1.5 },
      { "column": "NAME", "prefix": "copy_", "suffix": "" }
    ]
  },
  "target": {
    "host": "192.168.1.20",
    "port": 5656,
    "user": "SYS",
    "password": "MANAGER",
    "table": "TAG_COPY",
    "autoCreate": true
  },
  "startMode": "now",
  "ridAfter": null,
  "metaSync": false,
  "pollIntervalMs": 2000,
  "queryLimit": 5000,
  "ridRangeSize": 50000,
  "shutdownTimeoutMs": 30000,
  "onSaveFailure": "continue",
  "integrity": null,
  "retry": null
}
```

**응답**
```json
{ "ok": true, "data": { "name": "repli-a" } }
```

---

### DELETE /cgi-bin/api/rc?name=xxx

replicator 제거. service `uninstall` 후 `conf.d/{name}.json`, `run/{name}.pid`, 관련 checkpoint 디렉토리를 함께 삭제한다.

**응답**
```json
{ "ok": true }
```

---

### POST /cgi-bin/api/table/columns

지정한 DB에 연결하여 테이블의 컬럼 정보를 반환한다.

**요청 본문**

```json
{ "host": "127.0.0.1", "port": 5656, "user": "SYS", "password": "MANAGER", "table": "TAG" }
```

| 필드 | 필수 | 설명 |
|------|------|------|
| `host` | ✓ | DB 호스트 |
| `port` | ✓ | DB 포트 |
| `user` | ✓ | DB 사용자명 |
| `password` | ✓ | DB 비밀번호 |
| `table` | ✓ | 테이블명 |

**응답**
```json
{
  "ok": true,
  "data": {
    "table": "TAG",
    "tableType": "TAG",
    "columns": [
      { "name": "NAME",  "type": "VARCHAR(80)", "isPrimary": true,  "isBasetime": false, "isSummarized": false, "isMetadata": false },
      { "name": "TIME",  "type": "DATETIME",    "isPrimary": false, "isBasetime": true,  "isSummarized": false, "isMetadata": false },
      { "name": "VALUE", "type": "DOUBLE",      "isPrimary": false, "isBasetime": false, "isSummarized": true,  "isMetadata": false }
    ]
  }
}
```

| 필드 | 설명 |
|------|------|
| `table` | 테이블명 (대문자 정규화) |
| `tableType` | `"TAG"` \| `"LOG"` |
| `columns[].name` | 컬럼명 |
| `columns[].type` | DDL 타입 문자열 (아래 타입 목록 참고) |
| `columns[].isPrimary` | PRIMARY KEY 여부 (TAG 테이블의 NAME 컬럼) |
| `columns[].isBasetime` | BASETIME 여부 (TAG 테이블의 TIME 컬럼) |
| `columns[].isSummarized` | SUMMARIZED 여부 (TAG 테이블의 VALUE 컬럼 등) |
| `columns[].isMetadata` | TAG METADATA 컬럼 여부 (TAG 테이블의 추가 속성 컬럼) |

**`columns[].type` 값 목록**

| type 값 | 설명 | 비고 |
|---------|------|------|
| `"SHORT"` | 16비트 정수 | signed / unsigned 모두 동일하게 표기 |
| `"INTEGER"` | 32비트 정수 | signed / unsigned 모두 동일하게 표기 |
| `"LONG"` | 64비트 정수 | signed / unsigned 모두 동일하게 표기 |
| `"FLOAT"` | 32비트 부동소수점 | |
| `"DOUBLE"` | 64비트 부동소수점 | |
| `"DATETIME"` | 나노초 단위 타임스탬프 | TAG 테이블의 BASETIME 컬럼 타입 |
| `"VARCHAR(n)"` | 가변 길이 문자열 | `n`은 최대 바이트 수 (예: `VARCHAR(80)`) |
| `"TEXT"` | 대용량 텍스트 | |
| `"CLOB"` | Character Large Object | |
| `"BLOB"` | Binary Large Object | |
| `"BINARY"` | 고정 길이 바이너리 | |
| `"IPV4"` | IPv4 주소 | |
| `"IPV6"` | IPv6 주소 | |
| `"JSON"` | JSON 문자열 | |

**실패**
```json
{ "ok": false, "reason": "table 'NO_SUCH' not found" }
```

**jsh 직접 실행 (테스트)**
```bash
# 실행 위치: machbase-neo 설치 디렉토리
echo '{"host":"127.0.0.1","port":5656,"user":"SYS","password":"MANAGER","table":"TAG"}' | \
  ./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=POST /public/neo-pkg-replication/cgi-bin/api/table/columns.js
```

---

### POST /cgi-bin/api/rc/start?name=xxx

replicator service 시작.

**응답**
```json
{ "ok": true, "data": { "name": "repli-a" } }
```

---

### POST /cgi-bin/api/rc/stop?name=xxx

replicator service 종료. 성공 시 pid 파일도 정리한다.

**응답**
```json
{ "ok": true, "data": { "name": "repli-a" } }
```
