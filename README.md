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
| `source.tag_identifier` | `{ mode: "none" }` | TAG 이름 변환 규칙. 기본값은 변환 없음 |

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

각 데이터 파티션(`_TAG_DATA_N`)마다 독립적인 Worker가 실행된다.

**Worker 상태 전이:**

1. **RESOLVE_START** — 체크포인트 파일을 읽어 시작 RID를 결정한다. 파일이 없거나 손상된 경우 `start_mode` 기준으로 폴백한다.
2. **STARTUP_INTEGRITY** — TAG 테이블 재시작 시, 이미 대상 DB에 기록된 행을 확인해 중복 없이 안전한 재개 지점을 산출한다.
3. **STEADY_REPLICATION** — `readAfterRid → append → checkpoint 저장 → sleep` 루프를 반복한다.

체크포인트 파일은 `checkpoints/{job_id}__{data_table}.json`에 저장된다.

## 테스트

```bash
npm test
```

현재 52개 단위 테스트 전체 통과 (worker 상태 머신, 체크포인트, 설정, retry, E2E 시나리오).

## 로그 형식

모든 로그는 JSON 구조체로 출력된다.

```
{"level":"info","stage":"worker","job_id":"job-1","data_table":"_TAG_DATA_0","msg":"STEADY_REPLICATION start, start_rid=0"}
{"level":"info","stage":"checkpoint_saved","job_id":"job-1","data_table":"_TAG_DATA_0","last_success_rid":"4999","rows_read":5000,"rows_written":5000,"dropped_no_meta":0,"skipped_exists":0}
{"level":"error","stage":"checkpoint_io","job_id":"job-1","data_table":"_TAG_DATA_0","msg":"parse failed: Unexpected token"}
```

## 디렉토리 구조

```
repli-js/
├── app.js               # 진입점
├── job_runner.js        # Job 오케스트레이션
├── config/config.js     # 설정 로드/검증
├── worker/
│   ├── worker.js        # Worker 상태 머신
│   └── retry.js         # 재시도 유틸리티
├── machbase/
│   ├── source_reader.js     # 소스 DB 읽기
│   ├── target_writer.js     # 대상 DB 쓰기
│   ├── tag_meta_provider.js # TAG 메타 조회
│   ├── integrity_checker.js # 중복 검사
│   └── catalog.js           # 테이블/컬럼 카탈로그
├── file/
│   ├── file.js          # JSON 파일 I/O
│   └── checkpoint.js    # 체크포인트 관리
├── checkpoints/         # 런타임 생성 — cp 파일 저장 위치
└── tests/unit/          # 단위 테스트
```
