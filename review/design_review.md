# 설계 구조 평가 및 재설계 제안

작성일: 2026-02-27

## 현행 설계 개요

```
app.js
└── JobRunner.run()
    └── _runJob() × N (job 병렬)
        └── _runMapping() × M (mapping 병렬)
            ├── DISCOVER: sourceConn으로 TableInfo 빌드
            └── Worker 병렬 실행 (data_table별)
                ├── Reader (srcConn 소유)
                └── Writer (dstConn 소유)
                    → runDataTableWorker() 상태 머신
```

---

## 1. 현행 설계의 강점

### 1.1 소유권 모델 명확성
`Reader`가 srcConn을, `Writer`가 dstConn을 소유하고 `close()`로 해제하는 패턴은
`@machbase/ts-client`의 "단일 연결에서 동시 query 불가" 제약을 자연스럽게 해결한다.
연결 수명이 항상 소유자 객체 수명과 일치하여 추적이 쉽다.

### 1.2 상태 머신 명시성
`runDataTableWorker()`가 `RESOLVE_START → STARTUP_INTEGRITY → STEADY_REPLICATION`
3단계를 명시적으로 구분하여 각 단계의 책임이 분명하다.

### 1.3 Retry 분리
`RetryHandler`가 독립 모듈로 분리되어 있고, `_readBatch`/`_resolveCanonical`/`_appendRows`
헬퍼가 retry 로직을 감싸 비즈니스 로직과 분리된다.

### 1.4 BigInt 직렬화 일관성
`File` 클래스의 BigInt reviver/replacer가 JSON 경계에서 타입 변환을 통일 처리한다.

---

## 2. 현행 설계의 구조적 문제점

### 2.1 TableInfo의 이중 역할 [핵심 문제]

**현황**: `TableInfo`가 컬럼 메타데이터(정적 스키마 정보)와 alias 캐시(동적 런타임 상태) 두 가지를 동시에 관리한다.

```
TableInfo
├── dataColumns / metadataColumns / writeColumns  → 빌드 후 불변 (정적)
└── aliasMap + resolveTagCanonical()              → 런타임에 계속 변경 (동적)
```

**문제**:
- `resolveTagCanonical(conn, tagId, tagIdentifier)`가 `conn`을 파라미터로 받아 DB를 직접 조회한다. `TableInfo`가 DB 접근 로직을 포함하게 되어 "스키마 정보" 클래스와 "DB 접근" 클래스의 경계가 흐릿해진다.
- `loadAliases(conn)` 파라미터 불일치 문제(리뷰 #05 참조)의 근본 원인이다.
- 여러 Worker가 같은 `TableInfo`를 공유할 때 `aliasMap`의 동시성 문제가 잠재적으로 존재한다 (현재는 단일 스레드이므로 안전하지만, 구조 자체가 공유 상태임을 명시하지 않는다).

### 2.2 Worker 함수의 과도한 파라미터

**현황**: `runDataTableWorker({ jobId, mapping, checkpoint, tableType, dataTable, srcConfig, dstConfig, reader, writer, shutdownFlag })`
11개의 파라미터를 객체 구조분해로 받는다.

**문제**:
- `srcConfig`와 `dstConfig`는 statement ID 고갈 시 연결 재생성에만 사용된다. Worker 자체가 연결 재생성 책임을 지는 것이 Reader에 위임됐어야 할 관심사와 혼재된다.
- `tableType`이 Worker 진입 시 결정되어 Worker 내부에서 분기(`if tableType === 'TAG'`)가 반복된다. TAG/LOG 처리 로직이 단일 함수 안에 혼재한다.

### 2.3 STARTUP_INTEGRITY 단계의 결합도

**현황**: `runDataTableWorker()` 안에 STARTUP_INTEGRITY 루프가 직접 구현되어 있다.
`IntegrityChecker.batchExists()`를 호출하기 위해 `dstConfig`로 매번 새 연결을 만들고 닫는다.

**문제**:
- Worker가 `IntegrityChecker`에 직접 의존하고, 연결 생성 책임까지 진다.
- STARTUP_INTEGRITY 전체를 별도 함수/클래스로 분리하면 단위 테스트가 훨씬 용이해진다.

### 2.4 job_runner.js의 DISCOVER + Worker 실행 혼재

**현황**: `_runMapping()`이 DISCOVER 단계(스키마 수집)와 Worker 수명 관리(연결 생성·종료)를 모두 담당한다.

**문제**:
- 함수 길이가 150줄을 넘으며, DISCOVER 오류 경로마다 `sourceConn.close()`를 반복 호출해야 한다.
- Worker 연결 생성 실패 시 예외 처리 흐름이 복잡하다 (`workerResources`, try/catch, finally 3중 구조).

### 2.5 MachbaseClient가 카탈로그 조회를 직접 포함

**현황**: `MachbaseClient.getTableType()`, `MachbaseClient.listTagDataTables()`가 카탈로그 SQL을 직접 보유한다.

**문제**:
- `MachbaseClient`의 역할이 "연결 래퍼"인지 "카탈로그 조회기"인지 불분명하다.
- 과거에 `catalog.js`가 별도 존재했다가 병합된 이력이 있으나, 분리 이유(응집도)는 여전히 유효하다.

---

## 3. 재설계 권고

재설계 전제: 기능 동작은 동일하게 유지하되, 구조 명확성·테스트 용이성·유지보수성 향상.

### 3.1 TableInfo 분리: 스키마 vs. 태그 캐시

```
TableSchema (변경 없음)        TagAliasCache (신규 분리)
├── dataColumns                ├── aliasMap: Map<bigint, string>
├── metadataColumns            ├── load(conn): Promise<Error|null>
├── writeColumns               └── resolve(conn, tagId, tagIdentifier): Promise<{canonical, status}>
└── getSelectColumnNames()
```

**효과**:
- `TableInfo(= TableSchema)`는 빌드 후 완전히 불변(immutable). 여러 Worker가 읽기 공유 가능.
- `TagAliasCache`는 Worker별 인스턴스 또는 공유 인스턴스(명시적)로 관리.
- `Reader`는 `TableSchema`와 `TagAliasCache`를 별도 의존성으로 받아 역할이 명확해진다.

```js
// 현행
class TableInfo {
  async resolveTagCanonical(conn, tagId, tagIdentifier) { ... }
  async loadAliases(conn) { ... }
  dataColumns; metadataColumns; writeColumns;
}

// 재설계
class TableSchema {  // 불변, DB 접근 없음
  dataColumns; metadataColumns; writeColumns;
  getSelectColumnNames() { ... }
}

class TagAliasCache {  // 가변, DB 접근 있음
  #map = new Map();
  async load(conn) { ... }
  async resolve(conn, tagId, tagIdentifier) { ... }
}
```

### 3.2 Worker를 TAG/LOG 전략 패턴으로 분리

**현황**: Worker 내부에 `if (tableType === 'TAG')` 분기가 여러 곳에 산재한다.

**재설계안**:
```js
// 현행: 단일 함수 내 분기
if (tableType === 'TAG') {
  const canonical = await _resolveCanonical(...);
  ...
}

// 재설계: 전략 객체 주입
class TagRowProcessor {
  async process(row, aliasCache, tagIdentifier) { ... }
}
class LogRowProcessor {
  async process(row) { ... }
}

// Worker가 rowProcessor 주입받음
async function runDataTableWorker({ rowProcessor, ... }) {
  const outRow = await rowProcessor.process(row, ...);
}
```

**효과**: Worker 코어 로직에서 TAG/LOG 분기 완전 제거. 새로운 테이블 타입 추가 시 Worker 코어 수정 불필요.

### 3.3 STARTUP_INTEGRITY를 별도 함수로 추출

```js
// 현행: runDataTableWorker 내부 200줄짜리 if 블록
if (doIntegrity) {
  while (...) {
    // 배치 읽기, EXISTS 확인, miss 탐색 ...
  }
}

// 재설계: 독립 async 함수
async function runStartupIntegrity({ reader, integrityChecker, checkpointStore, ... }) {
  // 동일 로직, 독립 테스트 가능
  return { startRid };
}

async function runDataTableWorker(params) {
  const { startRid: integrityStartRid } = await runStartupIntegrity(params);
  // STEADY 진입
}
```

**효과**: STARTUP_INTEGRITY 단위 테스트 독립 작성 가능. Worker 함수 길이 절반으로 감소.

### 3.4 _runMapping() 분리: Discoverer + WorkerOrchestrator

```js
// 현행: _runMapping() 150줄 — DISCOVER + Worker 수명 관리
async function _runMapping(job, mapping, servers, shutdownFlag) { ... }

// 재설계
async function discoverMapping(mapping, servers) {
  // 반환: { tableType, dataTables, srcSchema, dstSchema }
}

async function orchestrateWorkers({ discovered, mapping, job, servers, shutdownFlag }) {
  // Worker 연결 생성, 실행, 정리만 담당
}
```

**효과**: DISCOVER 실패 vs. Worker 실패 에러 경로 분리. 각 함수 80줄 이하로 단축.

### 3.5 카탈로그 전담 클래스 복원

```js
// 현행: MachbaseClient에 직접 포함
class MachbaseClient {
  async getTableType(table) { ... }       // 카탈로그
  async listTagDataTables(table) { ... }  // 카탈로그
  async query(sql, values) { ... }        // 코어
  async appendOpen(...) { ... }           // 코어
}

// 재설계: 책임 분리
class MachbaseClient {
  async query(sql, values) { ... }    // 연결 래퍼 코어만
  async appendOpen(...) { ... }
}

class CatalogClient {                 // 카탈로그 전담
  constructor(client: MachbaseClient) { ... }
  async getTableType(table) { ... }
  async listTagDataTables(table) { ... }
}
```

---

## 4. 우선순위 및 권고

### 반드시 변경할 것

| 순위 | 항목 | 이유 |
|------|------|------|
| 1 | `TableInfo` 분리 (Schema + TagAliasCache) | 현행 구조에서 conn 파라미터 혼란, 공유 상태 불명확 문제가 지속됨 |
| 2 | STARTUP_INTEGRITY 함수 추출 | 단위 테스트 작성이 현재 매우 어려움 |

### 여건이 된다면 변경할 것

| 순위 | 항목 | 이유 |
|------|------|------|
| 3 | TAG/LOG 전략 패턴 분리 | Worker 코드 복잡도 감소 |
| 4 | `_runMapping()` 분리 | 에러 경로 명확화, 테스트 용이성 |

### 현행 유지가 합리적인 것

| 항목 | 이유 |
|------|------|
| `MachbaseClient` 카탈로그 통합 유지 | 분리 시 CatalogClient가 단순 위임에 그쳐 레이어만 증가할 가능성 |
| `CheckpointStore`/`File` 현행 유지 | 역할이 명확하고 단위 테스트 충분 |
| `RetryHandler` 현행 유지 | 완전히 독립적이고 잘 동작함 |

---

## 5. 재설계 시 주의사항

1. **`@machbase/ts-client` 단일 연결 제약**: 재설계 후에도 Worker별 독립 연결 원칙 유지 필수.
2. **BigInt 직렬화**: `File` 클래스의 reviver/replacer 패턴은 재설계와 무관하게 유지.
3. **Statement ID 고갈 대응**: `reader.refreshConnection()` 패턴은 어느 설계에서도 필요.
4. **Retry 범위**: `_readBatch`/`_resolveCanonical`/`_appendRows` 헬퍼의 retry 구조는 전략 패턴 도입 후에도 동일하게 적용.
