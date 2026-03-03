# CheckpointStore (file/checkpoint.js)

## 역할

job별 파티션 체크포인트 파일 load/save.

## 잘 된 점

- `source.data_table` 불일치, `last_success_rid` 타입 검증을 별도 구간으로 분리해 명확한 오류 진단 가능.
- `on_save_failure`에 따라 throw/return 분기하는 설계가 깔끔함.
- `File` 생성자에 `bigintKeys: ['last_success_rid']` 명시 — load/write 대칭 유지.

## 문제점

### #1 — `save()`에서 `File`을 `bigintKeys` 없이 생성 [Important] ✅ 완료

`load()`는 `new File(..., { bigintKeys: ['last_success_rid'] })`로 BigInt reviver를 지정하지만, `save()`는 `new File(...)`만 호출한다. `write()` 자체는 BigInt replacer가 동작하므로 쓰기는 문제없다. 그러나 `save()`의 `File` 인스턴스를 통해 `read()`를 직접 호출하면 `last_success_rid`가 string으로 반환된다. 현재 코드에서 해당 경로는 없으나, API 일관성이 깨져 있어 오해를 유발한다.

**수정**: `save()`에서도 `new File(..., { bigintKeys: ['last_success_rid'] })`로 통일.
