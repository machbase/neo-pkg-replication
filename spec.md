# 데이터베이스 테이블 복제 시스템 기능명세서

**기준 문서**: `replication_2.txt` (요구사항 명세 v2.2 / 내부 설계 전제 v2.2 / 설정 스키마 v3 / 체크포인트 포맷 / 상세설계 v1.2 / Worker 의사코드 v1.2)
**기획서 기준**: `plan.md` (아키텍처, 컴포넌트, 작업 지시서)
**작성일**: 2026-02-23
**버전**: 1.0

---

## 목차

1. [시스템 개요](#1-시스템-개요)
2. [용어 정의](#2-용어-정의)
3. [시스템 범위 및 제약](#3-시스템-범위-및-제약)
4. [기능 목록 및 의존 관계](#4-기능-목록-및-의존-관계)
5. [기능 명세](#5-기능-명세)
   - [F-CONF] 설정 로드 및 유효성 검사
   - [F-DISC] 테이블 타입 판정 및 데이터 테이블 목록 조회
   - [F-CP] 체크포인트 읽기 및 쓰기
   - [F-READ] _rid 기반 배치 읽기
   - [F-META] tag_id 변환 및 tag_identifier 적용
   - [F-INTG] 재시작 정합성 보정 (STARTUP_INTEGRITY)
   - [F-WRITE] 대상 테이블 Append 쓰기
   - [F-RETRY] 재시도 처리
   - [F-WORK] Worker 상태 머신 및 STEADY_REPLICATION 배치 루프
   - [F-JOB] Job 오케스트레이션 및 Graceful Shutdown
   - [F-LOG] 구조화 로그
6. [경계 조건 및 예외 시나리오](#6-경계-조건-및-예외-시나리오)
7. [고정 정책 vs 설정 가능 항목](#7-고정-정책-vs-설정-가능-항목)
8. [테이블 타입별 동작 비교](#8-테이블-타입별-동작-비교)
9. [구현 우선순위 및 Phase 구분](#9-구현-우선순위-및-phase-구분)
10. [비범위 및 향후 과제](#10-비범위-및-향후-과제)

---

## 1. 시스템 개요

### 1.1 목적

원본 Database의 TAG / Log 테이블 데이터를 대상 Database 테이블로 지속 복제한다. 트랜잭션과 PK가 없는 환경에서 `_rid` 기반 체크포인트를 활용하여 **at-least-once** 복제를 달성하고, 가능한 범위 내에서 정합성을 최대화한다.

### 1.2 목표 / 비목표

| 구분 | 항목 |
|------|------|
| **목표** | at-least-once 복제, 정합성 최대화 (Tag 테이블), Graceful Shutdown |
| **비목표** | Exactly-once 보장, Update/Delete 복제, 대상 테이블 생성/스키마 관리 |

### 1.3 핵심 제약

- DB 트랜잭션 없음, PK 없음 → 중복 발생 허용 (at-least-once)
- 복제 단위: `_rid` 기반 배치
- 설정 변경 시 프로세스 재시작 필요 (핫 리로드 미지원, 고정 정책)

---

## 2. 용어 정의

| 용어 | 정의 |
|------|------|
| 논리 테이블 | 원본 테이블. 실제 데이터를 저장하지 않고 메타 및 데이터 테이블 구성 정보만 보유 |
| 데이터 테이블 | 실제 데이터가 저장되는 테이블. Tag 테이블의 경우 `{logical}_DATA_{index}` 형태 |
| `_rid` | 데이터 테이블별 순차적이고 unique한 일련번호 (단조 증가) |
| 체크포인트 | 데이터 테이블별 마지막 성공 복제 `_rid` (파일로 저장) |
| canonical tag_name | tag_id → tag_name 변환 후 tag_identifier(prefix/suffix/none)를 적용한 최종 tag_name' |
| mapping | 하나의 소스 논리 테이블과 대상 테이블 간의 복제 단위 설정 |
| Worker | data_table 1개당 생성되는 독립 복제 실행 단위 |
| STARTUP_INTEGRITY | 재시작 직후 수행하는 중복 skip 및 시작 위치 보정 단계 (Tag 전용) |
| STEADY_REPLICATION | 정상 복제 루프 |
| effective_max | STEADY에서 checkpoint advance 기준이 되는 `_rid` 값 (max_written_rid 또는 max_rid_in_batch) |

---

## 3. 시스템 범위 및 제약

### 3.1 포함 범위

- 데이터 테이블의 Insert 데이터 복제
- tag id → canonical tag_name 변환 (tag_identifier 적용 포함)
- 재시작 시 정합성 유지 (Tag 테이블 전용)
- 네트워크 오류에 대한 재시도
- `_rid` 기반 체크포인트 관리

### 3.2 제외 범위

- Update / Delete 처리
- 대상 테이블 생성 및 스키마 관리
- 메타 정보 동기화 (1차 범위에서 보류, 추후 별도 설계 예정)
- 핫 리로드 (설정 변경 시 재시작 필요)

### 3.3 스키마 불일치 처리 정책

대상 테이블은 사전에 생성되어 있어야 하며, 스키마 관리는 제외 범위이다.

| 불일치 유형 | 처리 |
|------------|------|
| 원본에 있고 대상에 없는 컬럼 | 해당 컬럼 값을 write에서 제외 (무시) |
| 대상에 있고 원본에 없는 컬럼 | Null로 채움 |

---

## 4. 기능 목록 및 의존 관계

### 4.1 기능 목록

| 기능 ID | 기능명 | 컴포넌트 |
|---------|--------|---------|
| F-CONF | 설정 로드 및 유효성 검사 | ConfigLoader |
| F-DISC | 테이블 타입 판정 및 데이터 테이블 목록 조회 | CatalogClient |
| F-CP | 체크포인트 읽기 및 쓰기 | CheckpointStore |
| F-READ | `_rid` 기반 배치 읽기 | SourceReader |
| F-META | tag_id 변환 및 tag_identifier 적용 | TagMetaProvider |
| F-INTG | 재시작 정합성 보정 (STARTUP_INTEGRITY) | IntegrityChecker + Worker |
| F-WRITE | 대상 테이블 Append 쓰기 | TargetWriter |
| F-RETRY | 재시도 처리 | RetryHandler |
| F-WORK | Worker 상태 머신 및 STEADY_REPLICATION 배치 루프 | Worker |
| F-JOB | Job 오케스트레이션 및 Graceful Shutdown | JobRunner |
| F-LOG | 구조화 로그 | Logger |

### 4.2 기능 의존 관계 매트릭스

| 기능 ID | 선행 필요 기능 |
|---------|---------------|
| F-CONF | 없음 |
| F-DISC | F-CONF |
| F-CP | F-CONF |
| F-READ | F-CONF, F-DISC |
| F-META | F-CONF, F-DISC |
| F-INTG | F-CP, F-READ, F-META |
| F-WRITE | F-CONF, F-DISC |
| F-RETRY | F-CONF |
| F-WORK | F-CP, F-READ, F-META, F-INTG, F-WRITE, F-RETRY |
| F-JOB | F-CONF, F-DISC, F-WORK |
| F-LOG | F-CONF |

### 4.3 의존 관계 다이어그램

```
F-CONF
  ├─ F-DISC
  │    ├─ F-READ ──────────────┐
  │    ├─ F-META ──────────────┤
  │    └─ F-WRITE ─────────────┤
  ├─ F-CP ────────────────────┤
  ├─ F-RETRY ─────────────────┤
  └─ F-LOG                    │
                               ▼
                    F-INTG (Tag+체크포인트+integrity.enabled)
                               │
                               ▼
                    F-WORK (STEADY_REPLICATION)
                               │
                               ▼
                    F-JOB (오케스트레이션 + Graceful Shutdown)
```

---

## 5. 기능 명세

---

### [F-CONF] 설정 로드 및 유효성 검사

**개요**: 시스템 시작 시 설정 파일(YAML 또는 JSON, v3)을 파싱하고, 필수 필드 존재 여부·값 범위·상호 참조 유효성을 검사한다. version 불일치 또는 파일 파싱 실패는 프로세스 종료 사유이며, 개별 mapping 검증 실패는 해당 mapping 스킵으로 처리하고 나머지는 계속 실행한다.

**사전 조건**:
- 설정 파일이 지정 경로에 존재하고 읽기 가능

**입력**:
- 설정 파일 경로 (CLI 인수 또는 환경 변수)
- 설정 파일 내용 (YAML/JSON, schema v3)

**처리 규칙**:

정상 흐름:
1. 파일을 읽어 YAML/JSON으로 파싱한다.
2. `version == 3` 확인 (불일치 시 프로세스 종료 + 오류 로그).
3. `servers` 맵의 각 alias에 대해 value(접속 문자열)가 비어 있지 않은지 확인.
4. `enabled == false`인 job은 이후 처리에서 제외.
5. 각 mapping의 `source.server`, `target.server`가 `servers`에 정의된 alias를 참조하는지 확인 (불일치 시 해당 mapping 스킵 + 오류 로그).
6. `source.start_mode`가 `"full"` | `"now"` | `"rid_after"` 중 하나인지 확인 (그 외 시 해당 mapping 스킵 + 오류 로그).
7. `start_mode == "rid_after"` 이면 `rid_after`가 null이 아닌 정수인지 확인 (null이면 해당 mapping 스킵 + 오류 로그).
8. `checkpoint.on_save_failure`가 `"continue"` | `"abort"` 중 하나인지 확인. 명시하지 않으면 기본값 `"continue"` 적용.
9. `shutdown_timeout_ms`가 양의 정수인지 확인. 명시하지 않으면 기본값 30000 적용.
10. `execution_defaults.batch_size_records`가 양의 정수인지 확인. 명시하지 않으면 기본값 5000 적용 (F-12).
11. execution 필드 레벨 merge 수행 (F-16): 각 필드(`batch_size_records`, `poll_interval_ms`)에 대해 **독립적으로** 다음 우선순위를 적용한다:
    ```
    1순위: mapping.execution.{field}
    2순위: source.execution.{field}
    3순위: job.execution_defaults.{field}
    ```
    상위 레벨에 해당 필드가 존재하면(null 제외) 해당 값을 사용하고, 없으면 다음 레벨로 내려간다.

엣지 케이스:
- `tag_identifier.mode == "none"`이면 `value` 필드가 없거나 빈 문자열이어도 허용.
- `retry.max_attempts == null`이면 무한 재시도로 처리.
- 동일 `job_id`가 중복될 경우, 뒤에 정의된 job을 사용하고 경고 로그를 남긴다.

에러 케이스:
- 파일을 읽지 못하거나 파싱 실패 → 프로세스 종료 + 오류 로그
- `version != 3` → 프로세스 종료 + 오류 로그
- 개별 mapping 검증 실패 → 해당 mapping 스킵 + 오류 로그, 나머지 처리 계속

**출력 / 사후 조건**:
- 유효한 Config 객체 반환 (스킵된 mapping은 제외됨)
- 각 mapping에 execution 옵션의 필드 레벨 merge 최종값이 주입됨
- `shutdown_timeout_ms`, `batch_size_records`, `on_save_failure`에 기본값이 주입됨

**수용 기준 (Acceptance Criteria)**:
- Given: `version: 2`인 설정 파일을 로드할 때 / When: ConfigLoader.load() 실행 / Then: 프로세스가 종료되고 "버전 불일치" 내용을 포함한 오류 로그가 출력된다.
- Given: `source.server: "unknown_alias"`인 mapping이 포함된 설정 파일 / When: ConfigLoader.load() 실행 / Then: 해당 mapping은 스킵되고 나머지 mapping은 정상 반환된다.
- Given: `execution_defaults.batch_size_records`가 명시되지 않은 설정 / When: ConfigLoader.load() 실행 / Then: 반환된 Config의 해당 필드 값이 5000이다.
- Given: `mapping.execution.batch_size_records: 10000`, `source.execution.batch_size_records: 3000`이 모두 설정된 mapping / When: ConfigLoader.load() 실행 / Then: 해당 mapping의 유효 batch_size_records가 10000이다.
- Given: `mapping.execution.poll_interval_ms`는 없고 `source.execution.poll_interval_ms: 200`이 설정된 mapping / When: ConfigLoader.load() 실행 / Then: 해당 mapping의 유효 poll_interval_ms가 200이다.
- Given: `start_mode: "rid_after"`이고 `rid_after: null`인 mapping / When: ConfigLoader.load() 실행 / Then: 해당 mapping은 스킵되고 오류 로그에 "rid_after" 관련 내용이 포함된다.
- Given: `on_save_failure`가 명시되지 않은 설정 / When: ConfigLoader.load() 실행 / Then: 해당 job의 on_save_failure가 "continue"이다.
- Given: `batch_size_records`가 mapping.execution에만 있고 poll_interval_ms가 source.execution에만 있을 때 / When: ConfigLoader.load() 실행 / Then: batch_size_records는 mapping 레벨 값을, poll_interval_ms는 source 레벨 값을 사용한다 (두 필드가 독립 merge됨).

---

### [F-DISC] 테이블 타입 판정 및 데이터 테이블 목록 조회

**개요**: 소스 DB의 `M$SYS_TABLES`를 조회하여 논리 테이블의 TYPE을 판정(TAG=6, LOG=0, UNSUPPORTED)하고, TAG 테이블인 경우 `V$STORAGE_TAG_TABLES`에서 데이터 테이블 목록을 조회한 뒤 컬럼 규칙을 검증한다. 검증에 실패하면 해당 mapping을 스킵한다.

**사전 조건**:
- 소스 DB에 연결 가능한 상태
- F-CONF가 완료되어 유효한 Config 객체가 반환된 상태

**입력**:
- `mapping.source.server` (서버 alias)
- `mapping.source.table` (논리 테이블명)

**처리 규칙**:

정상 흐름:
1. `M$SYS_TABLES`에서 `table_name = mapping.source.table` 조건으로 TYPE 조회.
2. TYPE == 6 → TAG 테이블로 분류:
   a. `V$STORAGE_TAG_TABLES`와 `M$SYS_TABLES` 조인으로 해당 논리 테이블의 데이터 테이블 목록 조회 (이름 패턴: `{logical}_DATA_{index}`).
   b. 데이터 테이블이 0개이면 해당 mapping 스킵 + 오류 로그.
   c. 첫 번째 데이터 테이블의 컬럼 목록을 `M$SYS_COLUMNS`에서 조회.
   d. 컬럼 규칙 검증 (고정 정책, 설정 변경 불가):
      - 1번째 컬럼: integer 계열 타입 (tag id)
      - 2번째 컬럼: int64 타입 (time, 컬럼명 무관)
      - 컬럼 수가 2개 미만인 경우도 위반
      - 위반 시 해당 mapping 스킵 + 오류 로그 (stage: "catalog")
   e. 검증 통과 시 데이터 테이블 목록 반환.
3. TYPE == 0 → LOG 테이블로 분류:
   a. 논리 테이블 = 데이터 테이블 (단일 테이블, 목록: `[source.table]`).
   b. 컬럼 검증 수행하지 않음.
   c. n:1 매핑 검증: 동일한 `target.server + target.table`에 여러 LOG mapping이 설정된 경우, 두 번째 이후 mapping을 설정 오류로 간주하여 스킵 + 오류 로그.
4. TYPE가 6 또는 0이 아닌 경우 → UNSUPPORTED: 해당 mapping 스킵 + 오류 로그 (고정 정책: `skip_when_table_type_unsupported = true`).

에러 케이스:
- `M$SYS_TABLES` 조회 실패 (네트워크 등) → 해당 mapping 스킵 + 오류 로그 (stage: "catalog")
- `V$STORAGE_TAG_TABLES` 조회 실패 → 해당 mapping 스킵 + 오류 로그
- 카탈로그 조회 실패는 retry 없이 즉시 mapping 스킵 처리

**출력 / 사후 조건**:
- `{ tableType: "TAG" | "LOG", dataTables: string[] }` 반환
- TAG: `dataTables`에 데이터 테이블명 1개 이상 포함
- LOG: `dataTables`에 논리 테이블명 1개만 포함

**수용 기준 (Acceptance Criteria)**:
- Given: `M$SYS_TABLES`에서 table TYPE이 6인 논리 테이블 / When: CatalogClient.getLogicalTableType() 실행 / Then: 반환값의 type이 "TAG"이다.
- Given: `M$SYS_TABLES`에서 table TYPE이 0인 논리 테이블 / When: CatalogClient.getLogicalTableType() 실행 / Then: 반환값의 type이 "LOG"이다.
- Given: `M$SYS_TABLES`에서 TYPE이 99인 테이블 / When: F-DISC 실행 / Then: 해당 mapping이 스킵되고 stage="catalog" 오류 로그가 출력된다.
- Given: TAG 테이블의 1번째 컬럼 타입이 varchar인 경우 / When: validateTagColumns() 실행 / Then: false 반환, 해당 mapping 스킵, 오류 로그에 위반 컬럼 인덱스 및 실제 타입이 포함된다.
- Given: TAG 테이블의 2번째 컬럼 타입이 int64가 아닌 경우 / When: validateTagColumns() 실행 / Then: false 반환, 해당 mapping 스킵.
- Given: TAG 테이블의 컬럼 수가 1개인 경우 / When: validateTagColumns() 실행 / Then: false 반환, 해당 mapping 스킵.
- Given: LOG 테이블에 동일 target으로의 두 번째 mapping 설정 / When: F-DISC 실행 / Then: 두 번째 mapping이 스킵되고 "n:1 mapping" 관련 오류 로그가 출력된다.
- Given: TAG 테이블이지만 데이터 테이블이 0개인 경우 / When: F-DISC 실행 / Then: 해당 mapping이 스킵되고 오류 로그가 출력된다.

---

### [F-CP] 체크포인트 읽기 및 쓰기

**개요**: 데이터 테이블별로 마지막 성공 복제 `_rid`를 JSON 파일에 저장하고 읽는다. 파일 갱신은 atomic write(임시 파일 → rename) 방식을 사용하며(고정 정책), 손상된 파일은 "없음"으로 처리한다. 체크포인트 저장 실패 시의 동작은 `on_save_failure` 설정을 따른다 (F-02).

**사전 조건**:
- `checkpoint.directory`가 존재하고 읽기/쓰기 가능
- job_id, data_table명이 확정된 상태

**입력**:
- `job_id` (string)
- `data_table` (string)
- `checkpoint.directory` (string)
- `checkpoint.on_save_failure` (`"continue"` | `"abort"`)
- 저장 시: `last_success_rid` (BigInt), 배치 통계 (`stats`)

**처리 규칙**:

정상 흐름 — 읽기:
1. 파일 경로: `{directory}/{job_id}__{data_table}.json`
2. 파일이 없으면 `{ exists: false, cp: null, err: null }` 반환.
3. 파일이 있으면 JSON 파싱.
4. 파싱 성공 시 `source.data_table` 필드값과 파일명 내 data_table 부분이 일치하는지 확인.
   - 불일치 시: 손상(corruption) 처리, `{ exists: false, cp: null, err: corruptionError }` 반환 + 오류 로그 (stage: "checkpoint_io", "data_table mismatch").
5. 일치 시: `{ exists: true, cp: { last_success_rid, updated_at }, err: null }` 반환.

정상 흐름 — 쓰기 (atomic write, 고정 정책):
1. 체크포인트 객체 구성:
   ```json
   {
     "version": 1,
     "job_id": "<job_id>",
     "source": {
       "server": "<alias>",
       "table": "<logical_table>",
       "data_table": "<data_table>"
     },
     "checkpoint": {
       "last_success_rid": <integer>,
       "updated_at": "<RFC3339>"
     }
   }
   ```
2. `{파일명}.tmp` 임시 파일에 JSON 직렬화 후 쓰기.
3. rename(`{파일명}.tmp` → `{파일명}.json`) 수행.
4. 성공 시 `checkpoint_saved` 이벤트 로그 출력 (F-LOG의 필수 로그 이벤트).

에러 케이스 — 읽기:
- JSON 파싱 실패 → `{ exists: false, cp: null, err: parseError }` + 오류 로그 (stage: "checkpoint_io"), "없음"으로 취급.

에러 케이스 — 쓰기 실패 (F-02):
- `on_save_failure == "continue"` (기본값): `level="error"` 로그를 강하게 남기고, Worker는 메모리 기준 rid(`effective_max + 1n`)로 계속 처리. 다음 재시작 시 이전 체크포인트 기준으로 시작하므로 중복 증가 가능.
- `on_save_failure == "abort"`: 세부 동작 미정의 (TODO). 현재 구현에서는 `"continue"`와 동일하게 동작하고 TODO 경고 로그를 추가 출력한다.

엣지 케이스:
- rename 수행 중 프로세스 종료: 다음 실행 시 `.tmp` 파일이 남아 있으면 무시하고 원본 `.json` 파일 기준으로 읽는다.

**출력 / 사후 조건**:
- 읽기: `{ exists: bool, cp: CheckpointData | null, err: Error | null }`
- 쓰기 성공: 지정 경로에 최신 체크포인트 파일이 원자적으로 갱신됨
- 쓰기 실패(continue): Worker 내 메모리 기준 rid로 처리 계속 (파일은 이전 값)

**수용 기준 (Acceptance Criteria)**:
- Given: 체크포인트 파일이 존재하지 않을 때 / When: CheckpointStore.load() 실행 / Then: `exists=false`, `err=null`이 반환된다.
- Given: 유효한 체크포인트 파일이 존재할 때 / When: CheckpointStore.load() 실행 / Then: `exists=true`, `cp.last_success_rid`가 파일에 저장된 값과 동일하다.
- Given: JSON이 깨진 체크포인트 파일이 존재할 때 / When: CheckpointStore.load() 실행 / Then: `exists=false`, `err`가 null이 아니며, stage="checkpoint_io" 오류 로그가 출력된다.
- Given: 파일명의 data_table 부분이 파일 내부 `source.data_table`과 다를 때 / When: CheckpointStore.load() 실행 / Then: `exists=false`, "data_table mismatch" 내용을 포함한 오류 로그가 출력된다.
- Given: CheckpointStore.save()가 정상 실행될 때 / When: 저장 후 동일 경로 파일 읽기 / Then: 저장한 `last_success_rid` 값이 일치한다.
- Given: CheckpointStore.save()가 정상 실행될 때 / When: 저장 성공 직후 / Then: job_id, mapping_id, data_table, last_success_rid, stats(read/written/skipped_exists/dropped_no_meta), updated_at을 포함한 `checkpoint_saved` 이벤트 로그가 출력된다.
- Given: rename 단계에서 디스크 쓰기 실패, `on_save_failure="continue"` / When: SAVE_CHECKPOINT 실행 / Then: `level="error"` 로그가 출력되고 Worker는 다음 배치를 계속 처리한다.
- Given: `.tmp` 파일만 존재하고 `.json` 파일이 없는 경우 / When: CheckpointStore.load() 실행 / Then: `exists=false`, `err=null`이 반환된다.

---

### [F-READ] _rid 기반 배치 읽기

**개요**: 소스 DB의 데이터 테이블에서 `_rid >= startRid` 조건으로 최대 limit개의 row를 배치 읽기한다. `start_mode == "now"` 인 경우 현재 최대 `_rid`를 조회하는 기능도 포함한다.

**사전 조건**:
- 소스 DB에 연결된 상태
- `startRid` (BigInt), `dataTable`, `limit` 값이 확정된 상태

**입력**:
- `server` alias (소스)
- `dataTable` (string)
- `startRid` (BigInt, 포함)
- `limit` (int, = 유효 `batch_size_records`)

**처리 규칙**:

정상 흐름 — readAfterRid:
1. SQL 실행: `SELECT /*+ RID_RANGE({dataTable}, {startRid}, ...) */ _RID, <모든 컬럼> FROM {dataTable} WHERE _RID >= {startRid} LIMIT {limit}`
2. 결과 rows를 `{ rid: BigInt, values: any[] }` 배열로 반환.
3. 결과가 0개이면 빈 배열 반환.

정상 흐름 — getMaxRid (`start_mode == "now"` 시 사용):
1. SQL 실행: `SELECT MAX(_RID) FROM {dataTable}`
2. 결과값을 BigInt로 반환. 데이터가 없으면 `0n` 반환.

에러 케이스:
- DB 쿼리 실패 (네트워크 등) → 오류 반환, 호출자(Worker)가 F-RETRY를 통해 retry 판단.

엣지 케이스:
- 빈 배열 반환 시: Worker는 `poll_interval_ms` 대기 후 재시도 (shutdown_requested 확인 병행).
- `startRid`가 현재 max `_rid`보다 큰 경우: 빈 배열 반환 (정상 케이스, 신규 데이터 대기).

**출력 / 사후 조건**:
- readAfterRid: `{ rows: Row[], err: Error | null }`
- getMaxRid: `{ maxRid: BigInt, err: Error | null }`

**수용 기준 (Acceptance Criteria)**:
- Given: dataTable에 `_rid` 100~200의 row가 존재하고 startRid=150, limit=10 / When: readAfterRid() 실행 / Then: 반환 rows의 길이가 10이고 모든 rid가 150 이상이다.
- Given: dataTable에 데이터가 없을 때 / When: readAfterRid(startRid=0, limit=5000) / Then: rows가 빈 배열이고 err가 null이다.
- Given: dataTable에 `_rid` 0~999 총 1000개 row가 있고 startRid=0, limit=5000 / When: readAfterRid() 실행 / Then: rows 길이가 1000이다.
- Given: dataTable에 `_rid` 500인 row가 마지막 / When: getMaxRid() 실행 / Then: 반환값이 BigInt(500)이다.
- Given: dataTable이 비어 있을 때 / When: getMaxRid() 실행 / Then: 반환값이 BigInt(0)이다.
- Given: DB 연결이 끊긴 상태 / When: readAfterRid() 실행 / Then: err가 null이 아니고 rows는 빈 배열이다.

---

### [F-META] tag_id 변환 및 tag_identifier 적용

**개요**: 소스 DB 메타 테이블에서 `tag_id`에 대응하는 `tag_name`을 조회하고, `tag_identifier`(prefix/suffix/none)를 적용하여 대상 테이블 기준의 canonical `tag_name'`을 생성한다. 메타에 없는 `tag_id`의 row는 drop 처리(무시)하고 체크포인트를 전진시킨다. 이 기능은 TAG 테이블에만 적용된다.

**사전 조건**:
- 소스 DB 메타 테이블(`_TAG_META` 등)에 접근 가능
- `mapping.source.tag_identifier` 설정이 로드된 상태

**입력**:
- `server` alias (소스)
- `logicalTable` (string)
- `tagId` (int/BigInt)
- `tag_identifier`: `{ mode: "prefix" | "suffix" | "none", value: string }`

**처리 규칙**:

정상 흐름:
1. 메타 테이블에서 `_ID = tagId` 조건으로 `tag_name` 조회.
2. 조회 성공: `tag_identifier` 적용하여 canonical 생성:
   - `mode == "prefix"`: `value + tag_name`
   - `mode == "suffix"`: `tag_name + value`
   - `mode == "none"`: `tag_name` (그대로, `value` 무시)
3. `{ canonical: string, status: "ok" }` 반환.

에러 케이스:
- 메타 조회 결과 없음 (not found): `{ canonical: null, status: "drop_not_found" }` 반환 → 호출자가 row drop + `stats.dropped_no_meta` 증가.
- 네트워크 등 일시 오류: `{ canonical: null, status: "retry_error" }` 반환 → 호출자가 retry 대상으로 처리.

엣지 케이스:
- `tag_name`이 빈 문자열인 경우: `tag_identifier` 적용 결과가 `value`만 포함될 수 있음 (허용, 별도 검증 없음).
- `mode == "none"`이고 `value`가 있는 경우: `value`를 무시하고 `tag_name` 그대로 반환.

**출력 / 사후 조건**:
- `{ canonical: string | null, status: "ok" | "drop_not_found" | "retry_error" }`

**수용 기준 (Acceptance Criteria)**:
- Given: tagId=42가 메타 테이블에 존재하고 tag_name="cpu", mode="prefix", value="A:" / When: resolveTagCanonical() 실행 / Then: canonical이 "A:cpu"이다.
- Given: tagId=42, tag_name="cpu", mode="suffix", value=":B" / When: resolveTagCanonical() 실행 / Then: canonical이 "cpu:B"이다.
- Given: tagId=42, tag_name="cpu", mode="none" / When: resolveTagCanonical() 실행 / Then: canonical이 "cpu"이다.
- Given: tagId=42, tag_name="cpu", mode="none", value="ignored" / When: resolveTagCanonical() 실행 / Then: canonical이 "cpu"이다 (value 무시).
- Given: tagId=999가 메타 테이블에 존재하지 않을 때 / When: resolveTagCanonical() 실행 / Then: status가 "drop_not_found"이고 canonical이 null이다.
- Given: 메타 테이블 조회 중 네트워크 오류 발생 / When: resolveTagCanonical() 실행 / Then: status가 "retry_error"이다.

---

### [F-INTG] 재시작 정합성 보정 (STARTUP_INTEGRITY)

**개요**: Tag 테이블에서 체크포인트가 존재하고 `integrity.enabled=true`인 경우, 재시작 직후 체크포인트 이후 구간의 row를 대상 테이블에서 확인하여 이미 복제된 row를 skip하고 최초 미복제 row의 직전 rid까지 체크포인트를 전진시킨다. STARTUP_INTEGRITY 완료 후 STEADY_REPLICATION으로 전이한다. STEADY_REPLICATION 중에는 존재 여부 검색을 수행하지 않는다(고정 정책).

**사전 조건**:
- `tableType == "TAG"`
- 체크포인트 파일이 존재하고 파싱 성공 (`exists == true`)
- `integrity.enabled == true`
- 소스 DB 및 대상 DB에 연결된 상태

**입력**:
- `mapping` (source, target, tag_identifier, execution 포함)
- `data_table` (string)
- `start_rid` (BigInt, = `cp.last_success_rid`)

**처리 규칙**:

정상 흐름:
1. `readAfterRid(start_rid, batch_size)` 호출 (`_rid >= start_rid`).
2. rows가 빈 경우: `poll_interval_ms` 대기 후 재시도 (`shutdown_requested` 확인).
3. `max_rid_in_batch = MAX(rows.rid)` 계산.
4. 각 row 처리:
   a. `resolveTagCanonical(tag_id)` → `(canonical, status)`
   b. `status == "retry_error"`: retry 후 동일 배치 재처리 (checkpoint 갱신 없음)
   c. `status == "drop_not_found"`: `stats.dropped_no_meta++`, continue
   d. `existsByTagAndTime(target, canonical, time_ns)` 조회 (tag_identifier 적용된 canonical 사용)
   e. 조회 오류: retry (stage: "integrity_check")
   f. `exists == true`: `stats.skipped_exists++`, continue
   g. `exists == false` (최초 miss 발견):
      - `safe_cp_rid = row.rid - 1n`
      - `SAVE_CHECKPOINT(safe_cp_rid)`
      - STARTUP_INTEGRITY 종료, `safe_cp_rid` 반환
      - STEADY_REPLICATION은 `safe_cp_rid`부터 시작 (`_rid >= safe_cp_rid`이므로 miss row를 포함하여 처음부터 재처리)
5. 배치 전체가 skip/drop만인 경우:
   - `SAVE_CHECKPOINT(max_rid_in_batch + 1n)`
   - `start_rid = max_rid_in_batch + 1n`
   - 다음 배치 계속

진입 조건 (Worker 레벨에서 판단):
- `tableType == "TAG"` AND `exists == true` AND `integrity.enabled == true` → F-INTG 실행
- 그 외 모든 경우 → STARTUP_INTEGRITY 없이 즉시 STEADY_REPLICATION 진입

엣지 케이스:
- `integrity.enabled == false` 또는 `tableType == "LOG"` → STARTUP_INTEGRITY 실행하지 않고 STEADY_REPLICATION 직접 진입.
- 체크포인트 없음 (`exists == false`) → STARTUP_INTEGRITY 실행하지 않고 STEADY_REPLICATION 직접 진입.
- STARTUP_INTEGRITY 중 `shutdown_requested == true` → 현재 배치를 완료하지 않고 즉시 루프 탈출.

에러 케이스:
- `existsByTagAndTime` 조회 실패: retry (stage: "integrity_check")

**출력 / 사후 조건**:
- 반환값: `safe_cp_rid` (최초 miss `row.rid - 1n`) 또는 마지막 배치의 `max_rid_in_batch + 1n`
- STEADY_REPLICATION은 반환된 `safe_cp_rid`부터 시작
- 체크포인트 파일이 진행된 위치까지 갱신됨

**수용 기준 (Acceptance Criteria)**:
- Given: 재시작 후 체크포인트=100, 대상 DB에 source _rid 100~150에 해당하는 row가 모두 존재 / When: STARTUP_INTEGRITY 실행 / Then: 반환 start_rid가 151 이상이고 STEADY_REPLICATION으로 전이된다.
- Given: 체크포인트=100, 대상 DB에 source _rid=105에 해당하는 row가 최초로 없을 때 / When: STARTUP_INTEGRITY 실행 / Then: 반환 safe_cp_rid = 104, 체크포인트 파일의 `last_success_rid` = 104이고, STEADY는 rid=104부터 읽기 시작한다.
- Given: tableType이 LOG일 때 / When: Worker가 STARTUP_INTEGRITY 조건 확인 / Then: STARTUP_INTEGRITY를 실행하지 않고 STEADY_REPLICATION에 직접 진입한다.
- Given: `integrity.enabled = false` / When: Worker가 STARTUP_INTEGRITY 조건 확인 / Then: STARTUP_INTEGRITY를 실행하지 않고 STEADY_REPLICATION에 직접 진입한다.
- Given: 체크포인트 없음(exists=false)이고 integrity.enabled=true / When: Worker가 STARTUP_INTEGRITY 조건 확인 / Then: STARTUP_INTEGRITY를 실행하지 않고 STEADY_REPLICATION에 직접 진입한다.
- Given: STARTUP_INTEGRITY 배치에서 모든 row가 drop_not_found / When: 해당 배치 처리 완료 / Then: 체크포인트가 `max_rid_in_batch + 1n`으로 갱신되고 다음 배치 읽기를 계속한다.
- Given: STARTUP_INTEGRITY 중 existsByTagAndTime 호출 시, target 조회에 사용하는 tag_name은 canonical(tag_identifier 적용 후)이어야 한다 / When: 대상 DB 조회 / Then: 조회 조건이 `tag_identifier` 적용된 canonical tag_name을 사용한다.

---

### [F-WRITE] 대상 테이블 Append 쓰기

**개요**: 변환된 `out_rows`를 대상 DB 테이블에 Append 스트림으로 배치 쓰기한다. 전체 성공만 성공으로 인정하며, 부분 성공은 실패로 간주한다. 스키마 불일치 시 지정된 정책을 적용한다.

**사전 조건**:
- 대상 DB에 연결된 상태
- 대상 테이블이 사전에 생성되어 있어야 함 (스키마 관리는 사용자 책임)
- `out_rows`가 준비된 상태

**입력**:
- `target.server` alias
- `target.table` (string)
- `rows`: `{ rid: BigInt, values: any[] }[]`
- 소스/대상 컬럼 메타 정보

**처리 규칙**:

정상 흐름:
1. 소스 컬럼과 대상 컬럼 목록을 비교하여 write용 컬럼 목록 결정:
   - 원본에 있고 대상에 없는 컬럼: write에서 제외 (해당 값 무시)
   - 대상에 있고 원본에 없는 컬럼: Null로 채움
2. Append 스트림을 열고 rows를 일괄 전송.
3. 전체 성공 시 `{ err: null }` 반환.

에러 케이스:
- 쓰기 실패 (네트워크, 연결 끊김 등) → `{ err: writeError }` 반환 → 호출자(Worker)가 F-RETRY를 통해 retry 판단.
- 부분 성공 여부 판단 불가 → 전체 실패로 간주, retry 대상.

엣지 케이스:
- `out_rows`가 빈 배열인 경우: write를 호출하지 않고 즉시 `{ err: null }` 반환.
- 대상 테이블이 존재하지 않는 경우: 쓰기 오류 발생 → 재시도 불가 오류로 분류하여 해당 mapping 스킵 + 오류 로그.

**출력 / 사후 조건**:
- 성공: 대상 DB에 해당 배치의 row가 기록됨, `{ err: null }` 반환
- 실패: `{ err: Error }` 반환, 대상 DB 상태 불명확 (retry 대상)

**수용 기준 (Acceptance Criteria)**:
- Given: out_rows 1000개를 대상 테이블에 write할 때 / When: TargetWriter.write() 실행 / Then: err가 null이고 대상 테이블에 1000개 row가 추가된다.
- Given: out_rows가 빈 배열일 때 / When: TargetWriter.write() 실행 / Then: 대상 DB에 write 요청이 전송되지 않고 err가 null이다.
- Given: 소스 컬럼에 "extra_col"이 있고 대상 테이블에는 없을 때 / When: write() 실행 / Then: "extra_col" 값이 전송되지 않고 나머지 컬럼은 정상 기록된다.
- Given: 대상에만 존재하는 "nullable_col" 컬럼이 있을 때 / When: write() 실행 / Then: "nullable_col"에 Null이 기록된다.
- Given: 대상 DB 연결이 끊긴 상태에서 write 호출 / When: TargetWriter.write() 실행 / Then: err가 null이 아니고 stage="write" 로그가 출력된다.
- Given: 대상 테이블이 존재하지 않아 쓰기 실패 / When: TargetWriter.write() 실행 / Then: 재시도 불가 오류로 분류되어 해당 mapping이 스킵된다.

---

### [F-RETRY] 재시도 처리

**개요**: 네트워크 오류 등 일시적 장애 발생 시 설정된 전략(exponential/linear)과 jitter에 따라 대기 후 재시도한다. 설정 오류·규칙 위반 등 재시도 불가 오류는 즉시 해당 mapping을 스킵한다.

**사전 조건**:
- retry 설정이 Config에 로드된 상태
- 오류 유형이 재시도 가능/불가로 분류된 상태

**입력**:
- retry 설정: `enabled`, `strategy`, `initial_delay_ms`, `max_delay_ms`, `multiplier`, `jitter`, `max_attempts`
- 오류 객체 및 `stage` 정보
- 현재 시도 횟수 (attempt count)

**처리 규칙**:

재시도 가능 오류 (retry):
- 네트워크 오류, 연결 끊김, 일시적 DB 오류
- tag_id 메타 조회 일시 오류 (`status: "retry_error"`)
- `existsByTagAndTime` 조회 오류 (stage: "integrity_check")
- 소스 읽기 오류 (stage: "read")
- 대상 쓰기 일시 오류 (stage: "write")

재시도 불가 오류 (즉시 mapping 스킵):
- 설정 오류 (잘못된 값, 참조 오류)
- TAG 컬럼 규칙 위반
- 테이블 TYPE 불일치 또는 미지원
- 대상 테이블이 존재하지 않는 경우

대기 시간 계산:
- `exponential`: `min(initial_delay_ms * multiplier^attempt, max_delay_ms)`
- `linear`: `min(initial_delay_ms + initial_delay_ms * attempt, max_delay_ms)`
- `jitter == true`: 계산된 대기 시간을 [0, delay] 범위에서 랜덤 값으로 변동

종료 조건:
- `max_attempts != null` 이고 `attempt >= max_attempts` → mapping 스킵 + 오류 로그
- `max_attempts == null` → 무한 재시도
- `retry.enabled == false` → 재시도 없이 즉시 mapping 스킵

**출력 / 사후 조건**:
- 재시도 성공: 정상 흐름 계속
- 재시도 불가 또는 max_attempts 도달: mapping 스킵

**수용 기준 (Acceptance Criteria)**:
- Given: strategy="exponential", initial_delay_ms=1000, multiplier=2.0, max_delay_ms=60000, jitter=false / When: 첫 번째 재시도 대기 / Then: 대기 시간이 1000ms이다.
- Given: 동일 설정에서 두 번째 재시도 / When: 대기 시간 계산 / Then: 2000ms이다.
- Given: strategy="exponential", max_delay_ms=5000, 계산 결과가 10000ms일 때 / When: 대기 시간 결정 / Then: 실제 대기 시간이 5000ms 이하이다.
- Given: max_attempts=3, 3번 연속 실패 / When: 세 번째 실패 처리 후 / Then: 해당 mapping이 스킵되고 "max_attempts 초과" 관련 오류 로그가 출력된다.
- Given: retry.enabled=false 상태에서 네트워크 오류 발생 / When: 오류 처리 / Then: 재시도 없이 즉시 해당 mapping을 스킵한다.
- Given: TAG 컬럼 규칙 위반 오류 발생 / When: 오류 분류 / Then: 재시도하지 않고 즉시 mapping을 스킵한다.
- Given: jitter=true이고 계산된 delay=2000ms / When: 대기 시간 결정 / Then: 실제 대기 시간이 [0, 2000]ms 범위 내에 있다.

---

### [F-WORK] Worker 상태 머신 및 STEADY_REPLICATION 배치 루프

**개요**: 데이터 테이블 1개당 1개의 Worker가 생성되어 병렬로 실행된다(고정 정책: `single_instance_per_data_table = true`, `max_inflight_batches = 1`). Worker는 RESOLVE_START → (STARTUP_INTEGRITY) → STEADY_REPLICATION 순서로 상태를 전이하며, STEADY_REPLICATION 루프에서 `_rid` 기반 배치 읽기-변환-쓰기-체크포인트 갱신을 반복한다.

**사전 조건**:
- F-DISC 완료 후 data_table 목록이 결정된 상태
- 모든 하위 컴포넌트(SourceReader, TagMetaProvider, IntegrityChecker, TargetWriter, CheckpointStore, RetryHandler)가 초기화된 상태
- mapping 단위로 생성된 source_conn / target_conn이 파라미터로 전달된 상태 (고정 정책: `connection_per_mapping = true`, 동일 mapping의 Worker 간 공유)

**입력**:
- `mapping` (전체 설정)
- `tableType` (`"TAG"` | `"LOG"`)
- `dataTable` (string)
- `source_conn` (mapping 단위 소스 DB connection)
- `target_conn` (mapping 단위 대상 DB connection)
- `shutdown_requested` (공유 플래그, bool)

**처리 규칙**:

RESOLVE_START:
1. CheckpointStore.load() 실행.
2. 체크포인트 존재 & 파싱 성공: `start_rid = cp.last_success_rid` (start_mode 무시, 고정 정책).
3. 체크포인트 없음/손상: start_mode 기준으로 start_rid 결정:
   - `full`: `start_rid = 0n`
   - `now`: `start_rid = SourceReader.getMaxRid()`
   - `rid_after`: `start_rid = mapping.source.rid_after` (BigInt 변환)

STARTUP_INTEGRITY 진입 조건 (F-INTG 참조):
- `tableType == "TAG"` AND `exists == true` AND `integrity.enabled == true` → F-INTG 실행
- 그 외 → 즉시 STEADY_REPLICATION 진입

STEADY_REPLICATION_LOOP (F-01 반영):
```
while NOT shutdown_requested:
  rows = readAfterRid(start_rid, batch_size)    // _rid >= start_rid
  if rows.empty:
    SLEEP_OR_SHUTDOWN(poll_interval_ms)         // shutdown_requested 시 즉시 깨어남
    continue

  max_rid_in_batch = MAX(rows.rid)
  max_written_rid = 0n
  out_rows = []

  [TAG]:
    for row in rows:
      (canonical, status) = resolveTagCanonical(tag_id)
      if status == "retry_error": HANDLE_RETRY; goto continue_outer
      if status == "drop_not_found": stats.dropped_no_meta++; continue
      row.values[0] = canonical                 // tag_id → canonical 치환
      out_rows.append(row)
  [LOG]:
    out_rows = rows                             // 변환 없이 그대로

  if out_rows is not empty:
    err = write(out_rows)
    if err: HANDLE_RETRY; goto continue_outer
    max_written_rid = MAX(out_rows.rid)

  // F-01: all-drop fallback
  effective_max = (max_written_rid > 0n) ? max_written_rid : max_rid_in_batch
  SAVE_CHECKPOINT(effective_max + 1n)
  start_rid = effective_max + 1n
```

엣지 케이스:
- `out_rows`가 빈 경우 (전부 drop): `max_written_rid = 0n` → `effective_max = max_rid_in_batch` → `SAVE_CHECKPOINT(max_rid_in_batch + 1n)`.
- SLEEP 중 `shutdown_requested = true`: 즉시 깨어나 루프 탈출.
- 배치 처리 중 `shutdown_requested = true`: 현재 배치를 완료한 후 루프 탈출 (배치 중간 중단 없음, 고정 정책).

**출력 / 사후 조건**:
- STEADY_REPLICATION 루프 탈출 시: 마지막 성공 배치의 체크포인트가 저장된 상태
- Worker 종료 시 source_conn / target_conn은 Worker가 직접 해제하지 않음 (mapping 레벨에서 모든 Worker 종료 후 해제)

**수용 기준 (Acceptance Criteria)**:
- Given: 체크포인트=100, TAG 테이블, rows에 `_rid` 100~149(50개)가 존재, 전부 meta 조회 성공, write 성공 / When: 한 배치 처리 완료 / Then: 체크포인트 파일의 `last_success_rid = 150` (max_written_rid=149, 149+1=150).
- Given: TAG 테이블, 배치 50개 row 중 전부 drop_not_found (`out_rows` 비어있음) / When: 한 배치 처리 완료 / Then: 체크포인트의 `last_success_rid = max_rid_in_batch + 1` (all-drop fallback, F-01).
- Given: LOG 테이블, 배치 100개 row / When: 한 배치 처리 완료 / Then: tag_id 변환 없이 row 그대로 write, 체크포인트 = `max_written_rid + 1`.
- Given: start_mode="full", 체크포인트 없음 / When: RESOLVE_START / Then: `start_rid = 0`.
- Given: start_mode="now", 체크포인트 없음, 현재 max_rid=5000 / When: RESOLVE_START / Then: `start_rid = 5000`.
- Given: 체크포인트가 존재하고 start_mode="full" / When: RESOLVE_START / Then: start_mode 무시, `start_rid = cp.last_success_rid`.
- Given: STEADY_REPLICATION 루프 중 rows가 빈 배열이고 `shutdown_requested=true` / When: SLEEP_OR_SHUTDOWN 호출 / Then: 즉시 깨어나 루프를 탈출하고 Worker가 종료된다.
- Given: STEADY_REPLICATION 배치 처리 도중 `shutdown_requested=true` 설정 / When: 현재 배치 처리 중 / Then: 현재 배치가 완료(write + checkpoint 저장)된 후 루프를 탈출한다.

---

### [F-JOB] Job 오케스트레이션 및 Graceful Shutdown

**개요**: 설정에서 활성화된 각 job의 mapping을 검증하고, data_table별 Worker를 병렬로 생성하여 실행한다. SIGTERM 수신 시 `shutdown_requested` 플래그를 설정하고 모든 Worker가 종료할 때까지 `shutdown_timeout_ms` 동안 대기한다 (F-03).

**사전 조건**:
- F-CONF가 유효한 Config 객체를 반환 완료
- 시스템이 초기화된 상태

**입력**:
- Config 객체 (전체 설정)
- SIGTERM 신호

**처리 규칙**:

초기화 흐름:
1. `enabled == true`인 job만 처리.
2. 각 job의 mapping에 대해 F-DISC 실행.
3. F-DISC 실패 mapping은 스킵하고 나머지는 계속.
4. F-DISC 성공 mapping에 대해 source_conn / target_conn 생성 (mapping당 각 1개, 고정 정책: `connection_per_mapping = true`).
5. 유효한 data_table별 Worker를 생성하고 병렬 실행 (1 data_table = 1 Worker, concurrent, 고정 정책). source_conn / target_conn을 파라미터로 전달.
6. 모든 Worker 종료 후 source_conn / target_conn 해제.
7. SIGTERM 핸들러 등록 (초기화 완료 전에 등록).

Graceful Shutdown (F-03):
1. SIGTERM 수신 → `shutdown_requested = true` (공유 플래그, 모든 Worker가 접근).
2. 모든 Worker의 종료 완료를 최대 `shutdown_timeout_ms` ms 동안 대기.
3. 타임아웃 내 전체 종료: 정상 종료 로그 출력.
4. 타임아웃 초과 시: `level="warn"` 경고 로그("shutdown timeout 초과, 강제 종료") 출력 후 강제 종료.
   - 강제 종료 시 배치 처리 중인 Worker는 체크포인트를 저장하지 못할 수 있음 → 다음 재시작 시 중복 발생 가능 (at-least-once 허용 범위).

Worker 레벨 shutdown 처리 (고정 정책):
1. 매 배치 루프 시작 시 `shutdown_requested` 확인 → `true`이면 루프 탈출.
2. 현재 배치 처리 중이면 완료 후 체크포인트 저장 후 종료 (배치 중간 중단 없음).
3. SLEEP 중이면 즉시 깨어나 루프 탈출.

고정 정책:
- `max_inflight_batches = 1` (1 Worker당 동시 처리 배치 1개)
- `single_instance_per_data_table = true`
- `config_hot_reload = false` (설정 변경 시 프로세스 재시작 필요)

**출력 / 사후 조건**:
- 정상 종료: 모든 Worker가 배치 경계에서 종료, 각 체크포인트 파일이 최신 상태
- 강제 종료: 일부 체크포인트 미갱신 가능 (중복 허용)

**수용 기준 (Acceptance Criteria)**:
- Given: 2개 mapping, 각각 2개 data_table(총 4개 Worker) / When: JobRunner 시작 / Then: 4개 Worker가 병렬로 실행 중이다.
- Given: SIGTERM 신호를 수신할 때 / When: JobRunner가 신호를 처리 / Then: `shutdown_requested`가 true로 설정되고 모든 Worker가 다음 배치 루프 시작 시 종료 흐름에 진입한다.
- Given: SIGTERM 수신 후 Worker 1개가 `shutdown_timeout_ms=30000`ms 이내에 종료되지 않을 때 / When: 타임아웃 초과 / Then: `level="warn"` 경고 로그("shutdown timeout")가 출력되고 전체 프로세스가 강제 종료된다.
- Given: `enabled=false`인 job / When: JobRunner 초기화 / Then: 해당 job의 Worker가 생성되지 않는다.
- Given: SIGTERM 수신 시 Worker가 배치 처리 중 / When: `shutdown_requested=true` 설정 / Then: 현재 배치 완료 후 체크포인트 저장 후 종료한다 (배치 중간 중단 없음).
- Given: `shutdown_timeout_ms` 설정 없이 실행 / When: JobRunner 초기화 / Then: shutdown_timeout_ms가 30000ms로 적용된다.

---

### [F-LOG] 구조화 로그

**개요**: 모든 주요 이벤트와 오류를 `stage` 및 context 정보를 포함한 구조화된 형식으로 기록한다. 1차 구현에서는 구조화 로그로 관측성을 확보하며, 로그 레벨은 설정으로 제어한다.

**사전 조건**:
- `logging.level`, `logging.log_dir` 설정이 로드된 상태

**입력**:
- `logging.level` (`"debug"` | `"info"` | `"warn"` | `"error"`)
- `logging.log_dir` (string)
- 각 이벤트별 구조화 필드

**처리 규칙**:

필수 로그 이벤트:

1. **`checkpoint_saved`** (level: info): 체크포인트 저장 성공 시마다 기록
   ```json
   {
     "event": "checkpoint_saved",
     "job_id": "<string>",
     "mapping_id": "<string>",
     "data_table": "<string>",
     "last_success_rid": <integer>,
     "stats": {
       "read": <int>,
       "written": <int>,
       "skipped_exists": <int>,
       "dropped_no_meta": <int>
     },
     "updated_at": "<RFC3339>"
   }
   ```

2. **오류 로그** (level: error): 각 오류 발생 시 기록
   ```json
   {
     "stage": "catalog | checkpoint_io | read | meta_lookup | integrity_check | write",
     "job_id": "<string>",
     "mapping_id": "<string>",
     "data_table": "<string>",
     "raw": "<원본 오류 메시지>",
     "<기타 컨텍스트>": "..."
   }
   ```

3. **shutdown 관련** (level: warn): 타임아웃 강제 종료 시 기록
   - "shutdown timeout 초과, 강제 종료" 내용 포함

로그 레벨 계층:
- `debug`: 상세 처리 흐름, 각 row 처리 결과, drop된 row의 tag_id 및 _rid
- `info`: 정상 처리 완료 (`checkpoint_saved`), 시스템 시작/종료
- `warn`: 비정상이지만 계속 처리 가능 (강제 종료, `on_save_failure=continue` 저장 실패)
- `error`: 오류 발생, mapping 스킵

**출력 / 사후 조건**:
- `log_dir`에 로그 파일이 기록됨
- 설정된 `level` 이상의 로그만 출력됨

**수용 기준 (Acceptance Criteria)**:
- Given: 체크포인트 저장 성공 시 / When: 로그 확인 / Then: `event="checkpoint_saved"`, `job_id`, `mapping_id`, `data_table`, `last_success_rid`, `stats.read`, `stats.written`, `stats.skipped_exists`, `stats.dropped_no_meta`, `updated_at` 필드가 모두 포함된 info 로그가 기록된다.
- Given: stage="write" 오류 발생 시 / When: 로그 확인 / Then: `stage`, `job_id`, `mapping_id`, `data_table`, `raw` 필드가 포함된 `level="error"` 로그가 기록된다.
- Given: `logging.level="error"` 설정 시 / When: info 레벨 이벤트 발생 / Then: 해당 로그가 출력되지 않는다.
- Given: SIGTERM 타임아웃으로 강제 종료 시 / When: 로그 확인 / Then: `level="warn"`이고 "shutdown timeout" 내용을 포함한 로그가 출력된다.
- Given: tag_id가 메타에 없어 drop될 때 / When: 로그 확인 / Then: `level="debug"` 로그에 drop된 row의 `tag_id`와 `_rid`가 기록된다.

---

## 6. 경계 조건 및 예외 시나리오

### 6.1 체크포인트 파일 상태별 처리

| 상태 | 처리 동작 |
|------|-----------|
| 파일 없음 | `exists=false`, `err=null` → start_mode 기준으로 시작점 결정 |
| 파일 있음, 파싱 성공, data_table 일치 | `exists=true`, cp 반환 → `cp.last_success_rid` 기준으로 시작 |
| 파일 있음, JSON 파싱 실패 | `exists=false`, `err=parseError` + stage="checkpoint_io" 오류 로그 → "없음"으로 취급, start_mode 적용 |
| 파일 있음, `source.data_table` 불일치 | `exists=false`, `err=corruptionError` + "data_table mismatch" 오류 로그 → "없음"으로 취급, start_mode 적용 |
| `.tmp` 파일만 남아 있음 | `.tmp` 파일 무시, `.json` 파일 기준으로 처리 (없으면 "없음"으로 취급) |

### 6.2 start_mode별 시작점 결정 (체크포인트 없음 시)

| start_mode | 시작점 결정 로직 | 엣지 케이스 |
|------------|-----------------|-------------|
| full | `start_rid = 0n` | 데이터 없어도 0n으로 시작, 즉시 빈 배열 반환 후 폴링 |
| now | `start_rid = SourceReader.getMaxRid()` | 빈 테이블이면 0n 반환, 이후 새 데이터부터 복제 |
| rid_after | `start_rid = mapping.source.rid_after` (BigInt) | rid_after가 실제 max_rid보다 크면 빈 배열 반환 후 폴링 |

**공통 규칙**: 체크포인트가 존재하면 start_mode는 무조건 무시된다 (고정 정책, 설정으로 변경 불가).

### 6.3 STARTUP_INTEGRITY 배치 전체 skip/drop 발생 시

- **발생 조건**: 배치 내 모든 row가 `skipped_exists` 또는 `dropped_no_meta`인 경우
- **처리**:
  1. `max_rid_in_batch = MAX(rows.rid)`
  2. `SAVE_CHECKPOINT(max_rid_in_batch + 1n)`
  3. `start_rid = max_rid_in_batch + 1n`
  4. 다음 배치 읽기 계속 (STARTUP_INTEGRITY 루프 유지)
- **배경**: 모든 row가 처리 완료(skip/drop)이므로 해당 구간은 안전하게 전진 가능. 전체 skip 배치에도 SAVE_CHECKPOINT가 호출되어 체크포인트가 전진함.

### 6.4 STEADY_REPLICATION all-drop 발생 시 (F-01)

- **발생 조건**: TAG 테이블에서 배치 내 모든 row가 `drop_not_found`로 처리된 경우 (`out_rows` 비어있음)
- **처리**:
  ```
  max_written_rid = 0n (write 호출 없음)
  effective_max = max_rid_in_batch  // fallback
  SAVE_CHECKPOINT(max_rid_in_batch + 1n)
  start_rid = max_rid_in_batch + 1n
  ```
- **판단 로직**: `max_written_rid > 0n`이면 `max_written_rid` 사용, 그렇지 않으면 `max_rid_in_batch` 사용.
- **이유**: write하지 않아도 배치는 "처리 완료"로 간주하여 체크포인트를 전진시킨다.

### 6.5 Graceful Shutdown 처리 (F-03)

| 시나리오 | 처리 동작 |
|----------|-----------|
| SIGTERM 수신, Worker들이 SLEEP 중 | `shutdown_requested=true` → 각 Worker가 SLEEP에서 즉시 깨어나 루프 탈출 → 체크포인트 저장 후 종료 |
| SIGTERM 수신, Worker가 배치 처리 중 | 현재 배치 완료 + 체크포인트 저장 후 루프 탈출 → 정상 종료 |
| `shutdown_timeout_ms` 이내 전체 종료 | 정상 종료 로그 출력 |
| `shutdown_timeout_ms` 초과, 일부 Worker 미종료 | `level="warn"` 경고 로그 + 강제 종료. 해당 Worker의 체크포인트는 마지막 저장 시점 기준 → 다음 재시작 시 중복 발생 가능 (at-least-once 허용 범위) |

### 6.6 Log 테이블 n:1 매핑 시도 시

- **발생 조건**: 동일한 `target.server + target.table`에 여러 Log 테이블 mapping이 설정된 경우
- **판정 시점**: F-DISC (F-JOB 초기화) 단계
- **처리**: 두 번째 이후 mapping은 설정 오류로 간주하여 스킵 + 오류 로그
- **오류 로그 내용**: `"Log 테이블은 1:1 매핑만 허용. mapping_id={id}, target={target.server}.{target.table}"`

### 6.7 Tag 테이블 컬럼 규칙 위반 시

- **발생 조건**: TAG(TYPE=6) 테이블에서:
  - 1번째 컬럼이 integer 계열 타입이 아닌 경우
  - 2번째 컬럼의 타입이 int64가 아닌 경우
  - 컬럼 수가 2개 미만인 경우
- **판정 시점**: F-DISC 단계 (CatalogClient.validateTagColumns)
- **처리**: 해당 mapping 즉시 스킵 + 오류 로그 (stage="catalog", mapping_id, 위반 컬럼 인덱스 및 실제 타입 포함)
- **재시도 없음**: 컬럼 규칙 위반은 재시도 불가 오류

### 6.8 체크포인트 저장 실패 처리 (F-02)

| `on_save_failure` | 처리 동작 |
|-------------------|-----------|
| `"continue"` (기본값) | `level="error"` 강조 로그 출력. Worker는 메모리 기준 `rid(effective_max + 1n)`로 다음 배치 계속 처리. 다음 재시작 시 이전 체크포인트 기준으로 시작하여 중복 증가 가능. |
| `"abort"` | 세부 동작 미정의(TODO). 현재 구현에서는 `"continue"`와 동일하게 동작 + TODO 경고 로그 출력. |

**공통**: 저장 실패 시에도 Worker 내부 `start_rid`는 정상 전진. 복제 루프는 계속된다 (`"continue"` 기준).

### 6.9 tag_id가 메타에 없을 때 (drop_not_found)

- **처리 흐름**:
  1. `resolveTagCanonical()` 반환: `{ canonical: null, status: "drop_not_found" }`
  2. 해당 row를 `out_rows`에 추가하지 않음
  3. `stats.dropped_no_meta` 증가
  4. 해당 row의 `_rid`는 `effective_max` 계산에 포함되어 체크포인트 전진에 반영됨 (all-drop fallback 규칙 F-01)
- **로그**: debug 레벨로 drop된 row의 `tag_id`와 `_rid`를 기록.

### 6.10 source.data_table과 체크포인트 파일명 불일치 시

- **발생 조건**: 체크포인트 JSON 내 `source.data_table` 값이 파일명(`{job_id}__{data_table}.json`)의 data_table 부분과 다른 경우
- **판정**: CheckpointStore.load() 내부에서 파싱 후 비교
- **처리**: 손상(corruption)으로 간주, `exists=false` 반환 + 오류 로그 (stage="checkpoint_io", "data_table mismatch")
- **이후**: "없음"으로 취급 → start_mode 기준으로 시작점 결정

---

## 7. 고정 정책 vs 설정 가능 항목

### 7.1 설정 파일에서 제어 가능한 항목

| 설정 경로 | 타입 | 기본값 | 설명 |
|-----------|------|--------|------|
| `job.shutdown_timeout_ms` | int | 30000 | Worker 종료 대기 타임아웃 (ms) (F-03) |
| `job.checkpoint.directory` | string | 필수 | 체크포인트 파일 저장 디렉토리 |
| `job.checkpoint.on_save_failure` | `"continue"\|"abort"` | `"continue"` | 체크포인트 저장 실패 정책 (F-02) |
| `job.integrity.enabled` | bool | 필수 | 재시작 정합성 유지 여부 |
| `job.integrity.mode` | `"existence_only"` | 필수 | 정합성 비교 방식 (현재 고정값이나 설정에 명시) |
| `job.retry.enabled` | bool | 필수 | 재시도 활성화 |
| `job.retry.strategy` | `"exponential"\|"linear"` | 필수 | 대기 증가 방식 |
| `job.retry.initial_delay_ms` | int | 필수 | 최초 재시도 대기 (ms) |
| `job.retry.max_delay_ms` | int | 필수 | 최대 재시도 대기 (ms) |
| `job.retry.multiplier` | float | 필수 | 지수 증가 계수 |
| `job.retry.jitter` | bool | 필수 | 랜덤 변동 적용 |
| `job.retry.max_attempts` | `int\|null` | `null` | 최대 재시도 횟수 (null=무한) |
| `job.execution_defaults.batch_size_records` | int | 5000 | 배치당 최대 레코드 수 (F-12) |
| `job.execution_defaults.poll_interval_ms` | int | 필수 | 폴링 주기 (ms) |
| `mapping.source.start_mode` | `"full"\|"now"\|"rid_after"` | 필수 | 최초 실행 시작 기준 |
| `mapping.source.rid_after` | `int\|null` | `null` | rid_after 모드 기준 rid |
| `mapping.source.tag_identifier.mode` | `"prefix"\|"suffix"\|"none"` | 필수 | tag name 식별자 방식 |
| `mapping.source.tag_identifier.value` | string | `""` | 적용 문자열 (구분자 포함) |
| `mapping.source.execution.batch_size_records` | int | — | source 레벨 override |
| `mapping.source.execution.poll_interval_ms` | int | — | source 레벨 override |
| `mapping.execution.batch_size_records` | int | — | mapping 레벨 override (최우선) |
| `mapping.execution.poll_interval_ms` | int | — | mapping 레벨 override (최우선) |
| `job.logging.level` | `"debug"\|"info"\|"warn"\|"error"` | 필수 | 로그 레벨 |
| `job.logging.log_dir` | string | 필수 | 로그 파일 저장 경로 |

### 7.2 고정 정책 (설정 파일에 노출되지 않음)

| 항목 | 고정값 | 설명 |
|------|--------|------|
| `max_inflight_batches` | 1 | 1 Worker당 동시 처리 배치 1개 |
| `single_instance_per_data_table` | true | 1 data_table = 1 Worker, 중복 실행 없음 |
| `atomic_write` | true | 체크포인트 파일은 항상 임시 파일 → rename |
| `skip_when_table_type_unsupported` | true | 미지원 TYPE은 mapping 단위로 스킵 |
| `config_hot_reload` | false | 설정 변경 시 프로세스 재시작 필요 |
| `integrity.mode` | `"existence_only"` | 정합성 비교는 tag_name+time 존재 여부만 확인 (현재 유일한 모드) |
| `tag_column_position` | 1번째=tag, 2번째=time | Tag 테이블 컬럼 규칙, 설정으로 변경 불가 |
| `startup_integrity_scope` | 재시작 직후 보정 구간만 | STEADY_REPLICATION에서는 존재 여부 검색 수행하지 않음 |

### 7.3 execution 옵션 필드 레벨 merge 규칙 (F-16)

각 execution 필드는 **독립적으로** 다음 우선순위를 따른다:

```
1순위: mapping.execution.{field}
2순위: source.execution.{field}
3순위: job.execution_defaults.{field}
```

예시:
- `mapping.execution.batch_size_records = 10000`이면 해당 필드는 10000
- `mapping.execution.poll_interval_ms`가 없고 `source.execution.poll_interval_ms = 200`이면 해당 필드는 200
- 두 필드 모두 mapping/source 레벨에 없으면 `execution_defaults` 값 사용

---

## 8. 테이블 타입별 동작 비교

| 항목 | Tag 테이블 (TYPE=6) | Log 테이블 (TYPE=0) |
|------|--------------------|--------------------|
| 논리/데이터 구조 | 논리 테이블 ≠ 데이터 테이블 (1:N) | 논리 테이블 = 데이터 테이블 (1:1) |
| data_table 목록 조회 | `V$STORAGE_TAG_TABLES`에서 조회 | `[source.table]` 1개 고정 |
| 컬럼 규칙 검증 | 1번째=tag id(integer), 2번째=time(int64) 검증 | 검증 없음 |
| 매핑 제한 | 1:1, 1:n, n:m 모두 허용 | 1:1만 허용 (n:1 금지) |
| tag_id → canonical 변환 | 수행 (resolveTagCanonical) | 수행하지 않음 |
| tag_identifier 적용 | 적용 (prefix/suffix/none) | 적용하지 않음 |
| STARTUP_INTEGRITY 수행 | 체크포인트 있고 integrity.enabled=true 시 수행 | 수행하지 않음 |
| 재시작 중복 방지 | 가능 (tag_name + time 존재 여부 확인) | 불가능 (의도적 허용) |
| 정합성 보장 수준 | at-least-once + 정합성 최대화 | at-least-once (중복 허용) |
| STEADY_REPLICATION row 처리 | tag_id → canonical 치환 후 write | 읽은 값 그대로 write |
| drop_not_found 처리 | tag_id 메타 없으면 row drop, cp 전진 | 해당 없음 |
| stats.skipped_exists 발생 | STARTUP_INTEGRITY에서만 발생 | 발생하지 않음 |
| checkpoint advance (all-drop) | `max_rid_in_batch + 1n` (fallback) | `max_written_rid + 1n` (drop 없음) |
| 메타 테이블 조회 | 필요 (_TAG_META에서 tag_id→tag_name) | 불필요 |

---

## 9. 구현 우선순위 및 Phase 구분

### Phase 1 — 독립 모듈

| 모듈 | 기능 ID | 완료 기준 |
|------|---------|-----------|
| ConfigLoader | F-CONF | YAML/JSON 파싱, 필수 필드 검증, execution 필드 레벨 merge, 기본값 주입 동작 확인 (DB 불필요) |
| CheckpointStore | F-CP | atomic write 읽기/쓰기 동작, 손상 감지, `on_save_failure` 분기 동작 확인 (DB 불필요) |
| RetryHandler | F-RETRY | exponential/linear 대기 시간 계산, jitter 적용, `max_attempts` 제한 동작 확인 |
| Logger | F-LOG | 구조화 로그 출력, 레벨 필터링 동작 확인 |

### Phase 2 — DB 연결 모듈

| 모듈 | 기능 ID | 완료 기준 | 주요 의존 |
|------|---------|-----------|-----------|
| CatalogClient | F-DISC | `M$SYS_TABLES` TYPE 조회, TAG 컬럼 규칙 검증, data_table 목록 반환 | F-CONF |
| SourceReader | F-READ | `_rid >= startRid` 배치 읽기, getMaxRid() 동작 | F-CONF, F-DISC |
| TagMetaProvider | F-META | tag_id→canonical 변환, prefix/suffix/none 적용, drop_not_found/retry_error 분류 | F-CONF, F-DISC |
| IntegrityChecker | F-INTG(일부) | `existsByTagAndTime()` 조회 동작 | F-CONF |
| TargetWriter | F-WRITE | Append 배치 쓰기, 스키마 불일치 처리 | F-CONF |

### Phase 3 — Worker 조합

| 모듈 | 기능 ID | 완료 기준 | 주요 의존 |
|------|---------|-----------|-----------|
| Worker | F-WORK, F-INTG | RESOLVE_START 시작점 결정, STARTUP_INTEGRITY, STEADY_REPLICATION, 체크포인트 갱신 | Phase 1+2 전체 |

### Phase 4 — 오케스트레이션

| 모듈 | 기능 ID | 완료 기준 | 주요 의존 |
|------|---------|-----------|-----------|
| JobRunner | F-JOB | Worker 병렬 실행, SIGTERM Graceful Shutdown, 타임아웃 강제 종료 | Phase 1~3 전체 |

### Phase별 완료 기준 상세

- **Phase 1 완료**: 설정 파싱, 체크포인트 read/write, retry 대기 계산이 DB 연결 없이 단위 테스트로 검증 가능.
- **Phase 2 완료**: 실제 소스/대상 DB에 연결하여 카탈로그 조회, 배치 읽기, tag 변환, 존재 여부 검색, Append 쓰기가 각각 독립 동작.
- **Phase 3 완료**: 단일 data_table에 대해 STARTUP_INTEGRITY + STEADY_REPLICATION 전체 흐름이 동작하고 체크포인트가 올바르게 갱신됨.
- **Phase 4 완료**: 여러 mapping/data_table에 대해 병렬 복제가 동작하고, SIGTERM 시 graceful 종료가 `shutdown_timeout_ms` 이내에 완료됨.

---

## 10. 비범위 및 향후 과제

| 항목 | 상태 | 비고 |
|------|------|------|
| 메타 정보 동기화 루틴 | 미정의 | 별도 설계 예정 |
| `on_save_failure: "abort"` 세부 동작 | TODO | 정책 결정 후 구현 |
| 상태 조회 API / Prometheus 메트릭 | Backlog | 1차는 구조화 로그로 대체 |
| Log 테이블 `_arrival_time` 전달 옵션 | Backlog | `log.include_arrival_time` (기본 false) |
| Log 테이블 tag_identifier 확장 | Backlog | `log.identifier_columns` |
| Log 테이블 재시작 정합성 옵션 | Backlog | `log.integrity.key_columns` |
