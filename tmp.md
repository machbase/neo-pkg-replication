# Machbase NEO - 메모리 순서 기반 미존재 Row 탐색

## 개요

메모리(JS 배열)에 특정 조건으로 정렬된 row들이 있을 때, **입력 순서를 유지하면서** DB에 존재하지 않는 첫 번째 row를 찾는 방법입니다.

### 핵심 제약사항

- Machbase TAG 테이블은 JOIN의 드라이빙 테이블이 될 수 없음
- `WHERE t.col IS NULL` 조건이 LEFT OUTER JOIN을 INNER JOIN으로 변환하는 제약 존재
- Tuple 비교 (`(name, time) IN (...)`) 문법 미지원
- Multi-row INSERT 미지원 (한 건씩 INSERT 필요)

---

## 접근 방식

TAG 테이블 JOIN 제약으로 인해 **2개의 VOLATILE TABLE을 중간 단계**로 활용합니다.

```
메모리 배열 (정렬된 상태)
    ↓ idx 부여 후 INSERT
check_list (VOLATILE)       ← 순서(idx) + 후보 데이터
    ↓ TAG에서 (name, time) 쌍 매칭
tag_lookup (VOLATILE)       ← 실제 존재하는 데이터만
    ↓ LEFT OUTER JOIN + 서브쿼리
결과: 입력 순서상 첫 번째 미존재 row
```

---

## 테이블 구조

```sql
-- 후보 데이터 (메모리 배열을 순서 포함해서 저장)
CREATE VOLATILE TABLE check_list (
    idx  INT,
    name VARCHAR(100),
    time DATETIME
);

-- TAG에서 실제 존재하는 데이터만 복사
CREATE VOLATILE TABLE tag_lookup (
    name VARCHAR(100),
    time DATETIME
);
```

> VOLATILE TABLE은 세션 종료 시 자동 삭제됩니다.  
> 재사용 시 매 요청마다 `DELETE FROM` 으로 초기화합니다.

---

## 쿼리 단계

### Step 1. 테이블 초기화

```sql
DELETE FROM check_list;
DELETE FROM tag_lookup;
```

### Step 2. 메모리 배열 → check_list INSERT

메모리 배열의 **원래 순서대로** `idx`를 부여하여 INSERT합니다.

```sql
INSERT INTO check_list VALUES(1, 'sensor-A', {time_ns});
INSERT INTO check_list VALUES(2, 'sensor-B', {time_ns});
INSERT INTO check_list VALUES(3, 'sensor-C', {time_ns});
-- ... 30개
```

> `time`은 nanosecond 정수값으로 전달합니다.  
> Machbase TAG 테이블의 TIME 컬럼은 nanosecond 단위입니다.

### Step 3. TAG → tag_lookup 복사 (`(name, time)` 쌍 정확히 매칭)

```sql
INSERT INTO tag_lookup
SELECT t.NAME, t.TIME
FROM TAG t, check_list c
WHERE t.NAME = c.NAME AND t.TIME = c.TIME;
```

> `NAME IN (...) AND TIME IN (...)` 방식은 **각각 독립 조건**이므로  
> 잘못된 조합도 매칭될 수 있어 사용하면 안 됩니다.  
> 반드시 JOIN 방식으로 **(name, time) 쌍**을 함께 비교해야 합니다.

### Step 4. 입력 순서 기준 첫 번째 미존재 row 조회

```sql
-- 첫 번째 1개만
SELECT IDX, NAME, TIME FROM (
    SELECT c.IDX, c.NAME, c.TIME, t.NAME AS T_NAME
    FROM check_list c
    LEFT OUTER JOIN tag_lookup t
        ON c.NAME = t.NAME AND c.TIME = t.TIME
) WHERE T_NAME IS NULL
ORDER BY IDX ASC
LIMIT 1;
```

> `WHERE T_NAME IS NULL`을 서브쿼리 바깥에 두는 이유:  
> Machbase에서 `LEFT OUTER JOIN ... WHERE joined_col IS NULL`을 직접 쓰면  
> INNER JOIN으로 변환되는 제약이 있기 때문입니다.

---

## 동작 원리

```
메모리 배열 (입력 순서):
  idx=1  sensor-A  t1  →  TAG에 존재 ✅  →  tag_lookup에 있음
  idx=2  sensor-B  t2  →  TAG에 존재 ✅  →  tag_lookup에 있음
  idx=3  sensor-C  t3  →  TAG에 없음  ❌  →  tag_lookup에 없음  ← 반환
  idx=4  sensor-D  t4  →  TAG에 존재 ✅  →  tag_lookup에 있음
  idx=5  sensor-E  t5  →  TAG에 없음  ❌  →  tag_lookup에 없음

LEFT OUTER JOIN 결과:
  IDX  NAME      TIME  T_NAME
  1    sensor-A  t1    sensor-A   (JOIN 성공)
  2    sensor-B  t2    sensor-B   (JOIN 성공)
  3    sensor-C  t3    NULL       ← WHERE T_NAME IS NULL 통과
  4    sensor-D  t4    sensor-D   (JOIN 성공)
  5    sensor-E  t5    NULL

ORDER BY IDX ASC LIMIT 1 → idx=3 반환
```

---

## JavaScript 예시

```js
const BASE_URL = "http://192.168.1.183:5654";

async function query(sql) {
    const res = await fetch(`${BASE_URL}/db/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: sql }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.reason);
    return data.data?.rows ?? [];
}

async function findFirstMissingRow(rows) {
    // rows: [{ name, time }, ...] — 특정 조건으로 이미 정렬된 상태

    // Step 1. 초기화
    await query("DELETE FROM check_list");
    await query("DELETE FROM tag_lookup");

    // Step 2. 순서(idx) 포함해서 INSERT
    for (let i = 0; i < rows.length; i++) {
        const { name, time } = rows[i];
        await query(
            `INSERT INTO check_list VALUES(${i + 1}, '${name}', ${time})`
        );
    }

    // Step 3. (name, time) 쌍으로 TAG → tag_lookup 복사
    await query(`
        INSERT INTO tag_lookup
        SELECT t.NAME, t.TIME
        FROM TAG t, check_list c
        WHERE t.NAME = c.NAME AND t.TIME = c.TIME
    `);

    // Step 4. 입력 순서 기준 첫 번째 미존재 row 조회
    const result = await query(`
        SELECT IDX, NAME, TIME FROM (
            SELECT c.IDX, c.NAME, c.TIME, t.NAME AS T_NAME
            FROM check_list c
            LEFT OUTER JOIN tag_lookup t
                ON c.NAME = t.NAME AND c.TIME = t.TIME
        ) WHERE T_NAME IS NULL
        ORDER BY IDX ASC
        LIMIT 1
    `);

    if (result.length === 0) return null; // 모두 존재

    const [idx, name, time] = result[0];
    return { idx, name, time };
}

// 사용 예시
const rows = [
    { name: "sensor-A", time: 1773213914697589700n },
    { name: "sensor-B", time: 1773213914719680100n },
    { name: "sensor-C", time: 1773213914734000000n },
    // ...
];

const firstMissing = await findFirstMissingRow(rows);

if (firstMissing) {
    console.log("첫 번째 미존재 row:", firstMissing);
    // { idx: 3, name: 'sensor-C', time: ... }
} else {
    console.log("모든 row가 DB에 존재합니다.");
}
```

---

## 주의사항

| 항목 | 내용 |
|------|------|
| TIME 단위 | Machbase TAG 테이블의 TIME은 **nanosecond** 정수값 |
| VOLATILE TABLE 생명주기 | 서버 세션 종료 시 자동 삭제 — 서버 재시작 후 재생성 필요 |
| (name, time) 쌍 매칭 | `IN (...)` 독립 조건 사용 금지 — 반드시 JOIN 방식 사용 |
| LEFT OUTER JOIN 제약 | `WHERE joined_col IS NULL`은 반드시 서브쿼리 바깥에 위치 |
| TAG JOIN 제약 | TAG 테이블은 JOIN 드라이빙 테이블 불가 — VOLATILE TABLE 경유 필수 |