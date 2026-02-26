# 통합 테스트 결과 문서

**실행 환경**: 192.168.1.189:5656 (Machbase DBMS)
**인증**: SYS / MANAGER
**총 결과**: 20 pass / 0 fail (cleanup 테스트 제외 시 실질 17개)

---

## 실행 방법

```bash
# TAG 테이블 통합 테스트 (8 pass)
node --test tests/integration/tag_table.test.js

# LOG 테이블 통합 테스트 (10 pass)
node --test tests/integration/log_table.test.js

# LOG 스키마 변형 통합 테스트 (5 pass)
node --test tests/integration/log_schema.test.js
```

---

## TAG 테이블 통합 테스트 (`tag_table.test.js`)

TAG 테이블은 Machbase의 시계열 특화 구조로, 논리 테이블(`TAG`) 아래 `_DATA_0` ~ `_DATA_N` 파티션이 존재한다. 각 테스트는 파티션 전체를 순회하며 Worker를 실행한다.

### 전제 조건

- TAG 테이블 구조: `(name VARCHAR PK, time DATETIME BASETIME, value DOUBLE SUMMARIZED)`
- Additional column: DATA 파티션에 함께 저장되는 추가 측정값
- Metadata column: `_TAG_META` 에 저장되는 정적 설명 정보
- 테스트 시작 시 `REPLI_TAG_` 접두어 잔여 테이블 일괄 삭제

### cleanup

이전 테스트 실행에서 남은 `REPLI_TAG_*` 테이블을 삭제한다.
`M$SYS_TABLES`에서 패턴 조회 후 `DROP TABLE` 실행.

---

### IT-TAG-01: 동일 스키마 TAG → TAG 복제

**목적**: 가장 기본적인 복제 시나리오 검증.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name, time, value)` |
| DST 스키마 | `(name, time, value)` |
| 삽입 데이터 | sensor_a=1.1, sensor_b=2.2, sensor_c=3.3 (각 파티션에 분산) |
| `start_mode` | full |
| `integrity.enabled` | false |

**동작 흐름**

1. Worker가 각 파티션(`_DATA_0`, `_DATA_1`, `_DATA_2`, `_DATA_3`)을 순차 처리
2. RESOLVE_START: cp 없음 → start_rid = 0
3. STEADY_REPLICATION: `readAfterRid(0)` → `resolveTagCanonical()` → `writer.append()`
4. 각 파티션에 cp 저장 (`last_success_rid=0`, `rows_read=1`, `rows_written=1`)

**검증**

- DST에 3행 복제됨 (name / value 일치)
- 각 파티션 cp 파일 존재, `last_success_rid >= 0`

**결과**: PASS

---

### IT-TAG-02: SRC에 additional column 존재, DST에는 없음

**목적**: 소스에만 있는 additional column은 대상에 복제되지 않음을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name, time, value, quality DOUBLE)` |
| DST 스키마 | `(name, time, value)` |
| 삽입 데이터 | temp_sensor=25.5/quality=0.99, press_sensor=101.3/quality=0.95 |

**동작 흐름**

- Reader가 소스에서 `_RID, NAME, TIME, VALUE, QUALITY` 컬럼을 읽음
- Writer의 `appendColumns`는 DST 기준(`NAME, TIME, VALUE`)으로 구성
- DST에 없는 `QUALITY`는 column mapping 시 자동 무시됨

**검증**

- DST에 2행 복제됨
- `temp_sensor.value=25.5`, `press_sensor.value=101.3` 일치
- DST에 QUALITY 컬럼 없음 → 에러 없이 정상 처리

**결과**: PASS

---

### IT-TAG-03: DST에 additional column 존재, SRC에는 없음

**목적**: 대상에만 있는 additional column에 `safeNull` 패딩이 적용됨을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name, time, value)` |
| DST 스키마 | `(name, time, value, temperature DOUBLE)` |
| 삽입 데이터 | motor_rpm=3200.0, motor_temp=85.0 |

**동작 흐름**

- Writer가 `open()` 시 DST 스키마 기준으로 `appendColumns` 구성
- `temperature` 컬럼: SRC에 없으므로 `ColumnType.safeNull(type=20/DOUBLE)` → `0.0` 패딩
- append 시 `[canonical, timeNs, value, 0.0]` 형식으로 전송

**검증**

- DST에 2행 복제됨
- `motor_rpm.value=3200.0`, `motor_temp.value=85.0` 일치
- `motor_rpm.temperature=0`, `motor_temp.temperature=0` (safeNull)

**결과**: PASS

---

### IT-TAG-04: additional column 컬럼명·타입 모두 불일치

**목적**: 양쪽 additional column이 이름과 타입이 달라도 공통 컬럼만 복제됨을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name, time, value, quality DOUBLE)` |
| DST 스키마 | `(name, time, value, status VARCHAR(32))` |
| 삽입 데이터 | valve_pos=45.0/quality=0.88, flow_rate=120.5/quality=0.92 |

**동작 흐름**

- `QUALITY` (SRC-only) → Writer의 column mapping에서 제외
- `STATUS` (DST-only) → `ColumnType.safeNull(type=5/VARCHAR)` → `''` 패딩

**검증**

- DST에 2행 복제됨
- `valve_pos.value=45.0`, `flow_rate.value=120.5` 일치
- `valve_pos.status=''`, `flow_rate.status=''` (safeNull 빈 문자열)

**결과**: PASS

---

### IT-TAG-05: SRC에 metadata column 존재, DST에는 없음

**목적**: metadata column은 `_TAG_META`에만 저장되므로 DATA 파티션 복제에 영향 없음을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name, time, value) METADATA (location VARCHAR(50))` |
| DST 스키마 | `(name, time, value)` |
| 삽입 데이터 | building_temp=22.5, outdoor_temp=18.3 (metadata: 'Building A', 'Rooftop') |

**동작 흐름**

- Reader가 DATA 파티션에서만 읽음 (`_TAG_META`의 `location`은 SELECT 대상 아님)
- Writer의 DST 스키마: `NAME, TIME, VALUE`만 존재
- metadata column은 복제 대상 외 (별도 metadata 복제 미구현)

**검증**

- DST에 2행 복제됨
- `building_temp.value=22.5`, `outdoor_temp.value=18.3` 일치

**결과**: PASS

---

### IT-TAG-06: DST에 metadata column 존재, SRC에는 없음

**목적**: DST의 metadata column 유무가 DATA 파티션 append에 영향 없음을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name, time, value)` |
| DST 스키마 | `(name, time, value) METADATA (sensor_type VARCHAR(20))` |
| 삽입 데이터 | vibration_1=0.42, vibration_2=0.37 |

**동작 흐름**

- Writer의 `appendOpen`은 DATA 파티션 대상이므로 DST의 `sensor_type`(metadata)은 appendColumns에 포함되지 않음
- metadata column은 `TableInfo.buildTag()` 내에서 `_TAG_META` 컬럼으로 분류되어 appendColumns에서 제외됨

**검증**

- DST에 2행 복제됨
- `vibration_1.value=0.42`, `vibration_2.value=0.37` 일치

**결과**: PASS

---

### IT-TAG-07: metadata column 타입 불일치

**목적**: 양쪽 metadata column의 타입이 달라도 DATA 파티션 복제에 영향 없음을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name, time, value) METADATA (location VARCHAR(50))` |
| DST 스키마 | `(name, time, value) METADATA (location INTEGER)` |
| 삽입 데이터 | pump_a=55.5, pump_b=66.6 (SRC location: 'Zone-1', 'Zone-2') |

**동작 흐름**

- metadata column은 appendStream 대상이 아님 → 타입 불일치는 복제 과정에 영향 없음
- DST metadata 컬럼에 값을 넣지 않으므로 DST location은 NULL/0 상태

**검증**

- DST에 2행 복제됨
- `pump_a.value=55.5`, `pump_b.value=66.6` 일치

**결과**: PASS

---

## LOG 테이블 통합 테스트 (`log_table.test.js`)

LOG 테이블은 Machbase의 일반 시계열 테이블로, 단일 물리 테이블 구조이다.
TAG 테이블과 달리 파티션이 없으며, `_RID`가 자동 할당된다.

### 전제 조건

- LOG 테이블 구조: `(name VARCHAR(64), time DATETIME, value DOUBLE)`
- 테스트 시작 시 `REPLI_LOG_` 접두어 잔여 테이블 일괄 삭제

### cleanup

이전 테스트 실행에서 남은 `REPLI_LOG_*` 테이블을 삭제한다.

---

### IT-LOG-01: LOG 테이블 생성 확인 + Reader 읽기

**목적**: LOG 테이블의 기본 생성/조회 기능 및 Reader 동작을 검증하는 선행 테스트.

**서브테스트 4개**

#### 1. M$SYS_TABLES에 TYPE=0(LOG)으로 등록됨

- `SELECT NAME, TYPE FROM M$SYS_TABLES WHERE NAME = ?`
- LOG 테이블 TYPE 코드 = 0
- **결과**: PASS

#### 2. conn.getTableType → LOG 반환

- `MachbaseClient.getTableType(tableName)` 호출
- 반환값 `type = 'LOG'`
- **결과**: PASS

#### 3. Reader.readAfterRid로 삽입한 3행 읽기

- `TableInfo.buildLog()` → `new Reader(tableInfo, conn, table)` → `readAfterRid(0n, 100)`
- 반환 구조: `{ rid: BigInt, tagId: string, data: { TIME, VALUE } }`
- 3행의 name(sensor_a, sensor_b, sensor_c) 모두 존재 확인
- **결과**: PASS

#### 4. reader.getMaxRid → 삽입한 최대 RID 반환

- `reader.getMaxRid()` → `{ maxRid: BigInt, err: null }`
- 3행 삽입 후 `maxRid >= 2n`
- **결과**: PASS

---

### IT-LOG-02: LOG → LOG 복제 (runDataTableWorker)

**목적**: `runDataTableWorker`를 통한 LOG 테이블 전체 복제 및 체크포인트 저장 검증.

**설정**

| 항목 | 내용 |
|------|------|
| 삽입 데이터 | machine_temp=72.5, machine_rpm=3200.0, machine_vibr=0.42 |
| `start_mode` | full |
| shutdown timeout | 5000ms |

**서브테스트 2개**

#### 1. 소스 LOG 3행이 대상에 그대로 복제되고 cp가 저장됨

**동작 흐름**

```
start_mode=full → start_rid=0
STEADY_REPLICATION start, start_rid=0
readAfterRid(0) → 3행 읽기 → append → cp 저장
checkpoint_saved: last_success_rid=2, rows_read=3, rows_written=3
```

**검증**

- DST에 3행: value 각각 일치
- cp 파일 존재, `last_success_rid > 0`

**결과**: PASS

#### 2. LOG 테이블은 integrity.enabled=true여도 STARTUP_INTEGRITY 미수행

- 동일 jobId로 재실행 → cp 존재 → `resume from checkpoint, start_rid=3`
- `integrity.enabled=true`이지만 tableType=LOG이므로 STARTUP_INTEGRITY 단계 스킵
- console.log 캡처로 `STARTUP_INTEGRITY` 문자열 미등장 확인

**결과**: PASS

---

### IT-LOG-03: start_mode=full — RID 0부터 전체 복제

**목적**: cp가 없을 때 `start_mode=full`이 RID 0부터 전체를 복제함을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| 삽입 데이터 | full_a=10.0, full_b=20.0 |
| `start_mode` | full |
| cp 상태 | 없음 (신규 tmpDir) |

**동작 흐름**

```
start_mode=full, start_rid=0
STEADY_REPLICATION start, start_rid=0
checkpoint_saved: last_success_rid=1, rows_read=2, rows_written=2
```

**검증**

- DST에 2행: full_a=10.0, full_b=20.0

**결과**: PASS

---

### IT-LOG-04: start_mode=now — 기존 데이터 복제 안 함

**목적**: `start_mode=now`가 현재 시점 이전 데이터를 복제하지 않음을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| 삽입 데이터 | old_data=99.0, old_data2=88.0 (워커 시작 전 삽입) |
| `start_mode` | now |
| cp 상태 | 없음 |

**동작 흐름**

```
start_mode=now → getMaxRid() 호출 → start_rid=2 (삽입된 2행의 마지막 RID)
STEADY_REPLICATION start, start_rid=2 (= 기존 데이터 이후부터)
새 데이터 없음 → shutdown timeout 후 종료
```

**검증**

- DST에 old_data, old_data2 없음
- `start_mode=now` + 새 데이터 없음 → cp 미저장 (정상)

**결과**: PASS

---

### IT-LOG-05: cp 존재 재시작 — cp 이후 데이터만 복제

**목적**: 재시작 시 저장된 cp를 이어받아 중복 없이 새 데이터만 복제함을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| 1차 데이터 | batch1_a=1.0, batch1_b=2.0 |
| 2차 데이터 | batch2_a=3.0 (1차 복제 후 추가) |

**동작 흐름**

```
[1차 실행]
start_mode=full, start_rid=0
checkpoint_saved: last_success_rid=1, rows_read=2, rows_written=2

[2차 실행]
resume from checkpoint, start_rid=2
STEADY_REPLICATION start, start_rid=2
checkpoint_saved: last_success_rid=2, rows_read=1, rows_written=1
```

**검증**

- DST 총 3행 (batch1_a, batch1_b, batch2_a)
- 1차 cp.last_success_rid < 2차 cp.last_success_rid

**결과**: PASS

---

## LOG 스키마 변형 통합 테스트 (`log_schema.test.js`)

LOG 테이블에서 소스/대상 컬럼 구성이 다를 때 동작을 검증한다.

### 전제 조건

- 테스트 시작 시 `REPLI_LOGS_` 접두어 잔여 테이블 일괄 삭제

### cleanup

이전 테스트 실행에서 남은 `REPLI_LOGS_*` 테이블을 삭제한다.

---

### IT-LOG-SAME: 동일 스키마 LOG → LOG 복제

**목적**: 기준선. 동일 스키마에서 정확히 복제됨을 확인.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name VARCHAR(64), time DATETIME, value DOUBLE)` |
| DST 스키마 | `(name VARCHAR(64), time DATETIME, value DOUBLE)` |
| 삽입 데이터 | sensor_a=1.1, sensor_b=2.2, sensor_c=3.3 |

**동작 흐름**

```
start_rid=0
checkpoint_saved: last_success_rid=2, rows_read=3, rows_written=3
```

**검증**

- DST에 3행, 각 value 일치

**결과**: PASS

---

### IT-LOG-SRC-EXTRA: 소스에 추가 컬럼 (quality DOUBLE) — 대상 무시

**목적**: 소스 추가 컬럼은 대상 column mapping에서 자동 제외됨을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name, time, value, quality DOUBLE)` |
| DST 스키마 | `(name, time, value)` |
| 삽입 데이터 | sensor_a=10.0/quality=0.95, sensor_b=20.0/quality=0.87, sensor_c=30.0/quality=0.99 |

**동작 흐름**

- Reader가 SRC에서 `_RID, NAME, TIME, VALUE, QUALITY` 읽음
- Writer.appendColumns = DST 기준 `[NAME, TIME, VALUE]`
- QUALITY는 DST column map에 없으므로 row 조립 시 제외

**검증**

- DST에 3행 복제, value 일치
- QUALITY 컬럼 없는 DST에 에러 없이 처리

**결과**: PASS

---

### IT-LOG-DST-EXTRA: 대상에 추가 컬럼 (status VARCHAR) — null 패딩

**목적**: 대상에만 있는 추가 컬럼에 `safeNull` 패딩이 적용됨을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name, time, value)` |
| DST 스키마 | `(name, time, value, status VARCHAR(32))` |
| 삽입 데이터 | machine_a=100.0, machine_b=200.0 |

**동작 흐름**

- Writer.appendColumns = `[NAME, TIME, VALUE, STATUS]`
- SRC에 `STATUS` 없음 → `ColumnType.safeNull(type=5/VARCHAR)` → `''`
- append 시 `[name, timeNs, value, '']` 전송

**검증**

- DST에 2행: value 일치
- `machine_a.status=''`, `machine_b.status=''`

**결과**: PASS

---

### IT-LOG-DIFF-SCHEMA: 소스/대상 서로 다른 추가 컬럼 + 타입 불일치

**목적**: 추가 컬럼이 이름과 타입 모두 다를 때 SRC 전용 컬럼은 무시되고 DST 전용 컬럼은 null 패딩됨을 검증.

**설정**

| 항목 | 내용 |
|------|------|
| SRC 스키마 | `(name, time, value, quality DOUBLE)` |
| DST 스키마 | `(name, time, value, status VARCHAR(32))` |
| 삽입 데이터 | pump_a=55.5/quality=0.9, pump_b=66.6/quality=0.8 |

**동작 흐름**

- Writer.appendColumns = `[NAME, TIME, VALUE, STATUS]` (DST 기준)
- Reader row에 `QUALITY` 있지만 DST column map에 없음 → 제외
- `STATUS` DST-only → `safeNull(VARCHAR)` → `''`

**검증**

- DST에 2행: value 일치
- `pump_a.status=''`, `pump_b.status=''`

**결과**: PASS

---

## 전체 결과 요약

| 파일 | 케이스 | 서브테스트 | 결과 |
|------|--------|-----------|------|
| `tag_table.test.js` | cleanup + IT-TAG-01 ~ 07 | 8 | 8 pass |
| `log_table.test.js` | cleanup + IT-LOG-01(4개) + IT-LOG-02(2개) + IT-LOG-03~05 | 10 | 10 pass |
| `log_schema.test.js` | cleanup + IT-LOG-SAME + IT-LOG-SRC-EXTRA + IT-LOG-DST-EXTRA + IT-LOG-DIFF-SCHEMA | 5 | 5 pass |
| **합계** | | **23** | **23 pass / 0 fail** |

---

## 핵심 검증 항목 요약

| 검증 항목 | 관련 테스트 |
|-----------|------------|
| 기본 TAG/LOG 복제 (동일 스키마) | IT-TAG-01, IT-LOG-02, IT-LOG-SAME |
| SRC-only 추가 컬럼 무시 | IT-TAG-02, IT-LOG-SRC-EXTRA |
| DST-only 추가 컬럼 safeNull 패딩 (DOUBLE → 0.0) | IT-TAG-03 |
| DST-only 추가 컬럼 safeNull 패딩 (VARCHAR → '') | IT-TAG-04, IT-TAG-06, IT-LOG-DST-EXTRA, IT-LOG-DIFF-SCHEMA |
| SRC metadata column 복제에 무영향 | IT-TAG-05 |
| DST metadata column appendStream에 무영향 | IT-TAG-06, IT-TAG-07 |
| LOG 테이블 타입 코드 확인 (TYPE=0) | IT-LOG-01 |
| Reader.readAfterRid / getMaxRid 동작 | IT-LOG-01 |
| `start_mode=full` → RID 0부터 전체 복제 | IT-LOG-03 |
| `start_mode=now` → 기존 데이터 제외 | IT-LOG-04 |
| cp 재시작 → 증분 복제 | IT-LOG-05 |
| LOG 테이블 STARTUP_INTEGRITY 미수행 | IT-LOG-02 |
