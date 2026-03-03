# JobRunner (job_runner.js)

## 역할

DISCOVER → 연결 생성 → Worker 병렬 실행 → 정리.

## 잘 된 점

- Worker setup 실패 시 직접 close하고 `workerResources`에 push 안 함 → finally 중복 close 없음.
- `sourceConn`이 DISCOVER 전용, Worker는 독립 연결 사용 — ts-client 동시 쿼리 제약 준수.
- `_runMapping` / `_runJob` 각각 `.catch()`로 감싸 한 mapping 실패가 다른 mapping에 전파되지 않음 (주석으로 의도 명시).

## 문제점

### #1 — `sourceConn`이 Worker 전체 실행 구간 동안 idle하게 유지됨 [Minor] ✅ 완료

```js
let sourceConn;
try {
  sourceConn = new MachbaseClient(srcConfig);
  await sourceConn.connect();
  // ... DISCOVER ...
  await Promise.all(workerPromises);  // 수 시간~수일
} finally {
  await sourceConn.close().catch(...);
}
```

`sourceConn`은 DISCOVER 단계(`getTableType`, `listTagDataTables`, `TableInfo.build*`)에서만 사용된다. 이후 Worker 실행 동안 수 시간~수일 idle하게 유지되다 finally에서 close된다. Machbase 서버 idle timeout 설정에 따라 연결이 끊기면 `close()` 에서 에러가 날 수 있으며 (`.catch()` 로 무시), 불필요한 연결을 유지한다.

**수정**: DISCOVER 완료 직후 `await sourceConn.close()` 호출 + `sourceConn = null`, finally에서 `sourceConn !== null` 조건으로 중복 close 방지.
