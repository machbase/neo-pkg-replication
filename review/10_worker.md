# Worker (worker/worker.js)

## 역할

`RESOLVE_START → STARTUP_INTEGRITY → STEADY_REPLICATION` 상태 머신.

## 잘 된 점

- `_readBatch` / `_resolveCanonical` / `_appendRows` 헬퍼로 retry 로직과 비즈니스 로직이 분리됨.
- `shouldReturn` 플래그로 `try/finally` 내 분기 처리가 명확함.
- 모든 null/undefined 반환을 sentinel로 사용해 caller에서 명시적으로 처리.
- 모듈 최상단 `STMT_REFRESH_THRESHOLD`, `INTEGRITY_BATCH_LIMIT` 상수로 하드코딩 없음.

## 문제점

### #1 — STARTUP_INTEGRITY: `safeCpRid = firstMissRid - 1n` 음수 잠재 버그 [Important] ✅ 완료

```js
const safeCpRid = firstMissRid - 1n;
```

현재 STARTUP_INTEGRITY 진입 조건(`cpExists === true`)으로 `integrityRid >= 1n`이 보장되므로 `firstMissRid >= 1n`이고 `safeCpRid >= 0n`이다. 그러나 방어적 클램프 없이 `firstMissRid - 1n`을 직접 사용하고 있어, 진입 조건이 변경되면 `safeCpRid = -1n`이 될 수 있다.

**수정**: `const safeCpRid = firstMissRid > 0n ? firstMissRid - 1n : 0n;`

### #2 — STARTUP_INTEGRITY: `resolved`가 비어있을 때 `batchExists` 불필요 호출 [Minor] ✅ 완료

```js
const { existSet, err: batchErr } = await IntegrityChecker.batchExists(intConn, mapping.target.table, resolved);
```

배치의 모든 row가 `drop_not_found`이면 `resolved`가 비어있다. `batchExists` 내부에서 즉시 반환하지만 DB 연결을 열고 닫는 비용이 발생한다.

**수정**: `if (resolved.length === 0)` 체크 후 `batchExists` 호출 스킵, `existSet = new Set()` 바로 사용.

### #3 — STARTUP_INTEGRITY: try 블록 내 들여쓰기 오류 [Minor] ✅ 완료

**라인 248-260 (3단계 miss 탐색)**

`if (batchErr)` 이후 코드(`let firstMissRid`, `let skippedExists`, `for` 루프)가 try 블록 안이지만 들여쓰기 레벨이 한 단계 낮아져 시각적으로 try/finally 바깥처럼 보인다. 코드 가독성이 크게 저하된다.

**수정**: 3단계 코드 블록 들여쓰기를 try 블록 기준으로 정렬.
