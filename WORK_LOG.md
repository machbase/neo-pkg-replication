# 작업 기록

## Task #2: MachbaseStream.append() 에러 미포착 버그 수정

- **상태**: 완료
- **유형**: 버그 수정
- **규모**: 소규모 (파일 2개, 함수 2개)
- **활성 부서**: 개발부서, QA부서
- **계층**: 리더(Opus) → 팀장(Sonnet) 직접 수행

### 현상

`_TAG_DATA_0` append 후 `_TAG_DATA_1` 쿼리 시점에 아래 에러로 프로세스 크래시:

```
QueryError: Append row value count does not match columns.
  code: 'ERR_MACHBASE_APPEND_COLUMN_MISMATCH'
```

- app.js의 try/catch가 에러를 포착하지 못함
- `_TAG_DATA_0`은 756건 성공으로 표시되었으나, 실제로는 정상 append 여부 확인 불가

### 원인 분석

#### 원인 1: `await` 누락 — machbase.js:193

```javascript
// 현재 코드
async append(v) {
    this.stream.append(v);  // await 없음
}
```

- 라이브러리의 `AppendStreamSessionImpl.append()`는 `async` 메서드 (Promise 반환)
- `await` 없이 호출하므로 반환된 Promise가 버려짐
- 에러 발생 시 unhandled promise rejection → Node.js v22에서 프로세스 크래시
- app.js의 try/catch가 에러를 포착할 수 없는 근본 원인

#### 원인 2: 1D/2D 배열 불일치 — app.js:52

```javascript
// 현재 코드 (1D 배열 전달)
await desc.append([row.name, row.time, row.value])
```

- 라이브러리 `normalizeAppendStreamRows(rows, columns)`는 `rows.map(row => ...)` 수행
- `[name, time, value]`를 3개의 개별 row로 해석 → 각 row에 값 1개 vs 컬럼 3개 → 불일치 에러
- `[[name, time, value]]`로 감싸야 1행 3열로 올바르게 해석됨

#### `_TAG_DATA_0`이 성공한 것처럼 보인 이유

1. `await` 누락으로 `MachbaseStream.append()`가 즉시 resolve
2. 756회 반복이 에러 없이 완료된 것처럼 보임 (실제 append 결과는 확인하지 않음)
3. `_TAG_DATA_1` 쿼리의 `await` 시점에 이벤트 루프가 미처리 rejection을 감지 → 크래시

### 수정 계획

| 파일 | 위치 | 수정 내용 |
|------|------|-----------|
| machbase.js | :193 | `this.stream.append(v)` → `return await this.stream.append(v)` |
| app.js | :52 | `[row.name, row.time, row.value]` → `[[row.name, row.time, row.value]]` |

### 진행 기록

- [분석] 리더(Opus)가 에러 로그 및 라이브러리 소스 추적 완료
- [설계] 수정 계획 확정
- [구현] 개발 팀장(Sonnet)이 machbase.js, app.js 직접 수정
- [QA] QA 팀장(Sonnet) 리뷰 — 핵심 수정 2건 전체 통과, 추가 이슈 3건 발견
- [완료] 리더 최종 판정

### QA 리뷰 요약

| 검증 항목 | 판정 |
|-----------|------|
| `await` 추가 | 통과 |
| `return` 결과값 반환 | 통과 |
| 2D 배열 라이브러리 스펙 일치 | 통과 |
| 회귀(regression) 없음 | 통과 |

### QA 추가 발견 이슈

| 이슈 | 판정 | 사유 |
|------|------|------|
| app.js:61 `endRid.name` no-op | 무시 | 사용자 편집 코드. 작업 범위 외 |
| app.js:3 `stroe` 오타 | 무시 | 사용자 편집 코드. 작업 범위 외 |
| checkpoint 저장 로직 누락 | 참고 | 별도 작업으로 분리 |

### 산출물

- `machbase/machbase.js:193` — `return await this.stream.append(v)` 수정
- `app.js:52` — `[[row.name, row.time, row.value]]` 2D 배열 수정
