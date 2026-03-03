# TableInfo (machbase/table_info.js)

## 역할

TAG/LOG 테이블 컬럼 메타 분석, TAG alias map(read-through cache), appendOpen용 컬럼 순서 제공.

## 잘 된 점

- `buildTag` / `buildLog` 팩토리 패턴으로 TAG/LOG 분기를 인스턴스 생성 시점에 완결.
- `getSelectColumnNames()`의 lowercase 변환 위치가 TableInfo 안에 있어 Reader와의 대문자/소문자 계약이 명확함.
- `resolveTagCanonical()`의 read-through cache가 Map miss → DB 단건 조회 → Map 추가로 일관성 있게 구현됨.

## 문제점

### #1 — `buildTag()`: `dataColumns` 비어있을 때 Worker 시작 후에야 오류 발견 [Important] ✅ 완료

```js
const metaRows = await conn.query(metaSql, [metaTableName]);
...
const dataRows = await conn.query(dataSql, [dataTableId]);
```

두 쿼리 모두 try/catch 없이 직접 await한다. `dataRows` 쿼리 오류나 필터 결과로 `dataColumns`가 비어있으면, `buildTag()` 자체는 정상 반환하고 Reader 생성 후 Worker 실행 시 `readAfterRid()`에서 `'tableInfo has no columns'` 오류가 발생한다. fail-fast 관점에서 팩토리 단계에서 `dataColumns.length === 0`을 검증하는 것이 더 명확하다.

또한 `buildTag()` 성공 후 `dataColumns`가 비어있으면 `writeColumns`가 `[NAME]` 한 개만 남아, Writer가 NAME만 포함한 `appendOpen`을 시도하는 부분정합 시나리오가 존재한다.

**수정**: `writeColumns` 구성 전에 `if (info.dataColumns.length === 0) throw new Error(...)` 추가.

### #2 — `loadAliases(conn)`: conn 파라미터 API가 Reader 위임 패턴과 불일치 [Minor] ✅ 완료

`loadAliases(conn)`은 외부에서 conn을 받는 구조지만, `Reader.loadAliases()`는 `this.tableInfo.loadAliases(this.conn)`으로 위임한다. TableInfo를 직접 사용하는 코드에서 conn 인자를 잊으면 `conn.query`에서 런타임 에러가 발생한다. TableInfo가 conn을 소유하지 않아 발생하는 구조적 불일치.

**수정**: JSDoc 주석으로 설계 의도(buildTag에서 conn 명시 필요, Reader는 this.conn 자동 바인딩) 명시.
