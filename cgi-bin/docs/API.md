# repli-js CGI API 명세

## 접근 방식

CGI 파일을 machbase-neo jsh로 직접 실행한다.
각 CGI 파일은 `conf.d/` 디렉토리를 직접 읽고 쓴다.

요청 본문은 `process.stdin.read()`로 읽는다 (`/dev/stdin` 미지원).

### jsh 직접 실행 (테스트용)

```bash
# 실행 위치: machbase-neo 설치 디렉토리
# neo-pkg-replication은 public/ 하위에 위치해야 함
# 주의: -e 플래그는 반드시 스크립트 파일 앞에 위치해야 함

# GET 목록
./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=GET /public/neo-pkg-replication/cgi-bin/api/rc/list.js

# GET 단건
./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=GET -e QUERY_STRING=name=repli-a /public/neo-pkg-replication/cgi-bin/api/rc.js

# POST 등록
echo '{"name":"repli-a","config":{"id":"repli-a","source":{"host":"192.168.1.10","port":5656,"user":"SYS","password":"MANAGER","table":"TAG","columns":null,"filter":null,"transform":null},"target":{"host":"192.168.1.20","port":5656,"user":"SYS","password":"MANAGER","table":"TAG_COPY","autoCreate":true},"startMode":"now","ridAfter":null,"metaSync":false,"pollIntervalMs":1000,"queryLimit":5000,"ridRangeSize":50000,"shutdownTimeoutMs":30000,"onSaveFailure":"continue","integrity":null,"retry":null}}' | \
  ./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=POST /public/neo-pkg-replication/cgi-bin/api/rc.js

# PUT 수정
echo '{"id":"repli-a","source":{"host":"192.168.1.10","port":5656,"user":"SYS","password":"MANAGER","table":"TAG","columns":null,"filter":null,"transform":null},"target":{"host":"192.168.1.20","port":5656,"user":"SYS","password":"MANAGER","table":"TAG_COPY","autoCreate":true},"startMode":"now","ridAfter":null,"metaSync":false,"pollIntervalMs":2000,"queryLimit":5000,"ridRangeSize":50000,"shutdownTimeoutMs":30000,"onSaveFailure":"continue","integrity":null,"retry":null}' | \
  ./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=PUT -e QUERY_STRING=name=repli-a /public/neo-pkg-replication/cgi-bin/api/rc.js

# DELETE 삭제
./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=DELETE -e QUERY_STRING=name=repli-a /public/neo-pkg-replication/cgi-bin/api/rc.js

# POST 시작 (현재 미구현 — 수동 실행 안내)
./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=POST -e QUERY_STRING=name=repli-a /public/neo-pkg-replication/cgi-bin/api/rc/start.js

# POST 종료 (현재 미구현 — 수동 종료 안내)
./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=POST -e QUERY_STRING=name=repli-a /public/neo-pkg-replication/cgi-bin/api/rc/stop.js

# POST 테이블 컬럼 정보 조회
echo '{"host":"127.0.0.1","port":5656,"user":"SYS","password":"MANAGER","table":"TAG"}' | \
  ./machbase-neo jsh -v /public=$(pwd)/public -e REQUEST_METHOD=POST /public/neo-pkg-replication/cgi-bin/api/table/columns.js
```

### CGI 파일 목록

| CGI 파일 | 메서드 | 설명 |
|----------|--------|------|
| `api/rc/list.js` | GET | 목록 조회 |
| `api/rc.js` | POST, GET, PUT, DELETE | 등록 / 단건 조회 / 수정 / 제거 |
| `api/rc/start.js?name=xxx` | POST | 시작 (데몬 연동 예정) |
| `api/rc/stop.js?name=xxx` | POST | 종료 (데몬 연동 예정) |
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
| `source.filter` | object[] \| null | | null | WHERE절 필터 목록 |
| `source.transform` | object[] \| null | | null | read 후 값 변환 목록 |
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
| `file.directory` | string | `"/work/logs"` | 로그 파일 디렉토리 (절대경로) |

---

## 엔드포인트

### GET /cgi-bin/api/rc/list

등록된 replicator 전체 목록 조회.

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
| `running` | PID 파일 존재 여부 (실행 중 여부) |

---

### POST /cgi-bin/api/rc

새 replicator 등록. `conf.d/{name}.json` 파일로 저장된다.

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
      "columns": null,
      "filter": null,
      "transform": null
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
        "columns": null,
        "filter": null,
        "transform": null
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
      "_TAG_DATA_0": "12345",
      "_TAG_DATA_1": "6789"
    }
  }
}
```

| 필드 | 설명 |
|------|------|
| `name` | replicator 이름 |
| `config` | ReplicatorConfig (password 필드 제외) |
| `checkpoints` | 파티션별 마지막 복제 RID. 미시작 시 `{}` |

**실패**
```json
{ "ok": false, "reason": "replicator 'xxx' not found" }
```

---

### PUT /cgi-bin/api/rc?name=xxx

replicator config 수정. `conf.d/{name}.json` 파일이 갱신된다.

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
    "columns": null,
    "filter": null,
    "transform": null
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

replicator 제거. `conf.d/{name}.json` 파일도 삭제된다.

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

replicator 시작. jsh 비동기 exec 지원 시 구현 예정.

현재는 미구현이며, 수동 실행 명령을 안내한다.

**응답**
```json
{ "ok": false, "reason": "daemon not supported yet. run manually: machbase-neo jsh cgi-bin/replication.js cgi-bin/conf.d/{name}.json" }
```

---

### POST /cgi-bin/api/rc/stop?name=xxx

replicator 종료. jsh 비동기 exec 지원 시 PID 파일 기반 SIGTERM으로 구현 예정.

현재는 미구현이며, 수동 종료 방법을 안내한다.

**응답**
```json
{ "ok": false, "reason": "daemon not supported yet. stop manually: kill $(cat cgi-bin/run/{name}.pid)" }
```
