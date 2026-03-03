# ConfigLoader (config/config.js)

## 역할

`config.json` 파싱·검증, execution 필드 레벨 merge.

## 잘 된 점

- `_mergeExecution(base, mid, top)` 3-layer 필드 레벨 merge 설계가 명확함.
- 검증 실패 시 해당 mapping만 `[]` 반환(skip), 나머지는 계속 처리.
- `VALID_START_MODES`, `VALID_ON_SAVE_FAILURE` Set 기반 검증이 확장에 유리함.

## 문제점

### #1 — `tag_identifier.mode` 미입력 시 에러 메시지 불명확 [Minor] ✅ 완료

```js
if (tagId && !VALID_MODES.includes(tagId.mode)) {
```

`tagId`가 객체이지만 `tagId.mode`가 없으면 `VALID_MODES.includes(undefined) === false`가 되어 에러 메시지가 `"Invalid tag_identifier.mode 'undefined'"`로 출력된다. 실제로는 mode가 없는 경우이므로 `"Invalid or missing tag_identifier.mode"`가 더 명확하다.

**수정**: `tagId.mode === undefined || null` 케이스를 별도 분기로 처리하여 `"tag_identifier.mode is required when tag_identifier is specified"` 메시지 출력.
