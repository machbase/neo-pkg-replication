# Manual Integration Test

수동 통합 테스트는 장시간/재시작/설정 변경까지 포함한 운영형 검증용이다.  
짧고 안정적인 회귀 검증은 `neo-regress` 로 분리하고, 여기서는 실제 배포 직전 또는 기능 변경 후 종합 점검을 수행한다.

## 목적

- `native`, `http`, `mqtt-api`, `mqtt-publish` transport 조합을 실제 런타임 흐름으로 검증한다.
- live append, 신규 tag/meta, `kill -9` 후 재시작, drain 완료까지 한 번에 본다.
- `rep_target_cond`, `prefix/suffix` 변경처럼 정적 테스트만으로 놓치기 쉬운 경로를 별도로 검증한다.

## 비목표

- CI 수준의 빠른 반복 실행
- 모든 조합에서 수시간 soak를 기본으로 수행
- `mqtt-publish` append reply 검증

## 전제 조건

- Package:
  - `/home/thlee/machbase-neo/public/neo-pkg-replication`
- CGI base URL:
  - `http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin`
- 기본 `machbase-neo`:
  - `/home/thlee/machbase-neo/machbase-neo`
- 기본 server profile:
  - `local_native`
  - `local_http`
  - `local_mqtt_api`
  - `local_mqtt_publish`
- `mosquitto_sub`, `jq` 설치

## 저장 공간/시간 예산

- 실사용 저장 공간은 약 `5G` 안쪽으로 가정한다.
- 케이스당 최대 row는 `10,000,000` 미만으로 제한한다.
- 기본 quick run은 `2시간` 이내를 목표로 한다.
- 각 케이스 종료 후 job/table/process/log 산출물을 즉시 정리한다.

## 스크립트 위치

- [integration_helper.js](/home/thlee/works/test/neo-pkg-replication/cgi-bin/tests/manual/integration_helper.js)
- [run_db_case.sh](/home/thlee/works/test/neo-pkg-replication/cgi-bin/tests/manual/run_db_case.sh)
- [run_mqpub_case.sh](/home/thlee/works/test/neo-pkg-replication/cgi-bin/tests/manual/run_mqpub_case.sh)
- [run_config_change_cases.sh](/home/thlee/works/test/neo-pkg-replication/cgi-bin/tests/manual/run_config_change_cases.sh)

## 환경 변수

모든 shell runner는 아래 env override를 지원한다.

- `MACHBASE_NEO_BIN`
  - 기본값: `/home/thlee/machbase-neo/machbase-neo`
- `CGI_BASE_URL`
  - 기본값: `http://127.0.0.1:5654/public/neo-pkg-replication/cgi-bin`
- `MANUAL_LOG_FILE`
  - 기본값: `cgi-bin/docs/TESTLOG-manual-integration-YYYY-MM-DD.md`
- `MANUAL_TEST_DB_HOST`
- `MANUAL_TEST_DB_PORT`
- `MANUAL_TEST_DB_USER`
- `MANUAL_TEST_DB_PASSWORD`

## 케이스 naming 규칙

- `it1nn` = native -> native
- `it2nh` = native -> http
- `it3hn` = http -> native
- `it4hh` = http -> http
- `it5nm` = native -> mqtt-api
- `it6hm` = http -> mqtt-api
- `it7np` = native -> mqtt-publish
- `it8hp` = http -> mqtt-publish
- `it9rc` = `rep_target_cond` 변경
- `it10ps` = `prefix/suffix` 변경

## Quick Run 순서

### 1. DB target 케이스

```bash
chmod +x cgi-bin/tests/manual/run_db_case.sh

cgi-bin/tests/manual/run_db_case.sh it1nn local_native local_native IT1S IT1D 300 30 45 300 100
cgi-bin/tests/manual/run_db_case.sh it2nh local_native local_http   IT2S IT2D 300 30 45 300 100
cgi-bin/tests/manual/run_db_case.sh it3hn local_http   local_native IT3S IT3D 300 30 45 300 100
cgi-bin/tests/manual/run_db_case.sh it4hh local_http   local_http   IT4S IT4D 300 30 45 300 100
cgi-bin/tests/manual/run_db_case.sh it5nm local_native local_mqtt_api IT5S IT5D 300 30 45 300 100
cgi-bin/tests/manual/run_db_case.sh it6hm local_http   local_mqtt_api IT6S IT6D 300 30 45 300 100
```

### 2. mqtt-publish 케이스

```bash
chmod +x cgi-bin/tests/manual/run_mqpub_case.sh

cgi-bin/tests/manual/run_mqpub_case.sh it7np local_native IT7S IT7D it/7np 300 30 45 300 100
cgi-bin/tests/manual/run_mqpub_case.sh it8hp local_http   IT8S IT8D it/8hp 300 30 45 300 100
```

### 3. 설정 변경 케이스

```bash
chmod +x cgi-bin/tests/manual/run_config_change_cases.sh

cgi-bin/tests/manual/run_config_change_cases.sh
```

## 검증 포인트

### DB target 케이스

- pre-generate 후 initial drain 완료
- live generate 중 `kill -9`
- restart 후 final drain 완료
- `summary`, `verify` 통과
- row/meta count가 source/target에서 최종 일치

### mqtt-publish 케이스

- `target.topic` 으로 subscriber 수신
- payload에 metadata column 포함
- source 총 row 수와 subscriber 누적 row 수 일치
- `kill -9` 후 재시작 뒤에도 publish 흐름 지속

### 설정 변경 케이스

- `rep_target_cond` 변경 후 새 조건에 해당하는 tag row 확인
- `prefix/suffix` 변경 후 변환된 canonical name row 확인

## 로그 정책

- 실행 로그:
  - `cgi-bin/docs/TESTLOG-manual-integration-*.md`
- 중간 generate 출력:
  - `*_pre_generate.jsonl`
  - `*_live_generate.jsonl`
- mqtt payload capture:
  - `*_mqtt_payload.jsonl`

위 파일은 모두 참고용이며 **커밋 대상이 아니다**.

## Cleanup 원칙

각 케이스 종료 후 반드시:

- replication job delete
- source/target table drop
- subscriber/background process 종료
- generate/payload 임시 파일 삭제

실패로 중간 종료됐더라도 `integration_helper.js cleanup ...` 로 잔여 테이블을 정리한다.

## 수동 점검 명령 예시

```bash
/home/thlee/machbase-neo/machbase-neo jsh cgi-bin/tests/manual/integration_helper.js counts IT1S IT1D
/home/thlee/machbase-neo/machbase-neo jsh cgi-bin/tests/manual/integration_helper.js sample IT1D 5
/home/thlee/machbase-neo/machbase-neo jsh cgi-bin/tests/manual/integration_helper.js tail-by-name IT9D TAG-0100 3
/home/thlee/machbase-neo/machbase-neo jsh cgi-bin/tests/manual/integration_helper.js cleanup IT1S IT1D
```
