# repli-js

Machbase TAG / LOG 테이블 간 데이터 복제(replication) 도구.

소스 DB에서 `_RID` 기반으로 데이터를 읽어 대상 DB에 Append Stream으로 기록한다. 체크포인트 파일로 재시작 지점을 관리하여 **at-least-once** 복제를 보장한다.

- **런타임**: Node.js v22 (CommonJS)
- **핵심 의존성**: `@machbase/ts-client@0.9.3` (CMI 프로토콜 기반 Machbase 네이티브 클라이언트)

---

## 요구사항

- Node.js v22 이상
- Machbase Neo (소스 / 대상)

---

## 설치

```bash
npm install
```

---

## 실행

```bash
# 기본 (./config.json 사용)
node app.js

# 설정 파일 경로 직접 지정
node app.js /path/to/config.json
```

종료는 `SIGTERM` 또는 `SIGINT`(Ctrl+C)로 graceful shutdown된다. 현재 처리 중인 배치를 완료한 뒤 체크포인트를 저장하고 종료한다.

---

## 설정 (config.json)

### 최상위 구조

```json
{
  "version": 3,
  "servers": [...],
  "logging": {...},
  "api": {...},
  "replication": { "jobs": [...] }
}
```

`version`은 반드시 `3`이어야 한다.

### servers

DB 접속 정보 배열. `name` 필드로 job에서 서버를 참조한다.

```json
"servers": [
  { "name": "src", "host": "192.168.1.10", "port": 5656, "user": "SYS", "password": "MANAGER" },
  { "name": "dst", "host": "192.168.1.20", "port": 5656, "user": "SYS", "password": "MANAGER" }
]
```

### logging

| 필드 | 기본값 | 설명 |
|------|--------|------|
| level | `"info"` | 로그 레벨: `trace`, `debug`, `info`, `warn`, `error` |
| stdout | `true` | 표준 출력 여부 |
| file.enabled | `false` | 파일 출력 여부 |
| file.directory | `"./logs"` | 로그 파일 디렉토리 |

### api

```json
"api": { "enabled": true, "port": 8080, "cors": { "origin": "*" } }
```

`enabled: true`이면 REST API 서버가 활성화된다.

### replication.jobs

각 job은 소스 테이블 → 대상 테이블 간 복제 단위를 정의한다.

**job 레벨**

| 필드 | 기본값 | 설명 |
|------|--------|------|
| `id` | — | 고유 식별자 |
| `autoStart` | `true` | 프로세스 시작 시 자동 실행 여부. `false`이면 API로 수동 시작 |
| `shutdownTimeoutMs` | `30000` | graceful shutdown 최대 대기 시간 (ms) |
| `startMode` | `"full"` | 체크포인트 없을 때 시작 기준: `"full"`(RID 0), `"now"`(현재 이후), `"ridAfter"`(지정 RID) |
| `ridAfter` | — | `startMode="ridAfter"` 시 시작 RID 값 (필수) |
| `queryLimit` | `5000` | 1회 읽기 최대 행 수 |
| `ridRangeSize` | `50000` | RID 범위 힌트 크기 |
| `pollIntervalMs` | `1000` | 빈 배치 후 대기 시간 (ms) |
| `onSaveFailure` | `"continue"` | checkpoint 저장 실패 정책: `"continue"` 또는 `"abort"` |
| `integrity.enabled` | `true` | TAG 테이블 재시작 시 중복 검사(STARTUP_INTEGRITY) 수행 여부 |
| `retry.maxAttempts` | — | 최대 재시도 횟수 |
| `retry.baseDelayMs` | — | 재시도 초기 대기 시간 (ms, 지수 백오프) |
| `retry.maxDelayMs` | — | 재시도 최대 대기 시간 (ms) |

**source 레벨**

| 필드 | 기본값 | 설명 |
|------|--------|------|
| `source.server` | — | servers 배열의 name 참조 |
| `source.table` | — | 원본 논리 테이블명 |
| `source.columns` | `null` | 복제할 컬럼 목록. `null`이면 전체 데이터 컬럼 |
| `source.tagIdentifier.mode` | `"none"` | TAG 이름 변환: `"none"`, `"prefix"`, `"suffix"` |
| `source.tagIdentifier.value` | — | prefix/suffix 문자열 |

**target 레벨**

| 필드 | 기본값 | 설명 |
|------|--------|------|
| `target.server` | — | servers 배열의 name 참조 |
| `target.table` | — | 대상 테이블명. `autoCreate=true`이면 빈 문자열 허용 (소스 테이블명 사용) |
| `target.autoCreate` | `false` | 대상 테이블 없을 때 소스 스키마 기반 자동 CREATE 여부 |

### 예시

```json
{
  "version": 3,
  "servers": [
    { "name": "src", "host": "192.168.1.10", "port": 5656, "user": "SYS", "password": "MANAGER" },
    { "name": "dst", "host": "192.168.1.20", "port": 5656, "user": "SYS", "password": "MANAGER" }
  ],
  "logging": {
    "level": "info",
    "stdout": true,
    "file": { "enabled": false, "directory": "./logs" }
  },
  "api": { "enabled": true, "port": 8080, "cors": { "origin": "*" } },
  "replication": {
    "jobs": [
      {
        "id": "job-1",
        "autoStart": true,
        "source": {
          "server": "src",
          "table": "TAG",
          "columns": null,
          "tagIdentifier": { "mode": "none" }
        },
        "target": { "server": "dst", "table": "TAG_COPY", "autoCreate": false },
        "startMode": "full",
        "pollIntervalMs": 1000,
        "queryLimit": 5000,
        "ridRangeSize": 50000,
        "onSaveFailure": "continue",
        "integrity": { "enabled": true },
        "retry": { "maxAttempts": 5, "baseDelayMs": 100, "maxDelayMs": 30000 }
      }
    ]
  }
}
```

---

## 동작 원리

```
소스 DB                           대상 DB
_TAG_DATA_0  ──┐
_TAG_DATA_1  ──┤  Worker (병렬)  ──▶  Append Stream
_TAG_DATA_2  ──┤
_TAG_DATA_3  ──┘
```

각 데이터 파티션(`_TAG_DATA_N`)마다 독립 Worker가 실행된다. Worker는 독립된 소스/대상 DB 연결을 보유한다.

**Worker 상태 전이:**

1. **RESOLVE_START** — 체크포인트 파일을 읽어 시작 RID를 결정한다. 파일 없거나 손상된 경우 `startMode` 기준으로 폴백한다.
2. **STARTUP_INTEGRITY** — TAG 테이블 재시작 시(`integrity.enabled=true`), 이미 대상 DB에 기록된 행을 확인해 안전한 재개 지점을 산출한다. LOG 테이블은 수행하지 않는다.
3. **STEADY_REPLICATION** — `read → append → checkpoint 저장 → sleep` 루프를 반복한다.

체크포인트 파일은 `data/{jobId}_{dataTable}.json`에 저장된다.

---

## REST API

`api.enabled=true`이면 HTTP REST API 서버가 활성화된다. `autoStart=false`인 job은 API를 통해 수동으로 시작/중지할 수 있다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/jobs` | 전체 job 목록 조회 |
| POST | `/api/jobs` | 새 job 등록 |
| GET | `/api/jobs/:id` | 특정 job 조회 |
| PUT | `/api/jobs/:id` | job 설정 업데이트 (stopped 상태만 가능) |
| DELETE | `/api/jobs/:id` | job 삭제 (stopped 상태만 가능) |
| POST | `/api/jobs/:id/start` | job 시작 |
| POST | `/api/jobs/:id/stop` | job 중지 |
| GET | `/api/servers` | 서버 목록 조회 |
| POST | `/api/servers` | 서버 추가 |
| GET | `/api/servers/:name` | 특정 서버 조회 |
| PUT | `/api/servers/:name` | 서버 설정 업데이트 |
| DELETE | `/api/servers/:name` | 서버 삭제 |
| GET | `/api/servers/:name/health` | 서버 연결 상태 확인 |
| GET | `/api/servers/:name/tables` | 서버의 테이블 목록 조회 |
| GET | `/api/servers/:name/tables/:table/schema` | 테이블 스키마 조회 |

자세한 API 명세는 [docs/API.md](docs/API.md) 참고.

---

## 테스트

```bash
# 단위 테스트 (165개, DB 연결 불필요)
node --test tests/unit/*.test.js

# 통합 테스트 (실 DB 연결 필요 — 127.0.0.1:5656)
node --test tests/integration/tag_replication.test.js
node --test tests/integration/log_replication.test.js
node --test tests/integration/table.test.js
```

---

## 디렉토리 구조

```
repli-js/
├── app.js                    # 진입점
├── config.json               # 실행 설정
├── src/
│   ├── replicator.js         # Replicator (SIGTERM/SIGINT, autoStart, JobScheduler 관리)
│   ├── job.js                # JobScheduler, Job (복제 루프, _syncTagMeta)
│   ├── api/
│   │   └── http_server.js    # REST API (Jobs, Servers)
│   ├── config/
│   │   └── config.js         # Config 클래스 및 도메인 클래스 전체
│   ├── db/
│   │   ├── client.js         # MachbaseClient
│   │   ├── stream.js         # MachbaseStream, _toCell
│   │   ├── table.js          # LogTable, TagTable, TagDataTable, TagAliasCache
│   │   ├── checkpoint.js     # CheckpointStore (atomic write, BigInt 지원)
│   │   └── types.js          # ColumnType, Column, TableSchema (순수 도메인 모델)
│   ├── worker/
│   │   └── worker.js         # Worker 상태 머신 (RESOLVE_START → STARTUP_INTEGRITY → STEADY_REPLICATION)
│   └── lib/
│       ├── logger.js         # Logger (날짜 로테이션, stdout/file)
│       └── retry.js          # RetryHandler 유틸리티
├── data/                     # 런타임 생성 — cp 파일 저장 위치 (고정 경로)
├── docs/
│   ├── PROJECT.md            # 상세 설계 문서 (아키텍처, UML, 결정 이력)
│   ├── API.md                # REST API 명세
│   └── TEST_RESULTS.md       # 테스트 결과 보고서
└── tests/
    ├── unit/                 # 단위 테스트 (165개)
    └── integration/          # 통합 테스트 (실 DB 필요)
```
