# Writer (machbase/writer.js)

## 역할

dstConn 소유, appendOpen/append/close 래퍼.

## 잘 된 점

- `open()` 성공 시 dstConn 소유권 이전, `close()`에서 stream + conn 순서로 정리하는 소유권 모델이 명확함.
- `append()`에서 배열 row와 객체 row 모두 처리 (`Array.isArray(row)` 분기).
- `close()`에서 stream/conn 둘 다 null 처리하여 중복 호출 방지.

## 문제점

### #1 — `append()`: `int64` 타입에 소수 number 입력 시 `BigInt()` RangeError [Important] ✅ 완료

```js
if (col.columnType.type === 'int64') {
  return typeof val === 'bigint' ? val : BigInt(val);
}
```

`BigInt(val)`은 `val`이 소수점 포함 number(`1.5`)인 경우 `RangeError: The number 1.5 cannot be converted to a BigInt`를 던진다. `try/catch` 안에 있으므로 에러를 반환하고 Worker가 retry 처리하지만, retry 대신 명시적 검증이 더 적합하다. Reader에서 datetime/long 타입 컬럼값이 항상 정수임을 보장하는 계약이 코드에 없다.

**수정**: `number` 타입이며 정수가 아닌 경우 warn 로그 후 `BigInt(Math.trunc(val))` 적용.
