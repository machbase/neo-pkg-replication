# Neo-regress Phase 1 Plan

`neo-regress` 1차 목표는 "핵심 기능이 깨졌는지 빠르게 검출"하는 것이다.  
장시간 부하, soak, subscriber 기반 `mqtt-publish` 검증은 수동 통합 테스트로 분리한다.

## 기준

- 짧고 결정적인 시나리오만 포함한다.
- count + sample + 핵심 경계조건 위주로 검증한다.
- flaky 해지기 쉬운 장시간 churn, 다중 restart 반복은 제외한다.

## 2026-04-17 수동 통합 테스트 기준

수동 통합 테스트에서는 아래가 모두 통과했다.

- `native -> native`
- `native -> http`
- `http -> native`
- `http -> http`
- `native -> mqtt-api`
- `http -> mqtt-api`
- `native -> mqtt-publish`
- `http -> mqtt-publish`
- `rep_target_cond` 변경
- `prefix/suffix` 변경

이 결과를 바탕으로, `neo-regress` 1차에는 DB 기반으로 짧게 검증 가능한 항목만 우선 넣는다.

## Phase 1 포함 항목

### 1. native -> native static

- 이유:
  - 가장 많이 사용하는 기본 조합
  - 다른 조합 실패 시 기준선 역할
- 검증:
  - count
  - sample row
  - sample metadata

### 2. native -> native kill/restart

- 이유:
  - restart correctness baseline
- 검증:
  - 입력 중 `kill -9`
  - restart
  - drain 후 최종 count 일치

### 3. native -> http static

- 이유:
  - 대표 cross-transport
- 검증:
  - count
  - sample row
  - metadata count

### 4. http -> native static

- 이유:
  - http source 경로 대표
- 검증:
  - count
  - sample row
  - timestamp sample

### 5. http -> http static

- 이유:
  - source/target 모두 http 경로
- 검증:
  - count
  - sample row

### 6. native -> mqtt-api static

- 이유:
  - write-only target 대표
- 검증:
  - count
  - sample row
  - metadata count

### 7. http -> mqtt-api static

- 이유:
  - http source + mqtt-api target 조합 대표
- 검증:
  - count
  - sample row

### 8. rep_target_cond 변경

- 이유:
  - metadata diff 경로와 최근 정책 변경을 반영하는 핵심 시나리오
- 검증:
  - 초기 filtered copy
  - 조건 변경 후 restart
  - 새 조건에 해당하는 tag row 확인

### 9. prefix/suffix 변경

- 이유:
  - name transform 변경 시 metadata 재동기화 경로 확인
- 검증:
  - transform 변경 후 restart
  - 새 canonical name row 확인

## Phase 1 제외 항목

### mqtt-publish

- 이유:
  - DB query만으로는 검증할 수 없음
  - subscriber fixture가 필요
- 상태:
  - 수동 통합 테스트에서는 통과
  - `neo-regress`에는 subscriber fixture 준비 후 2차로 추가

### soak / 장시간 churn

- 이유:
  - regress 성격과 맞지 않음
  - 시간 편차와 flaky 위험이 큼

### 대량 10만+ row churn

- 이유:
  - 회귀 검증 대비 비용이 큼
  - 수동 통합 테스트에서 이미 담당

## 권장 tc 배치

- `60_static_native_native.tc`
- `61_restart_native_native.tc`
- `62_static_native_http.tc`
- `63_static_http_native.tc`
- `64_static_http_http.tc`
- `65_static_native_mqtt_api.tc`
- `66_static_http_mqtt_api.tc`
- `70_change_rep_target_cond.tc`
- `71_change_prefix_suffix.tc`

## assertion 원칙

- 전체 snapshot 대신 count + sample row 중심
- metadata는 sample + total count 확인
- restart는 "중단 후 복구" 자체를 보기 때문에 중간 상세 로그보다는 최종 drain 결과를 우선한다
- transport별 차이는 최소 assertion으로 유지한다

## 2차 확장 후보

- `mqtt-publish` subscriber fixture 기반 tc
- `native -> http` kill/restart를 cross-transport regress로 추가
- metadata-only / ordinary restart data-driven sync 시나리오 세분화
