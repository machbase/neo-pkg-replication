# IntegrityChecker (machbase/integrity_checker.js)

## 역할

STARTUP_INTEGRITY 단계에서 대상 테이블 row 존재 여부 일괄 확인.

## 잘 된 점

- OR-condition 단일 쿼리로 statement ID 1회만 소비.
- 500행 초과 시 throw로 caller 책임 명확화.
- `existKey()`에서 canonical null byte 포함 시 즉시 throw로 키 충돌 방지.

## 문제점

### #1 — `batchExists()`: `r.canonical`이 null/undefined일 때 SQL에 `'null'` 문자열 삽입 [Important] ✅ 완료

```js
const safeTag = String(r.canonical).replace(/'/g, "''");
```

`r.time`은 null 체크 후 throw하지만 `r.canonical`은 체크가 없다. `String(null)` → `'null'`, `String(undefined)` → `'undefined'`가 되어 SQL에 literal `'null'`이 삽입된다. 호출 측(worker.js)에서 `canonical === null`인 행을 `resolved`에 push하지 않으므로 정상 경로에서는 발생하지 않지만, 계약이 코드로 강제되지 않는다.

**수정**: `r.canonical == null` 체크 + `throw new Error(...)` 추가 (`r.time` 체크와 동일한 패턴).
