# 코드 리뷰 — repli-js

작성일: 2026-02-27

## 상태

전체 리뷰 완료. 발견된 14개 항목(Important 7, Minor 7) 모두 개선 완료.

## 개선 사항 요약

### Important (7건) — 모두 완료

| 파일 | 항목 | 수정 내용 |
|------|------|-----------|
| `file/checkpoint.js` | `save()`에서 `File` 생성 시 `bigintKeys` 미지정 | `new File(..., { bigintKeys: ['last_success_rid'] })` 추가 |
| `machbase/machbase.js` | `listTagDataTables()` 예외 처리 없어 `getTableType()`과 비일관성 | try/catch 추가, 에러 로그 후 빈 배열 반환 |
| `machbase/table_info.js` | `buildTag()`: `dataColumns` 비어있을 때 Worker 시작 후에야 오류 발견 | Step 3 전 `dataColumns.length === 0` 체크 + throw 추가 |
| `machbase/reader.js` | `dataTable`/`extraCols` 문자열 interpolation으로 SQL에 삽입 | 생성자에서 `/^[A-Za-z0-9_]+$/` allowlist 검증 추가 |
| `machbase/writer.js` | `int64` BigInt 변환 시 소수 number 입력 → RangeError | `Math.trunc()` 적용 + warn 로그 추가 |
| `machbase/integrity_checker.js` | `r.canonical` null/undefined 체크 없음 → SQL에 `'null'` 삽입 가능 | `r.time` 체크와 동일하게 null 체크 + throw 추가 |
| `worker/worker.js` | `safeCpRid = firstMissRid - 1n` — 방어적 클램프 없음 | `firstMissRid > 0n ? firstMissRid - 1n : 0n` 클램프 적용 |

### Minor (7건) — 모두 완료

| 파일 | 항목 | 수정 내용 |
|------|------|-----------|
| `file/file.js` | rename 실패 시 `.tmp` 파일 누적 | rename 실패 시 `fs.unlink(tmpPath)` 정리 추가 |
| `config/config.js` | `tag_identifier.mode` 미입력 시 에러 메시지 불명확 | mode 없음과 잘못된 값을 구분하는 별도 에러 메시지 |
| `machbase/machbase.js` | `fixDoubleEndian()`: NaN/Infinity 복원 불가 (알려진 한계) | 주석으로 한계 명시 |
| `machbase/table_info.js` | `loadAliases(conn)` 파라미터 API가 Reader 위임 패턴과 불일치 | JSDoc 주석으로 설계 의도 명시 |
| `worker/worker.js` | STARTUP_INTEGRITY: `resolved` 비어있을 때 `batchExists` 불필요 호출 | `resolved.length === 0` 조기 스킵 처리 추가 |
| `worker/worker.js` | STARTUP_INTEGRITY: 3단계 miss 탐색 코드 들여쓰기 오류 | try 블록 기준으로 들여쓰기 정렬 |
| `job_runner.js` | `sourceConn`이 Worker 전체 실행 구간 동안 idle하게 유지됨 | DISCOVER 완료 직후 `sourceConn.close()` 호출, finally에서 중복 close 방지 |
