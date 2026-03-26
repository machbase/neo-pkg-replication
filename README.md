# repli-js

Machbase TAG / LOG 테이블 간 데이터 복제(replication) 도구.

소스 DB에서 `_RID` 기반으로 데이터를 읽어 대상 DB에 Append Stream으로 기록한다. 체크포인트 파일로 재시작 지점을 관리하여 **at-least-once** 복제를 보장한다.

- **런타임**: machbase-neo jsh (goja 기반 JavaScript 런타임)
- **핵심 의존성**: `machcli` (jsh 내장 동기 Machbase 클라이언트)

---

## 요구사항

- machbase-neo (jsh 런타임 포함)
- jq (neo-regress 테스트 실행 시 필요)

---

## 디렉토리 구조

```
repli/
├── cgi-bin/
│   ├── bin/
│   │   └── replication.js        # replicator 진입점 (PID 파일 관리)
│   ├── api/
│   │   ├── rc.js                 # CGI: POST(등록) / GET/PUT/DELETE ?name=xxx
│   │   └── rc/
│   │       ├── list.js           # CGI: GET 목록 조회
│   │       ├── start.js          # CGI: POST ?name=xxx -- 시작 (데몬 연동 예정)
│   │       └── stop.js           # CGI: POST ?name=xxx -- 종료 (데몬 연동 예정)
│   ├── conf.d/
│   │   └── {name}.json           # replicator별 설정 파일
│   ├── src/
│   │   ├── replication/
│   │   │   ├── replicator.js     # Replicator 클래스
│   │   │   └── worker.js         # Worker 상태 머신
│   │   ├── cgi/
│   │   │   └── cgi_util.js       # CGI 유틸 (conf.d CRUD, reply)
│   │   ├── db/
│   │   │   ├── client.js         # MachbaseClient
│   │   │   ├── stream.js         # MachbaseStream
│   │   │   ├── table.js          # TagTable, TagDataTable, LogTable
│   │   │   ├── checkpoint.js     # CheckpointStore
│   │   │   └── types.js          # ColumnType, Column, TableSchema
│   │   └── lib/
│   │       ├── logger.js
│   │       ├── retry.js
│   │       └── json_file.js
│   ├── tests/                    # jsh 통합 테스트
│   └── docs/
│       ├── PROJECT.md            # 상세 설계 문서
│       └── API.md                # CGI REST API 명세
```

---

## 실행

```bash
# 실행 위치: /home/machbase/repli

# replicator 실행 (conf.d/{name}.json 하나를 읽어 실행)
../machbase-neo/machbase-neo jsh cgi-bin/bin/replication.js cgi-bin/conf.d/repli-a.json
```

종료는 `Ctrl+C` (`process.addShutdownHook` 기반 graceful shutdown). 현재 처리 중인 배치를 완료한 뒤 체크포인트를 저장하고 종료한다.

---

## 설정 (conf.d/{name}.json)

replicator 하나당 파일 하나. CGI를 통해 등록/수정/삭제한다.

```json
{
  "id": "repli-a",
  "logging": {
    "level": "info",
    "stdout": true,
    "file": { "enabled": true, "directory": "/work/logs" }
  },
  "source": {
    "host": "192.168.1.10", "port": 5656, "user": "SYS", "password": "MANAGER",
    "table": "TAG",
    "columns": null,
    "filter": null,
    "transform": null
  },
  "target": {
    "host": "192.168.1.20", "port": 5656, "user": "SYS", "password": "MANAGER",
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

**주요 필드**

| 필드 | 기본값 | 설명 |
|------|--------|------|
| `id` | 자동 생성 | 미설정 시 `{source.table}_{target.table}` |
| `startMode` | `"full"` | `"full"` (RID 0부터) \| `"now"` (현재 이후) \| `"ridAfter"` |
| `integrity` | `null` | TAG 재시작 시 정합성 검사. `false`=비활성화 |
| `target.autoCreate` | `false` | 대상 테이블 없을 때 src 스키마로 자동 CREATE |
| `source.columns` | `null` | 복제할 컬럼 목록. TAG 테이블은 NAME/TIME 필수 포함 |
| `logging.file.directory` | `/work/logs` | 절대경로 사용 필수 |

---

## 동작 원리

```
소스 DB                              대상 DB
_TAG_DATA_0  ──┐
_TAG_DATA_1  ──┤  Worker (cooperative)  ──▶  Append Stream
_TAG_DATA_2  ──┤
_TAG_DATA_3  ──┘
```

각 데이터 파티션(`_TAG_DATA_N`)마다 독립 Worker가 실행된다 (`Promise.all`). Worker는 독립된 소스/대상 DB 연결을 보유한다.

**Worker 상태 전이:**

1. **RESOLVE_START** — 체크포인트를 읽어 시작 RID 결정.
2. **STARTUP_INTEGRITY** — TAG 테이블 재시작 시, 대상 DB 기록 확인 후 안전한 재개 지점 산출.
3. **STEADY_REPLICATION** — `read → append → checkpoint → sleep` 루프 반복.

체크포인트 파일: `data/{id}/{dataTable}.json`

---

## CGI API

machbase-neo 웹 서버를 통해 replicator 설정을 관리한다. CGI 파일은 `conf.d/`를 직접 읽고 쓴다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/cgi-bin/api/rc/list` | 전체 목록 조회 (실행 상태 + 체크포인트 포함) |
| POST | `/cgi-bin/api/rc` | 새 replicator 등록 |
| GET | `/cgi-bin/api/rc?name=xxx` | 단건 조회 |
| PUT | `/cgi-bin/api/rc?name=xxx` | 설정 수정 |
| DELETE | `/cgi-bin/api/rc?name=xxx` | 삭제 |
| POST | `/cgi-bin/api/rc/start?name=xxx` | 시작 (데몬 연동 예정) |
| POST | `/cgi-bin/api/rc/stop?name=xxx` | 종료 (데몬 연동 예정) |

자세한 명세는 [cgi-bin/docs/API.md](cgi-bin/docs/API.md) 참고.

---

## 테스트

### jsh 통합 테스트

실 DB 연결이 필요한 jsh 통합 테스트. 테스트 DB: `192.168.1.183:5656`

```bash
# 실행 위치: /home/machbase/repli

../machbase-neo/machbase-neo jsh cgi-bin/tests/client.test.js
../machbase-neo/machbase-neo jsh cgi-bin/tests/table.test.js
../machbase-neo/machbase-neo jsh cgi-bin/tests/replication.test.js

# 전체 일괄 실행
../machbase-neo/machbase-neo jsh cgi-bin/tests/run_all.js
```

### neo-regress 통합 테스트

NTF(Neo Test Framework) 기반 종단간 테스트. **커밋 전 반드시 수행해야 하며, diff가 없을 때만 커밋 가능하다.**

```bash
# 실행 위치: /home/machbase/neo-regress
# 전제: machbase-neo 서버가 repli 디렉토리를 WebDir(--ui)로 실행 중이어야 함

ntf testsuite/package/replication/replication.ts
```

테스트 구성은 `~/neo-regress/testsuite/package/replication/README` 참고.

---
