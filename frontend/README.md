# repli-web — Replication Dashboard

Machbase(시계열 데이터베이스) 테이블 간 데이터 복제(replication) 도구의 웹 관리 대시보드.
Job 생성/수정/삭제, Server 설정, 복제 상태 모니터링을 제공한다.

### 용어


| 용어       | 설명                                                 |
| -------- | -------------------------------------------------- |
| Machbase | 시계열 데이터베이스. TAG 테이블(태그 기반 시계열)과 LOG 테이블(범용 로그)을 지원 |
| RID      | Row ID. Machbase 내부 행 식별자. 복제 시 어디까지 읽었는지 추적하는 기준값 |
| Job      | 하나의 소스→타겟 복제 작업 단위 (어떤 서버의 어떤 테이블을 어디로 복제할지 정의)    |
| Server   | Machbase DB 접속 정보 (host, port, user, password)     |
| Neo      | Machbase Neo 웹앱 프레임워크. 이 대시보드를 임베딩하여 서빙하는 호스트 환경   |


## 기술 스택


| 항목                     | 버전                     |
| ---------------------- | ---------------------- |
| React                  | 19                     |
| React Router           | 7 (HashRouter)         |
| Tailwind CSS           | 4                      |
| Vite                   | 6                      |
| vite-plugin-singlefile | 2.3 (빌드 시 단일 HTML로 번들) |


## 실행

```bash
# 의존성 설치
npm install

# 개발 서버 (Vite dev server + API proxy)
# 주의: 백엔드 API 서버가 localhost:8080에서 실행 중이어야 한다
# (프로젝트 루트에서 node app.js 실행)
npm run dev

# 프로덕션 빌드 (web/dist/index.html 단일 파일 생성)
npm run build
```

## 환경변수


| 변수              | 설명            | 기본값                         |
| --------------- | ------------- | --------------------------- |
| `VITE_API_BASE` | API 요청 경로 접두사 | `/web/apps/neo-replication` |


- **Neo 웹앱 프레임워크** (`.env`): `/web/apps/neo-replication` — Neo가 리버스 프록시로 백엔드에 전달
- **독립 실행 / 개발** (`.env.development`): 빈 문자열 — Vite proxy가 `/api/`*를 `localhost:8080`으로 전달

`.env` 파일은 gitignore 대상이므로 클론 후 존재하지 않는다. 미설정 시 코드 내 기본값(`/web/apps/neo-replication`)이 적용된다. 개발 시 Vite proxy를 사용하려면 `web/.env.development` 파일을 생성하고 `VITE_API_BASE=`(빈 값)을 설정해야 한다.

## 멀티 엔트리 아키텍처

3개의 독립 HTML 파일로 빌드된다. `vite-plugin-singlefile`이 각각을 단일 HTML로 번들링한다.


| 엔트리          | 컴포넌트       | 엔트리포인트           | 역할                               |
| ------------ | ---------- | ---------------- | -------------------------------- |
| `index.html` | `IndexApp` | `index-main.jsx` | 사이드바 + 메인 콘텐츠 통합 (단독 실행용)        |
| `main.html`  | `App`      | `main.jsx`       | 메인 콘텐츠 영역 (BroadcastChannel 수신)  |
| `side.html`  | `SideApp`  | `side-main.jsx`  | 사이드바 전용 패널 (BroadcastChannel 송신) |


`BroadcastChannel` API로 **창 간 상태 동기화**를 구현하여, 사이드바와 메인 콘텐츠를 별도 창(Neo 프레임워크의 멀티 패널)에서도 연동할 수 있다.

### BroadcastChannel 메시지


| 메시지 타입         | 방향         | 설명                  |
| -------------- | ---------- | ------------------- |
| `ready`        | App → Side | App이 준비 완료됨         |
| `requestReady` | Side → App | Side가 동기화 요청        |
| `jobsData`     | App → Side | Job 목록 전달           |
| `jobSelected`  | App → Side | 선택된 Job ID 전달       |
| `selectJob`    | Side → App | Side에서 Job 선택       |
| `toggleJob`    | Side → App | Side에서 Job 시작/정지 토글 |
| `navigate`     | Side → App | Side에서 라우트 이동 요청    |


## 디렉토리 구조

```
src/
├── main.jsx                          # 엔트리: main.html (HashRouter + AppProvider + App)
├── index-main.jsx                    # 엔트리: index.html (HashRouter + AppProvider + IndexApp)
├── side-main.jsx                     # 엔트리: side.html (SideApp, 라우터 없음)
├── App.jsx                           # 메인 앱 (라우팅 + BroadcastChannel 수신)
├── IndexApp.jsx                      # 통합 앱 (Sidebar 포함)
├── SideApp.jsx                       # 사이드바 전용 앱 (BroadcastChannel 송신)
│
├── api/                              # HTTP 통신 계층
│   ├── client.js                     #   공통 fetch 래퍼 (ApiError, API_BASE)
│   ├── jobs.js                       #   Job CRUD + start/stop API
│   └── servers.js                    #   Server CRUD + health/tables/schema API
│
├── context/
│   └── AppContext.jsx                # 전역 상태 (selectedJobId, notifications)
│
├── hooks/                            # 비즈니스 로직 hooks
│   ├── useJobs.js                    #   Job 목록 폴링(5초) + toggle/remove
│   ├── useServers.js                 #   Server CRUD + healthCheck
│   └── useTableSchema.js            #   테이블/컬럼 스키마 조회
│
├── pages/                            # 라우트별 페이지 컴포넌트
│   ├── DashboardPage.jsx             #   Job 상세 대시보드 (선택된 Job 정보 표시)
│   ├── JobFormPage.jsx               #   Job 생성/수정 폼 (상태 관리 + 섹션 조합)
│   └── ServerSettingsPage.jsx        #   Server 설정 CRUD
│
├── components/
│   ├── common/                       # 범용 UI 컴포넌트
│   │   ├── Icon.jsx                  #   Material Symbols 아이콘 래퍼
│   │   ├── Toast.jsx                 #   토스트 알림 (4초 자동 소멸)
│   │   ├── StatusBadge.jsx           #   Live Sync/Stopped 상태 배지
│   │   └── ConfirmDialog.jsx         #   삭제 확인 모달
│   │
│   ├── layout/
│   │   └── Sidebar.jsx               #   좌측 고정 네비게이션 (Job 목록 + Settings 링크)
│   │
│   ├── jobs/                         # Job 관련 컴포넌트
│   │   ├── JobListItem.jsx           #   사이드바 Job 항목 (start/stop 토글)
│   │   ├── SourceSection.jsx         #   소스 설정 (서버/테이블/컬럼/autoCreate/태그식별자)
│   │   ├── TargetSection.jsx         #   타겟 설정 (서버/테이블)
│   │   ├── ExecutionSection.jsx      #   실행 설정 (startMode/queryLimit/pollInterval 등)
│   │   └── AdvancedSection.jsx       #   고급 설정 (shutdownTimeout/integrity/retry)
│   │
│   ├── dashboard/                    # 대시보드 표시 컴포넌트
│   │   ├── JobDetailHeader.jsx       #   Job 제목 + 편집/삭제 버튼
│   │   ├── SourceConfigCard.jsx      #   소스 설정 표시 카드 (스키마 API 호출하여 컬럼 타입 보강)
│   │   └── TargetConfigCard.jsx      #   타겟 설정 표시 카드
│   │
│   └── servers/
│       └── ServerForm.jsx            #   Server 추가/수정 모달 폼
│
└── styles/
    └── index.css                     # Tailwind import + 테마 색상 + 애니메이션
```

## 아키텍처

### 데이터 흐름

```
main.jsx
  └─ AppProvider (전역: selectedJobId, notifications, notify)
       └─ App.jsx
            ├─ useJobs()     → jobs, toggleJob, removeJob, refreshJobs
            ├─ useServers()  → servers, loading, addServer, editServer, removeServer, healthCheck
            │
            ├─ Sidebar       ← jobs, onToggleJob
            ├─ Route /           → DashboardPage    ← jobs, servers, onDelete
            ├─ Route /jobs/new   → JobFormPage       ← servers, onRefresh
            ├─ Route /jobs/:id/edit → JobFormPage    ← servers, onRefresh
            ├─ Route /servers    → ServerSettingsPage ← servers, loading, onAdd/Edit/Delete/HealthCheck
            └─ Toast (전역 토스트 알림, 라우트 외부에서 렌더링)
```

### API 계층

`api/client.js`가 공통 `request(method, path, body)` 함수를 제공하고, `api/jobs.js`와 `api/servers.js`가 도메인별로 래핑한다.

- 백엔드 응답 형식: `{ ok: boolean, data: any, reason?: string }`
- `request()` 함수가 응답을 unwrap하여 `data`만 반환. 에러 시 `ApiError` throw (`status`, `reason` 프로퍼티)
- `API_BASE` 환경변수로 경로 접두사 결정

### Hooks 패턴

CRUD 성격의 hook 메서드는 다음 에러 처리 패턴을 따른다:

```
try {
  await apiCall()
  notify(성공 메시지, 'success')
} catch (e) {
  notify(e.reason || e.message, 'error')
  throw e  // caller의 흐름 제어용 — useServers의 mutation 메서드만 throw
}
```

- `useJobs`: catch에서 notify만 하고 에러를 삼킴 (caller에 전파하지 않음)
- `useServers`: mutation 메서드는 notify + throw (caller가 폼 닫기 방지 등 흐름 제어 가능). `healthCheck`는 에러 처리 없이 caller에 위임
- `useTableSchema`: catch에서 notify만 하고 에러를 삼킴


| Hook             | 폴링                      | 에러 알림 | 용도                             |
| ---------------- | ----------------------- | ----- | ------------------------------ |
| `useJobs`        | 5초 interval             | O     | Job 목록 조회 + start/stop 토글 + 삭제 |
| `useServers`     | 없음 (mutation 후 refetch) | O     | Server CRUD + healthCheck      |
| `useTableSchema` | 없음                      | O     | 테이블/컬럼 스키마 조회                  |


### JobFormPage 구조

`JobFormPage.jsx`는 폼 상태 관리만 담당하고, 실제 UI 렌더링은 4개 섹션 컴포넌트에 위임한다:

```
JobFormPage (상태 관리 + 섹션 조합)
  ├─ DEFAULTS 객체 (폼 초기값)
  ├─ form state + update() helper
  ├─ useTableSchema() (소스 테이블/컬럼 조회)
  ├─ handleSubmit (payload 구성 + API 호출)
  │
  ├─ <SourceSection>      ← 소스 서버/테이블/컬럼/autoCreate/태그식별자
  ├─ <TargetSection>      ← 타겟 서버/테이블
  ├─ <ExecutionSection>   ← startMode/queryLimit/pollInterval 등
  └─ <AdvancedSection>    ← shutdownTimeout/integrity/retry (접이식)
```

`**update(path, value)` 함수**: dot-notation 경로로 중첩 상태를 불변 업데이트한다.
예: `update('source.tagIdentifier.mode', 'prefix')` → `form.source.tagIdentifier.mode`를 변경하면서 각 레벨을 shallow copy.

**autoCreate**: `SourceSection`의 컬럼 선택 UI 바로 아래에 배치. 체크 시 `update('source.columns', null)` 호출하여 전체 컬럼 복제를 강제하고 컬럼 선택을 비활성화한다. 설정값은 `target.autoCreate`에 저장된다.

## 라우팅

HashRouter 기반 (`/#/path` 형식). 이 앱은 단일 HTML 파일로 빌드되어 Neo 프레임워크 안에 임베딩되므로, URL 경로를 Neo가 관리한다. 임베딩된 앱이 URL 경로를 점유하지 않도록 Hash 라우팅을 사용한다.


| 경로               | 페이지                | 설명             |
| ---------------- | ------------------ | -------------- |
| `/`              | DashboardPage      | 선택된 Job 상세 정보  |
| `/jobs/new`      | JobFormPage        | 새 Job 생성       |
| `/jobs/:id/edit` | JobFormPage        | 기존 Job 수정      |
| `/servers`       | ServerSettingsPage | Server 설정 CRUD |


## 디자인 시스템

`src/styles/index.css`에 **Neo 디자인 토큰**이 정의되어 있다.

- **테마**: 다크 테마 기반 (`#1e1e1e` surface, `#005fb8` primary)
- **폰트**: Pretendard(본문) + D2Coding(코드)
- **아이콘**: Material Symbols Outlined (Google Fonts CDN)
- **컴포넌트 클래스**: `.btn`, `.card`, `.modal`, `.toast`, `.switch`, `.badge`, `.side` 등

## 빌드 산출물

`npm run build` 실행 시 3개의 엔트리(`index.html`, `main.html`, `side.html`)를 각각 빌드한다. `vite-plugin-singlefile`이 JS/CSS를 모두 인라인하여 단일 HTML 파일로 생성한다.

```bash
npm run build
# vite build                          → dist/index.html
# VITE_ENTRY=main vite build          → dist/main.html
# VITE_ENTRY=side vite build          → dist/side.html
```

## 백엔드 API 엔드포인트

프론트엔드가 사용하는 API 목록:

**Jobs**

- `GET /api/jobs` — 전체 Job 목록 (상태 포함)
- `GET /api/jobs/:id` — Job 상세
- `POST /api/jobs` — Job 생성
- `PUT /api/jobs/:id` — Job 수정 (stopped 상태에서만)
- `DELETE /api/jobs/:id` — Job 삭제 (stopped 상태에서만)
- `POST /api/jobs/:id/start` — Job 시작
- `POST /api/jobs/:id/stop` — Job 정지

**Servers**

- `GET /api/servers` — 전체 Server 목록
- `GET /api/servers/:name` — Server 상세
- `POST /api/servers` — Server 추가
- `PUT /api/servers/:name` — Server 수정
- `DELETE /api/servers/:name` — Server 삭제
- `GET /api/servers/:name/health` — 연결 테스트
- `GET /api/servers/:name/tables` — 테이블 목록
- `GET /api/servers/:name/tables/:table/schema` — 컬럼 스키마

