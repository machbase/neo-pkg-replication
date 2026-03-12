# repli-js

Machbase TAG/LOG 테이블 간 데이터를 RID 기반으로 복제하는 Node.js 도구.

소스 DB의 데이터 파티션을 RID 순서로 읽어 대상 DB에 Append Stream으로 기록하며, 체크포인트 파일로 재시작 지점을 관리한다.

## 요구사항

- Node.js v22 이상
- Machbase Neo (소스/대상)

## 설치

```bash
npm install
```

## 설정

`config.json`에 서버 접속 정보와 복제 job을 정의한다.

```json
{
  "version": 3,
  "servers": {
    "src": { "host": "192.168.1.10", "port": 5656, "user": "SYS", "password": "MANAGER" },
    "dst": { "host": "192.168.1.20", "port": 5656, "user": "SYS", "password": "MANAGER" }
  },
  "replication": {
    "jobs": [
      {
        "id": "job-1",
        "enabled": true,
        "shutdown_timeout_ms": 30000,
        "checkpoint": { "directory": "./checkpoints" },
        "execution_defaults": {
          "query_limit": 5000,
          "poll_interval_ms": 1000,
          "start_mode": "full",
          "on_save_failure": "continue",
          "integrity": { "enabled": true },
          "retry": { "max_attempts": 5, "base_delay_ms": 100, "max_delay_ms": 30000 }
        },
        "mappings": [
          {
            "mapping_id": "tag-to-tag2",
            "source": {
              "server": "src",
              "table": "TAG",
              "tag_identifier": { "mode": "none", "value": "" }
            },
            "target": { "server": "dst", "table": "TAG2" },
            "execution": {
              "start_mode": "rid_after",
              "rid_after": 1000
            }
          }
        ]
      }
    ]
  }
}
```

우선순위: `mapping.execution` > `mapping.source.execution` > `execution_defaults` 순으로 항목별 오버라이드된다.

### 주요 설정 항목

**job 레벨**

| 항목 | 기본값 | 설명 |
|------|--------|------|
| `enabled` | `true` | `false`이면 job 전체 건너뜀 |
| `shutdown_timeout_ms` | `30000` | graceful shutdown 최대 대기 시간 (ms). 초과 시 강제 종료 |
| `checkpoint.directory` | `"./checkpoints"` | 체크포인트 파일 저장 디렉토리 |

**execution 항목** (`execution_defaults` 또는 mapping의 `execution`에서 사용)

| 항목 | 기본값 | 설명 |
|------|--------|------|
| `start_mode` | `"full"` | 체크포인트 없을 때 시작 기준. `full`=RID 0, `now`=현재 최대 RID, `rid_after`=지정 RID |
| `rid_after` | — | `start_mode=rid_after`일 때 시작 RID 값 (필수) |
| `query_limit` | `5000` | 1회 읽기 최대 행 수 |
| `poll_interval_ms` | `1000` | 새 데이터 없을 때 대기 시간 (ms) |
| `on_save_failure` | `"continue"` | 체크포인트 저장 실패 시 동작. `continue` 또는 `abort` |
| `integrity.enabled` | `true` | TAG 테이블 재시작 시 중복 검사(STARTUP_INTEGRITY) 수행 여부 |
| `retry.max_attempts` | — | read/append 실패 시 최대 재시도 횟수 |
| `retry.base_delay_ms` | — | 재시도 초기 대기 시간 (ms, 지수 백오프) |
| `retry.max_delay_ms` | — | 재시도 최대 대기 시간 (ms) |

**mapping 레벨**

| 항목 | 기본값 | 설명 |
|------|--------|------|
| `source.tag_identifier` | `{ mode: "none" }` | TAG 이름 변환 규칙. `prefix`/`suffix`/`none` |

## 실행

```bash
# 기본 (config.json 사용)
node app.js

# 설정 파일 직접 지정
node app.js /path/to/config.json
```

종료는 `SIGTERM` 또는 `SIGINT`(Ctrl+C)로 graceful shutdown된다. 현재 처리 중인 배치를 완료한 뒤 체크포인트를 저장하고 종료한다.

## 동작 원리

```
소스 DB                           대상 DB
_TAG_DATA_0  ──┐
_TAG_DATA_1  ──┤  Worker (병렬)  ──▶  Append Stream
_TAG_DATA_2  ──┤
_TAG_DATA_3  ──┘
```

각 데이터 파티션(`_TAG_DATA_N`)마다 독립적인 Worker가 실행된다. Worker는 각자 독립된 소스/대상 DB 연결을 보유한다.

**Worker 상태 전이:**

1. **RESOLVE_START** — 체크포인트 파일을 읽어 시작 RID를 결정한다. 파일이 없거나 손상된 경우 `start_mode` 기준으로 폴백한다.
2. **STARTUP_INTEGRITY** — TAG 테이블 재시작 시(`integrity.enabled=true`), 이미 대상 DB에 기록된 행을 확인해 중복 없이 안전한 재개 지점을 산출한다. LOG 테이블은 수행하지 않는다.
3. **STEADY_REPLICATION** — `readAfterRid → append → checkpoint 저장 → sleep` 루프를 반복한다.

체크포인트 파일은 `checkpoints/{job_id}__{data_table}.json`에 저장된다.

## 테스트

```bash
# 전체 단위 테스트 (92개)
node --test tests/unit/*.test.js

# 통합 테스트 (실 DB 연결 필요 — 127.0.0.1:5656)
node --test tests/integration/tag_replication.test.js
node --test tests/integration/log_replication.test.js
node --test tests/integration/table.test.js
```

현재 92개 단위 테스트 pass. 통합 테스트는 실 DB 연결 시 pass.

## 로그 형식

모든 로그는 JSON 구조체로 출력된다.

```
{"level":"info","stage":"worker","job_id":"job-1","data_table":"_TAG_DATA_0","msg":"STEADY_REPLICATION start, start_rid=0"}
{"level":"info","stage":"checkpoint_saved","job_id":"job-1","data_table":"_TAG_DATA_0","last_success_rid":"4999","rows_read":5000,"rows_written":5000,"dropped_no_meta":0,"skipped_exists":0}
{"level":"error","stage":"checkpoint_io","job_id":"job-1","data_table":"_TAG_DATA_0","msg":"parse failed: Unexpected token"}
```

## 알려진 제약

### @machbase/ts-client FLOAT/DOUBLE endian 버그

`@machbase/ts-client@0.9.3`의 쿼리 결과 디코더(`decodeFixedField`)가 `FLT32`/`FLT64` 타입을 항상 Little-Endian으로 읽지만, Machbase TAG 파티션에 따라 서버가 Big-Endian으로 저장하는 경우가 있어 값이 손상된다.

`db/client.js`의 `fixDoubleEndian()` 함수가 `MachbaseClient.query()` 반환 직후 자동으로 보정한다. denormal(비정규 부동소수점) 판별로 손상 여부를 감지한 뒤 바이트 순서를 뒤집어 재해석한다. 라이브러리 재설치 후에도 프로젝트 코드 내에서 보정이 적용된다.

상세 분석은 [`docs/ENDIAN_BUG.md`](docs/ENDIAN_BUG.md)를 참고한다.

## 디렉토리 구조

```
repli-js/
├── app.js               # 진입점
├── job_runner.js        # Job 오케스트레이션
├── config/config.js     # 설정 로드/검증
├── core/
│   ├── types.js         # ColumnType, Column, TableSchema (순수 도메인 모델)
│   └── retry.js         # 재시도 유틸리티
├── db/
│   ├── client.js        # MachbaseClient (endian 우회 포함)
│   ├── stream.js        # MachbaseStream, _toCell (append 스트림 래퍼)
│   └── table.js         # LogTable, TagTable, TagDataTable, TagAliasCache
├── worker/
│   └── worker.js        # Worker 상태 머신
├── checkpoint/
│   └── store.js         # 체크포인트 관리 (atomic write, BigInt 지원 내장)
├── docs/
│   ├── PROJECT.md       # 상세 설계 문서 (아키텍처, UML, 결정 이력)
│   └── ENDIAN_BUG.md    # @machbase/ts-client endian 버그 상세 분석
├── checkpoints/         # 런타임 생성 — cp 파일 저장 위치
└── tests/
    ├── unit/            # 단위 테스트 (92개)
    └── integration/     # 통합 테스트 (36개, 실 DB 필요)
```
