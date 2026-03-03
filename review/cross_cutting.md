# 클래스 간 상호작용 리뷰

작성일: 2026-02-26

클래스별 개별 리뷰(`01_file.md` ~ `11_job_runner.md`)를 기반으로, 코드를 다시 읽고
클래스 경계를 넘나드는 인터페이스 계약, 데이터 흐름, 일관성 문제를 분석한 문서.

---

## 1. 설정 키 불일치: ConfigLoader ↔ RetryHandler

**심각도: 높음 (버그)**

`config.json`과 ConfigLoader가 정의하는 retry 설정 키명이 `RetryHandler` 생성자가 읽는 키명과 다르다.

### 흐름 추적

```
config.json
  retry: { base_delay_ms: 100, max_delay_ms: 30000, max_attempts: 5 }
          ↓
ConfigLoader._processMapping()
  r.initial_delay_ms 검증  ← 검증 키도 initial_delay_ms (config.json엔 없음)
  execution.retry 그대로 반환
          ↓
worker.js L136
  const retry = new RetryHandler(exec.retry || {});
          ↓
RetryHandler 생성자 L23
  this.initialDelayMs = config.initial_delay_ms ?? 1000;  ← base_delay_ms를 읽지 않음
```

**결과**: `config.json`에 `base_delay_ms: 100`을 설정해도 `RetryHandler`는 항상 기본값 1000ms를 사용. retry delay가 의도한 것보다 10배 길어질 수 있음.

**추가**: ConfigLoader의 검증 코드(`r.initial_delay_ms`)도 `initial_delay_ms`를 보고 있으므로, 사용자가 `base_delay_ms`를 써도 검증도 통과하고 실제 적용도 안 되는 이중 무시가 발생한다.

---

## 2. TableInfo 공유: JobRunner → Reader × N

**심각도: 중간 (동시성 주의)**

`_runMapping()`에서 `srcTableInfo`를 한 번 만들고, 모든 파티션 Worker의 `Reader`가 이를 공유한다.

```js
// job_runner.js L59
srcTableInfo = await TableInfo.buildTag(sourceConn, mapping.source.table, tables[0].table_id);

// job_runner.js L112 (dataTables.map 안에서, 파티션마다 반복)
const wReader = new Reader(srcTableInfo, wSrcConn, dataTable);
```

`TableInfo`의 `aliasMap`은 `Map<bigint, string>` 인스턴스이고, Worker들이 `resolveTagCanonical()`에서 이를 동시에 읽고 쓴다.

```js
// table_info.js L194
this.aliasMap.set(tagIdBig, tagName);  // 캐시 miss 시 쓰기
```

Node.js는 단일 스레드이므로 실제 레이스 컨디션은 없다. 단, 파티션 _DATA_0의 Worker가 `aliasMap`에 tag_id를 쓰는 시점과 _DATA_1의 Worker가 같은 key를 조회하는 시점이 이벤트 루프 순서에 따라 달라질 수 있다. 이로 인해 _DATA_1이 캐시 hit을 할 수도 있고 miss → DB 조회를 할 수도 있는데, 두 경우 모두 결과는 동일하므로 정확성에는 문제없다. 다만 이 공유가 의도적 최적화인지 우연인지 주석이 없다.

**실질적 위험**: 없음. 하지만 `aliasMap`이 공유됨을 명시해두지 않으면, 이후 유지보수 시 Worker를 별도 스레드(worker_threads)로 이전할 때 레이스 컨디션이 생길 수 있다.

---

## 3. dstTableInfo 공유: JobRunner → Writer × N

**심각도: 중간 (동시성 주의)**

`dstTableInfo`도 동일하게 공유된다.

```js
// job_runner.js L71
dstTableInfo = await TableInfo.buildTag(tmpDstConn, mapping.target.table, dstTables[0].table_id);

// job_runner.js L113 (파티션마다 반복)
const wWriter = new Writer(dstTableInfo);
```

`Writer.open()`에서 `dstTableInfo.writeColumns`를 읽어 `appendColumns`를 구성한다(읽기 전용). `dstTableInfo`에는 `aliasMap`이 있지만 Writer는 이를 사용하지 않는다. `writeColumns`는 빌드 이후 변경되지 않는다.

**결론**: 현재는 안전하나 역시 공유 사실이 코드에 명시되어 있지 않다.

---

## 4. row.data 키 케이스: Reader → Worker → Writer 암묵적 계약

**심각도: 중간 (잠재 버그)**

Reader, Worker, Writer 사이에 "컬럼명은 UPPERCASE"라는 계약이 존재하지만 어디에도 명시되어 있지 않다.

### 흐름

```
reader.js L93~94
  data[col.toUpperCase()] = row[col];   ← UPPERCASE로 저장
          ↓
worker.js L351
  outRows.push({ NAME: canonical, ...row.data });
                ↑ UPPERCASE          ↑ UPPERCASE keys
          ↓
writer.js L66
  const val = row[col.name];  ← col.name이 UPPERCASE임을 전제
```

`col.name`은 `dstTableInfo.writeColumns[i].name`에서 오는데, 이 값은 `M$SYS_COLUMNS.NAME`에서 읽어온 값이다. Machbase가 컬럼명을 대문자로 반환한다는 전제가 있다.

**위험 시나리오**: `row.data`에 `NAME` 키가 포함된다면(reader.js의 extraCols에 'name'이 필터링되지 않는 경우), `{ NAME: canonical, ...row.data }` 전개 시 row.data의 `NAME`이 canonical을 덮어쓴다.

현재 reader.js L64에서 `columnNames.filter(c => c.toLowerCase() !== 'name')`으로 name을 걸러내므로 발생하지 않는다. 하지만 이 방어 코드가 없어지거나 실수가 생기면 조용히 wrong data가 입력된다. writer.js는 `col.name`으로 row 객체를 lookup하므로, row에 잘못된 NAME이 들어오면 감지 못하고 그대로 append된다.

---

## 5. 체크포인트 RID의 +1n/-1n 경계: CheckpointStore ↔ Worker

**심각도: 낮음 (혼란 가능성)**

RID 저장/로드 경계 처리가 두 곳에 분산되어 있다.

### STEADY_REPLICATION 경로

```
worker.js L378~384
  checkpointStore.save(..., { last_success_rid: effectiveMax })  ← 마지막 성공 RID (inclusive)
  startRid = effectiveMax + 1n                                   ← 로컬 업데이트

재시작 시:
  checkpoint.js L52: { cp: data.checkpoint }
  worker.js L150: startRid = cp.last_success_rid + 1n           ← 재개 RID 계산
```

### STARTUP_INTEGRITY 경로

```
worker.js L263~269
  safeCpRid = firstMissRid - 1n
  checkpointStore.save(..., { last_success_rid: safeCpRid })    ← firstMissRid - 1n 저장
  startRid = firstMissRid                                        ← 로컬은 그대로

재시작 시:
  cp.last_success_rid = safeCpRid = firstMissRid - 1n
  startRid = safeCpRid + 1n = firstMissRid                      ← 의도와 일치
```

두 경로 모두 올바르게 동작한다. 그러나 "cp에는 항상 inclusive RID를 저장하고, 읽을 때 +1n"이라는 불변식이 코드 어디에도 한 곳에 명시되어 있지 않다. STARTUP_INTEGRITY에서 `safeCpRid = firstMissRid - 1n`을 저장하는 이유가 STEADY의 `+1n` 로드 규칙과 맞추기 위함인데, 이 연결 관계를 모르면 코드를 보는 사람이 왜 `-1n`을 저장하는지 이해하기 어렵다.

---

## 6. 체크포인트 저장 실패(on_save_failure)의 일관성: CheckpointStore ↔ Worker

**심각도: 낮음 (설계 일관성)**

`on_save_failure='abort'`이면 `checkpointStore.save()`가 throw하도록 설계되어 있다.

```js
// checkpoint.js L103
if (opts?.on_save_failure === 'abort') throw err;
```

Worker에서 `checkpointStore.save()`를 호출하는 곳은 세 군데다.

```js
// STARTUP_INTEGRITY: miss 발견 시
await checkpointStore.save(..., { on_save_failure: exec.on_save_failure });

// STARTUP_INTEGRITY: 배치 전체 확인 시
await checkpointStore.save(..., { on_save_failure: exec.on_save_failure });

// STEADY_REPLICATION
await checkpointStore.save(..., { on_save_failure: exec.on_save_failure });
```

세 곳 모두 `await`만 하고 반환값(Error|null)을 사용하지 않는다. `on_save_failure='continue'`이면 err를 반환하지만 Worker는 이를 무시하고 계속 진행한다. `on_save_failure='abort'`이면 throw가 되는데, Worker에서 이를 catch하는 코드가 없으므로 `runDataTableWorker()` Promise 자체가 reject된다. JobRunner의 `.catch()`가 이를 잡아서 로그만 남기고 Worker를 조용히 종료한다.

이 동작이 CLAUDE.md의 "on_save_failure='abort' 미구현"과 일치한다. `abort`의 실제 의도가 "Worker만 중단"인지 "프로세스 종료"인지 명확하지 않다.

---

## 7. STARTUP_INTEGRITY의 IntegrityChecker 연결 생성 방식

**심각도: 중간 (일관성 결여)**

Worker는 STARTUP_INTEGRITY에서 매 배치마다 `new MachbaseClient(dstConfig)`로 신규 연결을 생성한다.

```js
// worker.js L197
const intConn = new MachbaseClient(dstConfig);
```

이 연결은 `batchExists()` 호출 후 `finally` 블록에서 즉시 close된다. 이는 ts-client의 statement ID 한도(1024)를 피하기 위한 설계다.

**반면** STEADY의 Writer는 처음 `open()` 시 연결을 받아 mapping 전체 생명주기 동안 유지하면서, Reader는 900 쿼리마다 `refreshConnection()`으로 교체한다.

두 가지 다른 전략이 혼재한다:
- STARTUP_INTEGRITY: 배치마다 신규 연결
- STEADY: 연결 유지 + 900 쿼리 임계치 교체

INTEGRITY에서 배치마다 연결을 새로 만드는 것은 연결 오버헤드가 있지만, INTEGRITY 구간이 상대적으로 짧아 실용상 문제없다. 단, 이 설계 결정이 주석으로만 설명되어 있고 일관된 문서가 없다.

---

## 8. srcTableInfo의 첫 번째 파티션 대표성: JobRunner → TableInfo → Reader × N

**심각도: 중간 (잠재 버그)**

TAG 테이블의 srcTableInfo는 **첫 번째 파티션(`tables[0].table_id`)** 기준으로 컬럼 정보를 빌드한다.

```js
// job_runner.js L59
srcTableInfo = await TableInfo.buildTag(sourceConn, mapping.source.table, tables[0].table_id);
```

이 TableInfo는 모든 파티션 Worker의 Reader에 공유된다.

```js
// reader.js L58
const columnNames = this.tableInfo.getSelectColumnNames();
```

`_TAG_DATA_0`의 컬럼 구조가 `_TAG_DATA_1`, `_TAG_DATA_2`와 항상 동일하다는 전제가 있다. 실제로 TAG 데이터 파티션은 논리 테이블과 동일한 스키마를 공유하므로 이 전제는 올바르다. 하지만 이 전제가 코드에 명시되어 있지 않아, 처음 코드를 보는 사람이 왜 첫 번째 파티션으로만 빌드하는지 이해하기 어렵다.

---

## 9. getTableType 오류 시 silent skip: MachbaseClient → JobRunner → ConfigLoader

**심각도: 중간 (운영 위험)**

`MachbaseClient.getTableType()`은 DB 연결 오류와 테이블 미존재를 모두 `{ type: 'UNSUPPORTED' }`로 반환한다.

```js
// machbase.js L143~146
} catch (err) {
  console.error(JSON.stringify({ ... msg: `getTableType DB error: ${err.message}` }));
  return { type: 'UNSUPPORTED' };
}
```

JobRunner는 이를 받아 mapping을 skip한다.

```js
// job_runner.js L43~47
if (tableType === 'UNSUPPORTED') {
  console.error(...);
  await sourceConn.close().catch(() => {});
  return;
}
```

**문제**: DB 연결은 성공했지만 쿼리가 실패한 경우(일시적 네트워크 오류, DB 과부하 등)도 mapping이 영구 skip된다. ConfigLoader에서 retry 설정을 검증하고, Worker에서 retry를 사용하는데, 정작 시작 단계의 catalog 조회는 retry 없이 즉시 skip한다.

---

## 10. Writer.append의 BigInt 변환: ColumnType ↔ Writer ↔ Reader 데이터 타입 흐름

**심각도: 높음 (버그)**

Reader에서 쿼리 결과를 받으면 `TIME` 컬럼(DATETIME, type code 6)은 `@machbase/ts-client`가 `BigInt`로 반환한다.

```
machbase/machbase.js:
  fixDoubleEndian()은 number 타입만 처리 → BigInt는 통과

reader.js L94:
  data[col.toUpperCase()] = row[col];  ← TIME은 BigInt 그대로

worker.js L351:
  outRows.push({ NAME: canonical, ...row.data });  ← TIME: BigInt

writer.js L68~69:
  if (col.columnType.type === 'int64') {
    return typeof val === 'bigint' ? val : BigInt(Math.trunc(Number(val)));
  }
```

DATETIME은 `ColumnType.DATETIME.type = 'int64'`이므로 이 분기를 탄다. `typeof val === 'bigint'`이면 그대로 반환하므로 BigInt → BigInt 경로는 안전하다.

그러나 만약 어떤 경로에서 TIME이 number로 들어온다면(예: `fixDoubleEndian`이 TIME 값을 건드리지 않더라도 다른 코드 경로에서 변환이 일어난다면), `BigInt(Math.trunc(Number(val)))` 경로가 실행되고 `Number(val)`에서 정밀도 손실이 발생할 수 있다.

실제로 TIME은 nanosecond 단위 UNIX timestamp이다. 예를 들어 현재 시각 `2026-02-26`의 nanosecond 타임스탬프는 대략 `1_740_000_000_000_000_000n`으로 `2^53(9_007_199_254_740_992)`을 훨씬 초과한다. 이 값이 number로 변환되면 정밀도 손실이 발생한다.

현재 ts-client는 TIME을 BigInt로 반환하므로 실제로 number 경로를 타지 않는다. 하지만 이 안전성이 라이브러리 구현 세부사항에 의존하고 있어, 라이브러리 버전이 바뀌거나 다른 DATETIME 소스가 추가되면 조용히 데이터가 손상될 수 있다.

---

## 11. listTagDataTables의 NUMBER 변환: MachbaseClient → JobRunner → TableInfo

**심각도: 낮음 (잠재 버그)**

```js
// machbase.js L158
return (rows || []).map(r => ({ data_table: r.data_table, table_id: Number(r.table_id) }));
```

`table_id`가 `M$SYS_TABLES.ID`에서 오는 ulong(type code 112)이라면, ts-client는 이를 BigInt로 반환할 수 있다. `Number(BigInt)` 변환은 `2^53` 이하라면 정확하다. 실제 table_id가 그 범위를 넘을 가능성은 없지만, 변환의 이유(SQL에서 BigInt로 왔기 때문에 Number로 변환)가 명시되어 있지 않다.

`TableInfo.buildTag()`에서 `dataTableId`를 SQL 파라미터로 `conn.query(dataSql, [dataTableId])`에 넘길 때 Number 타입으로 넘어가는데, ts-client가 Number vs BigInt 파라미터를 어떻게 처리하는지에 따라 동작이 달라질 수 있다.

---

## 12. stmtCount 추적 범위의 불완전성: Worker ↔ Reader

**심각도: 낮음 (잠재 누락)**

Worker는 STEADY에서 `stmtCount`를 추적하여 900 도달 시 `reader.refreshConnection()`을 호출한다.

```js
// worker.js L327
stmtCount += 2;  // MAX(_RID) + SELECT
```

그런데 `_resolveCanonical()` 내부에서 캐시 miss 시 `reader.resolveTagCanonical()`이 추가 쿼리를 실행한다.

```js
// table_info.js L188~189
const sql = `SELECT name FROM _${this.logicalTable}_META WHERE _ID = ?`;
const rows = await conn.query(sql, [tagId]);
```

이 쿼리는 `stmtCount`에 반영되지 않는다. 태그 수가 많아서 캐시 miss가 빈번하다면, 실제 statement 소비가 `stmtCount`보다 훨씬 많아져 1024 한도에 먼저 도달할 수 있다.

실제로 `loadAliases()`로 전체 alias를 사전 로드하므로, 정상 운용 시 캐시 miss는 새로 추가된 태그에서만 발생해 빈도가 낮다. 하지만 `loadAliases()` 실패 시(worker.js L172~176에서 warn 후 계속 진행) 모든 조회가 캐시 miss가 되고, statement 소비가 급증하게 된다.

---

## 요약: 클래스 간 인터페이스별 위험도

| 인터페이스 | 관련 클래스 | 심각도 | 설명 |
|-----------|------------|--------|------|
| retry 설정 키 불일치 | ConfigLoader ↔ RetryHandler | **높음** | `base_delay_ms` vs `initial_delay_ms` |
| BigInt → Number → BigInt 경유 | Reader → Writer (TIME 컬럼) | **높음** | nanosecond timestamp 정밀도 손실 가능 |
| aliasMap 공유 | JobRunner → TableInfo → Reader×N | 중간 | 단일 스레드라 현재 안전, 향후 주의 |
| dstTableInfo 공유 | JobRunner → Writer×N | 중간 | 현재 읽기 전용이라 안전 |
| NAME 키 충돌 | Reader → Worker → Writer | 중간 | reader.js의 name 필터링에 의존 |
| getTableType silent skip | MachbaseClient → JobRunner | 중간 | 일시 오류도 영구 skip |
| srcTableInfo 첫 파티션 대표 | JobRunner → TableInfo → Reader×N | 중간 | 전제가 코드에 미명시 |
| checkpoint RID ±1n | CheckpointStore ↔ Worker | 낮음 | 동작 올바르나 불변식 미명시 |
| on_save_failure='abort' 동작 | CheckpointStore → Worker → JobRunner | 낮음 | Worker만 중단, 의도 불명확 |
| stmtCount 누락 | Worker ↔ Reader (resolveTagCanonical) | 낮음 | 캐시 miss 빈도 높으면 노출 가능 |
| listTagDataTables Number 변환 | MachbaseClient → JobRunner → TableInfo | 낮음 | table_id 범위상 현재 안전 |
| INTEGRITY vs STEADY 연결 전략 | Worker ↔ IntegrityChecker | 낮음 | 두 전략 혼재, 설명 부족 |
