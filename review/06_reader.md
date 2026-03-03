# Reader (machbase/reader.js)

## 역할

srcConn 소유, RID 기반 소스 읽기, TAG alias 위임.

## 잘 된 점

- `refreshConnection()`에서 새 연결 성공 후 구 연결 닫기 순서가 올바름.
- `MAX(_RID)` 실패 시 `startRid + rangeSize` 폴백 + warn 로그 + 주석으로 무한 루프 위험 없음을 명시.
- `row._RID == null` null coalescing 체크로 예상치 못한 null row 스킵.
- `close()` 후 `this.conn = null`로 double-close 방지.

## 문제점

### #1 — `readAfterRid()`: `dataTable`/`extraCols`를 문자열 interpolation으로 SQL에 삽입 [Important] ✅ 완료

```js
const sql = `SELECT /*+ RID_RANGE(${dataTable}, ${startRid}, ${endRid}) */ ${colList} FROM ${dataTable} WHERE _RID >= ${startRid} LIMIT ${limit}`;
```

`dataTable`은 DB 카탈로그(`V$STORAGE_TAG_TABLES`)에서, `extraCols`는 `M$SYS_COLUMNS.NAME`에서 가져온 값이다. 파라미터 바인딩이 아닌 문자열 interpolation으로 SQL에 삽입된다. `startRid`/`endRid`는 BigInt로 안전하지만, DB에서 받아온 테이블명/컬럼명이 악의적이거나 예상치 못한 문자를 포함할 경우 SQL 구조가 변형될 수 있다. 프로덕션 환경에서는 신뢰할 수 있는 값이지만 방어적 설계가 없다.

**수정**: `Reader` 생성자에서 `dataTable`이 `/^[A-Za-z0-9_]+$/` allowlist에 맞지 않으면 즉시 `throw`.
