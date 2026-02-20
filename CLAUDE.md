# repli-js 작업지시서

## 프로젝트 개요

Machbase TAG 테이블 간 데이터 복제(replication) 도구.
소스 DB에서 RID 기반으로 데이터를 읽어 대상 DB에 Append Stream으로 기록한다.

- **런타임**: Node.js v22 (CommonJS)
- **핵심 의존성**: `@machbase/ts-client@0.9.3` (CMI 프로토콜 기반 Machbase 네이티브 클라이언트)

## 디렉토리 구조

```
repli-js/
├── app.js                  # 진입점 — 복제 로직 오케스트레이션
├── config.json             # 파티션별 마지막 처리 RID 저장 (상태 파일)
├── machbase/
│   └── machbase.js         # MachbaseClient, MachbaseStream 클래스
├── file/
│   └── file.js             # JSON 파일 읽기/쓰기 (atomic write, BigInt 지원)
├── package.json
└── node_modules/
    └── @machbase/ts-client # Machbase CMI 프로토콜 클라이언트 라이브러리
```

## 핵심 모듈 상세

### app.js — 메인 복제 흐름

1. `config.json`에서 파티션별 마지막 RID를 읽음 (없으면 DB에서 조회 후 0으로 초기화)
2. 소스 DB(`MachbaseClient`)에 연결, 각 파티션(`_TAG_DATA_0` ~ `_TAG_DATA_3`)을 RID 범위로 SELECT
3. 대상 DB(`MachbaseStream`)에 Append Stream으로 기록
4. 현재는 `config.json`에 진행 RID를 다시 저장하는 로직이 아직 구현되지 않음

### machbase/machbase.js

#### MachbaseClient
- `createConnection(config)`으로 `@machbase/ts-client` 연결 생성
- 생성자에서 `table` 이름(예: "TAG")을 받아 내부 SQL에서 사용
- 주요 메서드:
  - `connect()` / `close()` — 연결 관리
  - `query(sql, value)` — `conn.query()` 래퍼, `[rows]` 구조분해로 결과 반환
  - `tableExists()` — `SELECT * FROM {table} LIMIT 1`로 존재 여부 확인
  - `lookupEndRIDS()` — `V$STORAGE_TAG_TABLES`와 `M$SYS_TABLES` 조인으로 파티션별 END_RID 조회
  - `lookupDataColumns()` / `lookupMetaColumns()` — 컬럼 메타 정보 조회
  - `selectDataByRid(store, range, limit)` — `RID_RANGE` 힌트로 특정 RID 구간 데이터 조회

#### MachbaseStream
- `MachbaseClient`를 내부에 보유, `appendOpen()`으로 스트림 생성
- `open()` — 연결 + 컬럼 타입 조회 + `appendOpen()` 호출
- `append(...v)` — `stream.append(v)` 호출
- `close()` — 스트림 닫기 + 연결 종료

### file/file.js — File 클래스

- JSON 파일에 대한 CRUD (atomic write: tmp 파일 → rename)
- `read()` — 숫자 문자열을 `BigInt`로 자동 변환하여 파싱
- `write(data)` — `BigInt`를 문자열로 직렬화하여 저장
- `update(partial)` — 기존 데이터와 병합 후 저장

## @machbase/ts-client API 참조

`createConnection(config)` → `Connection` 객체 반환.

### ConnectionConfig
```js
{
  host: string,      // DB 호스트
  port: number,      // DB 포트
  user: string,      // 사용자명
  password: string,  // 비밀번호
  database?: string,
  timezone?: string,
  showHiddenColumns?: boolean,
  connectTimeout?: number,
  queryTimeout?: number,
}
```

### Connection 주요 메서드
| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `connect()` | `() → Promise<void>` | DB 연결 |
| `end()` | `() → Promise<void>` | 연결 종료 |
| `query()` | `(sql, values?) → Promise<[rows, fields]>` | SQL 쿼리 실행 |
| `execute()` | `(sql, values?) → Promise<[result, fields]>` | SQL 실행 (INSERT/UPDATE 등) |
| `prepare()` | `(sql) → Promise<PreparedStatementInfo>` | Prepared Statement 생성 |
| `appendOpen()` | `(table, columns, options?) → Promise<AppendStreamSession>` | Append 스트림 오픈 |
| `appendBatch()` | `(table, columns, rows, options?) → Promise<AppendBatchResult>` | Append 배치 실행 |

### AppendStreamSession
| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `append()` | `(rows: AppendRowInput[]) → Promise<number>` | 로우 추가 |
| `close()` | `() → Promise<void>` | 스트림 닫기 |

### AppendColumnDefinition
```js
{ name: string, type: 'int32' | 'int64' | 'float64' | 'varchar' }
```

### 컬럼 타입 매핑 (machbase.js 내부)
| Machbase 내부 타입 코드 | 이름 |
|------------------------|------|
| 4 / 104 | short / ushort |
| 8 / 108 | integer / uinteger |
| 12 / 112 | long / ulong |
| 16 | float |
| 20 | double |
| 5 | varchar |
| 49 | text |
| 6 | datetime |
| 61 | json |

## config.json 형식

파티션별 이름과 마지막 처리 RID를 배열로 저장한다. RID는 BigInt 문자열로 직렬화된다.

```json
[
  { "name": "_TAG_DATA_0", "rid": "0" },
  { "name": "_TAG_DATA_1", "rid": "0" },
  { "name": "_TAG_DATA_2", "rid": "0" },
  { "name": "_TAG_DATA_3", "rid": "0" }
]
```

## Machbase TAG 테이블 내부 구조

TAG 테이블(예: "TAG")은 내부적으로 여러 시스템 테이블로 분할된다:

- `_TAG_META` — 태그 메타 정보 (태그 이름 → `_ID` 매핑)
- `_TAG_DATA_0` ~ `_TAG_DATA_N` — 실제 데이터 파티션 (파티션 수는 테이블 설정에 따름)
- `V$STORAGE_TAG_TABLES` — 파티션별 RID 범위 등 스토리지 정보
- `M$SYS_TABLES` / `M$SYS_COLUMNS` — 시스템 카탈로그

데이터 조회 시 `RID_RANGE` 힌트를 사용하여 특정 RID 구간만 스캔할 수 있다:
```sql
SELECT /*+ RID_RANGE(_TAG_DATA_0, 0, 10000) */ d._RID, m.name, d.time, d.value
FROM _TAG_DATA_0 d, _TAG_META m
WHERE d.name = m._ID
LIMIT 1000
```

## 개발 규칙

- **모듈 시스템**: CommonJS (`require` / `module.exports`) 사용
- **비동기 패턴**: `async/await` 사용
- **BigInt 처리**: RID 값은 BigInt로 다룸. JSON 직렬화 시 `BigInt → string` 변환 필요
- **에러 처리**: `@machbase/ts-client`의 `QueryError` 클래스로 DB 에러를 구분
- **로깅**: `console.debug`는 디버그 로그, `console.log`는 일반 출력, `console.error`는 에러 출력
- **코드 스타일**: 세미콜론 생략 스타일과 사용 스타일이 혼재 — 기존 파일의 스타일을 따를 것
- **테스트**: 현재 테스트 없음 (`npm test`는 에러 출력만 함)

## 실행 방법

```bash
node app.js
```

## 알려진 한계 / TODO

1. 복제 완료 후 `config.json`에 진행 RID를 저장하는 로직이 없음
2. 소스/대상 DB 접속 정보가 `app.js`에 하드코딩되어 있음
3. 단일 실행 후 종료 — 주기적 반복 실행(polling/scheduler) 미구현
4. `MachbaseStream.append()`에서 `...v` spread 후 `stream.append(v)`로 전달 — `AppendStreamSession.append()`는 `AppendRowInput[]`(2차원 배열)을 기대하므로 호출 형태 확인 필요
5. 에러 발생 시 재시도 로직 없음
