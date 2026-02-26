# @machbase/ts-client FLOAT/DOUBLE Endian 버그 분석 및 우회

**버전**: `@machbase/ts-client@0.9.3`
**발견**: 2026-02-26 통합 테스트 중
**영향 범위**: TAG 데이터 파티션에서 FLOAT/DOUBLE 컬럼을 쿼리할 때 일부 파티션의 값이 손상됨
**우회 위치**: `machbase/machbase.js` — `fixDoubleEndian()`

---

## 1. 증상

TAG 테이블 통합 테스트(IT-TAG-01)에서 소스에 삽입한 값과 복제된 값이 다르게 나왔다.

```
SRC: sensor_a=1.1, sensor_b=2.2, sensor_c=3.3
DST: sensor_a=1.1, sensor_b=1.085e-319 (손상), sensor_c=1.629e-318 (손상)
```

`sensor_a`는 `_TAG_DATA_1` 파티션에, `sensor_b`와 `sensor_c`는 `_TAG_DATA_0` 파티션에 저장됐는데, 동일한 DOUBLE 값이 **파티션에 따라 정상/손상으로 갈렸다**.

---

## 2. 원인 분석

### 2.1 라이브러리 내부 구조

`@machbase/ts-client`는 Machbase 전용 CMI(Client-Machine Interface) 이진 프로토콜로 DB와 통신한다. 쿼리 결과 행을 파싱하는 경로는 두 군데가 있다.

#### 경로 A — `encodeFieldValue()` (송신, 쓰기 방향)

AppendStream이나 파라미터 바인딩 시 값을 **서버로 보낼 때** 사용한다.
`serverIsLE` 플래그를 받아 서버 endian에 맞게 인코딩한다.

```js
// connection.js:817-834 (송신 — serverEndian 반영 O)
case constants_1.CMD_FLT32_TYPE: {
    const buffer = node_buffer_1.Buffer.alloc(4);
    if (serverIsLE)
        buffer.writeFloatLE(numeric);
    else
        buffer.writeFloatBE(numeric);
    return buffer;
}
case constants_1.CMD_FLT64_TYPE: {
    const buffer = node_buffer_1.Buffer.alloc(8);
    if (serverIsLE)
        buffer.writeDoubleLE(numeric);
    else
        buffer.writeDoubleBE(numeric);
    return buffer;
}
```

#### 경로 B — `decodeFixedField()` (수신, 읽기 방향)

쿼리 결과 행을 **서버에서 받아 파싱할 때** 사용한다.
`serverEndian`을 받는 파라미터가 없고 무조건 LE로 읽는다.

```js
// connection.js:1145-1168 (수신 — serverEndian 반영 X, 버그)
function decodeFixedField(column, field) {
    switch (column.typeCode) {
        case constants_1.CMD_INT16_TYPE:
            return field.readInt16BE(0);   // 정수 계열: BE ✓
        case constants_1.CMD_INT32_TYPE:
            return field.readInt32BE(0);   // 정수 계열: BE ✓
        case constants_1.CMD_INT64_TYPE:
            return field.readBigInt64BE(0);// 정수 계열: BE ✓
        // ...
        case constants_1.CMD_FLT32_TYPE:
            return field.readFloatLE(0);   // ← 항상 LE, 버그
        case constants_1.CMD_FLT64_TYPE:
            return field.readDoubleLE(0);  // ← 항상 LE, 버그
        case constants_1.CMD_DATE_TYPE:
            return field.readBigInt64BE(0);// 날짜: BE ✓
    }
}
```

정수 계열(INT16 ~ INT64, DATETIME)은 BE로 읽고 있는데, FLT32/FLT64만 LE로 하드코딩되어 있다.

### 2.2 연결 핸드셰이크에서 serverEndian은 협상됨

```js
// connection.js:429-437 (handshake)
const endianUnit = firstUnit(units, constants_1.CMI_C_ENDIAN_ID);
if (endianUnit) {
    const v = endianUnit.data.length >= 4
        ? endianUnit.data.readUInt32LE(0) : 0;
    this.serverEndian = v ? 1 : 0;  // 0=LE, 1=BE
} else {
    this.serverEndian = 0;
}
```

핸드셰이크 단계에서 서버 endian을 `this.serverEndian`에 기록한다. 그런데 `decodeFixedField()`는 standalone 함수라 `this`(Connection 인스턴스)에 접근하지 못하고, 호출 시 `serverEndian`을 인자로 전달받지도 않는다. 결과적으로 협상 결과가 수신 디코딩에 반영되지 않는다.

### 2.3 Machbase 서버 동작 — 파티션별 이중 endian

Machbase의 TAG 데이터 파티션(`_TAG_DATA_0`, `_TAG_DATA_1`, …)은 파티션 인덱스에 따라 DOUBLE 값을 다른 endian으로 저장한다.

| 파티션 | DOUBLE 저장 방식 | `readDoubleLE`로 읽으면 |
|--------|----------------|------------------------|
| `_TAG_DATA_0` | Big-Endian (BE) | 손상 (denormal) |
| `_TAG_DATA_1` | Little-Endian (LE) | 정상 |

이 동작이 파티션 인덱스의 홀짝에 따른 것인지, 다른 기준에 의한 것인지는 Machbase 서버 내부 구현에 달려 있다. 실측 결과로는 `_DATA_0` → BE, `_DATA_1` → LE 패턴이 확인됐다.

---

## 3. 오류 재현

### 3.1 바이트 수준 재현

`3200.0`을 BE로 저장하면:

```
BE bytes: 40 A9 00 00 00 00 00 00
```

이를 `readDoubleLE(0)`로 읽으면 IEEE 754 해석이 완전히 달라진다:

```
LE 해석: sign=0, exp=0x000000000000, frac=0x0000000000A940
       → 2.1407e-319  (denormal, 손상)
```

반대로 `1.1`을 LE로 저장하면:

```
LE bytes: 9A 99 99 99 99 99 F1 3F
```

이를 `readDoubleLE(0)`로 읽으면 정상:

```
LE 해석: → 1.1  (정상)
```

### 3.2 손상값 공통 특성 — denormal

BE로 저장된 값을 LE로 잘못 읽으면, **지수 부분(exponent)**이 거의 0인 비트 패턴이 되어 IEEE 754 denormal(비정규 부동소수점)로 해석된다.

- IEEE 754 double의 최소 정규수(normal): `2.2250738585072014e-308`
- denormal 범위: `0 < |v| < 2.2250738585072014e-308`

실측 센서값(온도, RPM, 유량 등)이 이 범위에 우연히 들어오는 경우는 실무상 없다.

---

## 4. 우회 구현

### 4.1 핵심 아이디어

- BE→LE 잘못 읽기의 결과는 **반드시 denormal**이다.
- denormal을 탐지하면 바이트를 뒤집어(`LE → BE 재해석`) 원래 값을 복원한다.
- 실측값은 denormal이 아니므로 오탐 없이 적용 가능하다.

### 4.2 구현 코드 (`machbase/machbase.js`)

```js
const _fixBuf = Buffer.allocUnsafe(8);
const DOUBLE_MIN_NORMAL = 2.2250738585072014e-308;

function fixDoubleEndian(rows) {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const v = row[key];
      if (typeof v !== 'number') continue;
      if (v !== 0 && Math.abs(v) < DOUBLE_MIN_NORMAL) {
        // 라이브러리가 LE로 읽은 바이트를 BE로 재해석하면 원래 값이 나온다
        _fixBuf.writeDoubleLE(v, 0);
        row[key] = _fixBuf.readDoubleBE(0);
      }
    }
  }
  return rows;
}
```

`MachbaseClient.query()` 반환 직전에 모든 row에 적용한다.

```js
async query(sql, values) {
  const [rows] = await this.conn.query(sql, values);
  return fixDoubleEndian(rows || []);
}
```

### 4.3 보정 단계 상세

```
[서버]                    [라이브러리]              [fixDoubleEndian]       [결과]
  BE 저장: 40 A9 00 ...
    ─────────────────→  readDoubleLE → 2.14e-319
                                           ──────────────────────→ writeDoubleLE(2.14e-319)
                                                                   → 바이트: 40 A9 00 ...
                                                                   readDoubleBE → 3200.0  ✓
```

바이트 자체는 라이브러리가 올바르게 수신했다. 단지 `readDoubleLE`로 **해석만 잘못한 것**이므로, 같은 바이트를 `readDoubleBE`로 다시 해석하면 원래 값을 복원할 수 있다.

### 4.4 오탐 위험성 검토

| 상황 | 위험 여부 | 이유 |
|------|----------|------|
| 실측 센서값(온도/압력/RPM/유량 등) | 없음 | 실무 범위(~1e6)가 denormal과 무관 |
| 0.0 값 | 없음 | `v !== 0` 조건으로 제외 |
| NaN | 없음 | `Math.abs(NaN) < threshold`는 false |
| Infinity | 없음 | `Math.abs(Infinity)`는 Infinity |
| 정말 극소값이 데이터인 경우 | 이론적 가능 | 나노단위 물리량(e.g. 전자 전하량 ~1.6e-19)이라면 오탐 가능. 현 프로젝트 데이터 특성상 해당 없음 |

---

## 5. 영향 범위

### 5.1 영향을 받는 경우

- TAG 테이블 데이터 파티션에서 FLOAT 또는 DOUBLE 컬럼을 **읽는 쿼리** (`MachbaseClient.query()`)
- 파티션 인덱스에 따라 BE로 저장된 파티션만 영향

### 5.2 영향을 받지 않는 경우

- **쓰기(AppendStream)**: `encodeFieldValue()`가 `serverEndian`을 정상 반영하므로 쓰기는 올바르게 동작
- **정수 계열(INT, BIGINT, DATETIME)**: `decodeFixedField()`가 BE로 읽으므로 서버 저장 방식과 일치
- **VARCHAR / TEXT**: 가변 길이 필드로 별도 경로 처리
- **LOG 테이블**: 파티션 구조 없음. 단일 테이블이므로 endian 분기 없음(실측 확인)

---

## 6. 라이브러리 버그 위치 요약

```
node_modules/@machbase/ts-client/dist/connection.js

Line 1145: function decodeFixedField(column, field) {   ← 독립 함수, serverEndian 파라미터 없음
Line 1164:     case CMD_FLT32_TYPE:
Line 1165:         return field.readFloatLE(0);           ← 버그: 항상 LE
Line 1166:     case CMD_FLT64_TYPE:
Line 1167:         return field.readDoubleLE(0);          ← 버그: 항상 LE
```

수정 방향(참고용, 라이브러리 수정은 불필요):

```js
// 수정 예시 — decodeFixedField에 serverEndian 파라미터 추가
function decodeFixedField(column, field, serverEndian = 0) {
    // ...
    case CMD_FLT32_TYPE:
        return serverEndian === 0 ? field.readFloatLE(0) : field.readFloatBE(0);
    case CMD_FLT64_TYPE:
        return serverEndian === 0 ? field.readDoubleLE(0) : field.readDoubleBE(0);
}
```

---

## 7. 유지보수 지침

1. **라이브러리 업그레이드 시**: `decodeFixedField()`의 FLT32/FLT64 처리가 수정됐는지 확인. 수정됐다면 `fixDoubleEndian()`을 제거해도 무방.
2. **`npm install` 재실행 후**: 우회 코드가 `machbase/machbase.js` 프로젝트 코드에 있으므로 재발하지 않는다. 라이브러리를 교체해도 별도 조치 불필요.
3. **새 컬럼 타입 추가 시**: FLT32/FLT64 외 다른 부동소수점 타입이 추가된다면 `fixDoubleEndian()`의 `typeof v !== 'number'` 조건으로 자동 처리된다.
