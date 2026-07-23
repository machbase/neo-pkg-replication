---
title: 문제 해결
weight: 50
---

# 문제 해결

이 문서는 Replication 화면에서 자주 만나는 증상을 기준으로 가능한 원인과 점검 순서를 설명합니다.

## 1. 서버 또는 테이블을 선택할 수 없음

### Source 서버가 목록에 없음

다음 항목을 확인합니다.

1. Server Settings에 서버가 등록되어 있는지 확인합니다.
2. 연결 테스트를 수행합니다.
3. 서버 유형이 `native` 또는 `http`인지 확인합니다.

`mqtt-api`, `mqtt-publish`는 Target 전용이므로 Source 목록에 나타나지 않는 것이 정상입니다.

### 테이블 목록이 비어 있거나 원하는 테이블이 없음

다음 항목을 확인합니다.

1. 올바른 서버와 Port를 선택했는지 확인합니다.
2. 연결 계정으로 테이블을 조회할 수 있는지 확인합니다.
3. 실제 DB에 테이블이 존재하는지 확인합니다.

Replication 화면에는 로컬 DB의 TAG/LOG 논리 테이블만 표시됩니다. mounted DB 또는 backup 테이블이 목록에 나타나지 않는 것은 정상입니다.

Target이 `mqtt-publish`라면 테이블 목록 대신 Topic 입력 칸이 표시됩니다.

## 2. Job 저장 또는 검증에 실패함

### Target이 `mqtt-publish`일 때 저장되지 않음

Topic에 공백, `+`, `#`가 포함되어 있거나 `/`로 시작하거나 끝나는지 확인합니다.
일반적으로 영문자, 숫자, `.`, `_`, `-`, `/` 조합을 사용합니다.

### Validation Warnings가 표시됨

Validation Warnings는 저장할 수 없는 오류와 다릅니다. Source/Target 매핑과 조건을 다시 확인한 뒤, 의도한 설정이 맞다면 `Save Anyway`를 선택할 수 있습니다.

### Source와 Target이 같은 테이블이라는 오류가 표시됨

같은 Machbase Neo 인스턴스의 동일한 물리 테이블을 Source와 Target으로 지정할 수 없습니다. Server 이름이 다르더라도 실제로 같은 인스턴스와 테이블을 가리키면 저장이 거부됩니다.

Source 또는 Target 테이블을 다른 테이블로 변경한 뒤 다시 저장합니다.

## 3. Job을 등록, 시작, 수정 또는 삭제할 수 없음

### Job이 생성됐지만 바로 시작되지 않음

Job 설정은 존재하지만 service 등록이 완료되지 않은 config-only 상태일 수 있습니다.

1. 사이드바에서 Job 오른쪽에 `Register` 버튼이 있는지 확인합니다.
2. `Register`를 눌러 service 등록을 다시 시도합니다.
3. 등록 후 스위치가 나타나면 Job을 시작합니다.

일반적인 생성 흐름에서는 Job이 자동으로 등록되고 시작됩니다.

### Edit 또는 Delete 버튼이 비활성화됨

실행 중인 Job은 수정하거나 삭제할 수 없습니다. 사이드바의 스위치로 Job을 먼저 정지한 뒤 다시 시도합니다.

### Server를 삭제할 수 없음

삭제하려는 Server를 Source 또는 Target으로 사용하는 Job이 있으면 Server 삭제가 거부됩니다.

1. 오류 메시지에 표시된 Job을 확인합니다.
2. 해당 Job의 서버 설정을 변경하거나 Job을 삭제합니다.
3. Server 삭제를 다시 시도합니다.

## 4. 복제된 데이터가 기대보다 적음

다음 설정을 확인합니다.

- `Replication Target Condition`이 `IN` 또는 `LIKE`로 좁게 설정되어 있는지
- Data Pipeline Builder에 범위 `filter`가 적용되어 있는지
- 초기 전체 복제가 필요한데 Start Mode를 `Now`로 사용했는지
- Source와 Target의 컬럼 매핑에서 필요한 Source 컬럼이 비활성화되어 있는지

`Now`는 Job을 처음 시작한 시점 이후의 새 데이터만 처리합니다. 기존 데이터까지 복제해야 한다면 `Full`을 사용합니다.

## 5. TAG 메타데이터 동기화가 지연되거나 실패함

TAG 테이블을 `native` 또는 `http` Target으로 복제할 때는 필요한 TAG 메타데이터가 데이터보다 먼저 동기화됩니다. 메타데이터 동기화가 완료되지 않으면 해당 데이터 저장이 대기할 수 있습니다.

다음 순서로 확인합니다.

1. Live Logs를 열고 `meta_sync` 관련 WARN 또는 ERROR 메시지를 찾습니다.
2. Source와 Target 연결이 모두 정상인지 확인합니다.
3. Target 계정으로 TAG 메타데이터를 등록하거나 수정할 수 있는지 확인합니다.
4. Source/Target 메타 컬럼 매핑이 의도한 구성이 맞는지 확인합니다.

신규 태그 또는 변경된 태그 이름과 메타데이터를 처리하는 동안 일시적으로 복제가 대기하는 것은 정상일 수 있습니다.

## 6. 대시보드에 warning이 표시됨

대표적인 원인은 다음과 같습니다.

- Source 또는 Target 테이블이 삭제되거나 변경됨
- 테이블 row count 조회에 실패함
- Server 연결이 일시적으로 실패함

먼저 대시보드 상단의 warning 문구를 읽고 Source/Target 서버와 테이블이 실제로 존재하는지 확인합니다. 오류가 계속되면 Live Logs를 열고, 이전 기록이 필요하면 Log Files에서 로그 파일을 확인합니다.

## 7. Live Logs가 비어 있거나 연결되지 않음

Live Logs 연결은 팝업을 열 때 시작되고 닫을 때 종료됩니다.

다음 항목을 확인합니다.

1. 대시보드 상단의 `Live Logs` 버튼으로 팝업을 엽니다.
2. 팝업의 연결 상태가 `CONNECTED`인지 확인합니다.
3. Job 상태가 `running`인지 확인합니다.
4. `Pause` 상태라면 `Resume`을 누릅니다.
5. 로그 레벨이 `WARN` 또는 `ERROR`라서 새 로그가 거의 없는 상태인지 확인합니다.

Live Logs는 연결 이후 생성되는 최신 로그를 보여줍니다. 이전 기록을 보거나 로그를 보관해야 한다면 Log Files에서 파일을 열거나 다운로드합니다.

## 8. 로그 파일이 너무 빨리 증가함

일반 운영에서는 `INFO` 또는 `WARN`을 사용하고, 상세 분석이 필요할 때만 `DEBUG` 또는 `TRACE`를 사용합니다.

- active 로그 파일은 10MB에 도달하면 자동으로 회전됩니다.
- `File Limit`을 줄이면 보관되는 전체 로그 파일 수가 줄어듭니다.
- 로그 시각은 Machbase Neo 호스트의 로컬 시간대를 기준으로 표시됩니다.

## 9. Source 또는 Target 변경 후 설정이 달라짐

서버나 테이블을 변경할 때 이전 스키마 설정이 남지 않도록 관련 항목이 초기화될 수 있습니다.

- 서버를 변경하면 테이블 선택과 컬럼/메타 매핑이 초기화됩니다.
- 테이블을 변경하면 컬럼/메타 매핑이 초기화됩니다.
- Source 테이블을 변경하면 Replication Target Condition과 Data Pipeline Builder 규칙이 초기화될 수 있습니다.

변경 후에는 테이블 선택, Column Mapping, Replication Target Condition, Data Pipeline Builder를 순서대로 다시 확인합니다.

## 문서 이동

- [이전: 모니터링과 로그 확인](./monitoring-and-logs.kr.md)
- [목차로 돌아가기](./index.kr.md)
