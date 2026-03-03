# File (file/file.js)

## 역할

JSON 파일 atomic read/write (BigInt 지원).

## 잘 된 점

- `.${process.hrtime.bigint()}.tmp` 타임스탬프로 tmp 파일 충돌 없는 atomic write 구현.
- BigInt reviver를 `_bigintKeys` Set 기반으로 키 단위 처리하여 오파싱 위험 없음.
- `write()`에서 `data === null` 명시 체크 후 TypeError 발생.

## 문제점

### #1 — `write()`: rename 실패 시 .tmp 파일 누적 [Minor] ✅ 완료

```js
await fs.writeFile(tmpPath, content, 'utf-8');
await fs.rename(tmpPath, this.fullPath);
```

`writeFile` 성공 후 `rename`이 실패하면 `.tmp` 파일이 디렉토리에 영구적으로 남는다. 디스크 낭비 및 체크포인트 디렉토리 오염.

**수정**: rename 실패 시 `fs.unlink(tmpPath).catch(() => {})` try/catch 처리 추가.
