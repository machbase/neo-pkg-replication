# MachbaseClient + ColumnType (machbase/machbase.js)

## 역할

@machbase/ts-client 래퍼, endian 버그 우회, 컬럼 타입 매핑.

## 잘 된 점

- `fixDoubleEndian()`에 우회 이유·한계·재설치 후 유효성을 상세하게 주석으로 명시.
- `ColumnType.#byCode` private static Map으로 O(1) 조회.
- `getTableType()` 실패 시 `UNSUPPORTED` 반환으로 caller에서 일관된 처리 가능.

## 문제점

### #1 — `fixDoubleEndian()`: NaN/Infinity에 대해 복원 불가 [Minor] ✅ 완료 (주석 보강)

```js
if (v !== 0 && Math.abs(v) < DOUBLE_MIN_NORMAL) {
```

`NaN`과 `Infinity`/`-Infinity`는 `Math.abs(v) < DOUBLE_MIN_NORMAL` 조건이 false가 되어 교정되지 않는다. BE로 저장된 정상값이 LE로 읽혀 NaN/Infinity가 나오는 경우는 복원 불가. 실무 데이터에서 발생 가능성은 낮고, 코드 주석에 FLOAT 미지원 등 한계가 명시되어 있다.

### #2 — `listTagDataTables()`: 예외 처리 없어 `getTableType()`과 API 비일관성 [Important] ✅ 완료

```js
async listTagDataTables(logicalTable) {
  const rows = await this.query(sql, [pattern]);
  return (rows || []).map(...);
}
```

`query()`가 예외를 던지면 그대로 전파된다. `getTableType()`은 try/catch로 `UNSUPPORTED`를 반환하는 에러 흡수 구조인데, `listTagDataTables()`는 예외를 그대로 올려보내 job_runner의 `discover failed` catch에서 처리된다. 기능은 보장되지만 같은 클래스 내 API 일관성이 없다.

**수정**: try/catch 추가, 에러 로그 후 빈 배열 반환.
