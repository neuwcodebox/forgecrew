# ForgeCrew — 기술 설계

[SPEC](SPEC.md)의 동작을 구현하기 위한 기준 설계다. 외부 런타임의 사실은 문서 끝의 공식 자료를 근거로 한다. 아래 상태·API·패키지 구조는 ForgeCrew가 구현할 계약이며, 이미 구현되었다는 의미가 아니다.

## 1. 기술 스택과 구성

| 영역 | 선택 |
|---|---|
| 언어·실행 | TypeScript, Node.js LTS |
| 저장소 구성 | npm workspaces, 공통 프로토콜·도메인 타입 공유 |
| Dispatcher HTTP | Hono + Node.js 어댑터 |
| 중앙 상태 | SQLite + Drizzle ORM, `better-sqlite3` 드라이버 |
| 공통 설정 | 단일 YAML 1.2 + 스키마 검증, 비밀 없는 revision 스냅샷 배포 |
| Dispatcher GitHub | Octokit REST 클라이언트 + PAT + 사내 GHES API base URL |
| Worker GitHub | 로그인된 `gh` CLI의 구조화된 JSON 응답 |
| Codex | 로컬 `codex app-server`, JSON-RPC/stdio |
| Claude | 공식 `claude -p`, 구조화된 JSON 스트림과 명시적 세션 ID |
| Worker 제어 통신 | Worker가 시작하는 HTTP 요청·long polling |
| 빌드·시험 | TypeScript 검사, tsdown JS 번들, Vitest, Windows/Linux 통합 시험 |
| 배포 | Dispatcher Docker 이미지, Worker 사내 npm 패키지 |

Node.js에서 Hono를 구동하고 Drizzle로 SQLite를 사용하는 경로는 공식 지원 구성을 사용한다.[S16][S17] 정확한 의존성 버전과 Node `engines` 범위는 P1에서 고정하고 lockfile을 커밋한다. SQLite 네이티브 드라이버는 Dispatcher에만 포함한다. Worker 패키지는 빌드된 JS와 필요한 런타임 의존성만 담고 Node.js·개발 도구체인·AI 실행 파일을 동봉하지 않는다. Worker production 의존성은 번들하거나 재현 가능한 고정 배포로 관리한다.

```text
GitHub Enterprise Server
  ▲              ▲
  │ REST/PAT     │ gh / Git, 동료 계정
  │ 폴링·라벨    │ 조회·답변·코드 작업
  │              │
Dispatcher       Worker PC 여러 대
  ├─ Poller        └─ 로컬 Node.js
  ├─ SQLite            └─ Launcher (안정적인 진입점)
  ├─ Scheduler             └─ ForgeCrew 버전별 프로세스
  ├─ Config snapshots          ├─ 공통 설정 캐시·지침 적용
  └─ Worker API                ├─ 업데이트·재접속·실행 관리
          ▲                    ├─ 격리된 세션 A → Codex/Claude
          └── outbound HTTP ───└─ 격리된 세션 B → Codex/Claude
```

관련 요구: F4–F6, F11, N1, N2, N5.

## 2. 상태 소유권과 인증

| 대상 | 기준 상태·자격 증명 | 책임 |
|---|---|---|
| GitHub | 원본 본문·댓글·라벨·Git 상태 | 사용자의 대화와 작업 결과 |
| Dispatcher | SQLite, 운영자가 설정한 PAT | 수집 커서·큐·배정·Lease·수락 결과·게시 작업, 배정/상태 라벨 |
| 중앙 설정 | 운영자가 관리하는 단일 YAML·비밀값 참조 | 검증된 공통 정책·지침·표기, revision별 스냅샷 |
| Worker | 고유 ID·플랫폼 인증 토큰, 로컬 저널 | 실행·작업 공간·미전달 결과·프로세스 상태 |
| 동료 환경 | `gh` 로그인, Git 설정, Codex/Claude 구독 로그인 | 실제 GitHub 작업·AI 실행의 계정과 권한 |

- Worker 프로세스는 설치한 동료 사용자로 실행한다. OS 서비스용 별도 시스템 사용자로 바꾸어 로그인 저장소·키체인·HOME을 잃지 않는다.
- Worker ID는 PC의 플랫폼 식별자이며 GitHub 로그인명과 다르다. 같은 사람이 PC 두 대를 등록할 수 있다. ID·플랫폼 인증은 버전 디렉터리 밖에 보존한다.
- 초기 등록은 운영자가 제공한 등록용 비밀값으로 수행하고, 등록 후에는 Worker별 토큰으로 인증한다. Dispatcher는 토큰 해시를 저장하고 폐기할 수 있게 한다. 재시도되는 등록 요청에도 같은 ID를 사용한다.
- Worker는 `gh api --hostname <사내 호스트>`로 실제 계정과 접근 권한을 확인한다. 공개 GitHub 기본 호스트에 의존하지 않는다. `gh` 로그인과 Git HTTPS credential helper 설정은 구별하여 진단한다.[S11]
- Git 작성자·서명은 로컬 Git 설정을 따른다. `gh` 로그인명으로 `user.name`·`user.email`을 덮어쓰지 않는다.
- Dispatcher PAT를 Worker의 `GH_TOKEN` 등에 주입하지 않는다. Worker의 구독·GitHub 토큰을 추출·전송·중앙 보관하지 않는다.
- 프록시·사내 CA·PATH·사용자 지침은 로컬 환경을 사용한다. TLS 검증을 끄는 방식으로 인증서 문제를 숨기지 않는다.

### 요청 권한

저장소별 실제 권한 조회 결과로 Write 이상을 판단한다. GitHub의 collaborator permission은 maintain을 write로 나타낼 수 있으므로 표시 이름만 비교하지 않는다.[S10] 짧은 권한 캐시를 사용할 수 있으나 실행 직전의 검증과 변경 감지를 둔다. 권한 조회 실패는 허용으로 간주하지 않고 입력을 보류한다.

본문의 최초 실행은 활성화 라벨을 붙인 Write 이상 사용자가 지정한 요청이다. 최초 발견 시 Issue events/timeline에서 활성화 행위자를 확인한다. 모델·effort 변경도 행위자 권한을 검증한 설정 revision으로 저장한다. 단순 현재 라벨 스냅샷만 보고 Triage 사용자의 변경을 실행 설정으로 받아들이지 않는다. 권한 증거를 확보하지 못하면 상태를 표시하고, 이후 권한 있는 새 요청·재활성화로 해소한다.

관련 요구: F1, F10, F12, N4.

## 3. 영속 데이터와 실행 상태

### Dispatcher의 논리 레코드

| 레코드 | 주요 내용 |
|---|---|
| Repository | GHES 호스트·저장소 ID·이름, 허용 여부, 기본 모델/effort |
| Session | 객체 종류·번호, 활성화 epoch, 승인된 설정 revision, 배정 Worker, 상태 |
| Input | 원본 종류·ID·작성자·작성/수정 시각, 본문 revision, FIFO 순서, 처리 상태 |
| Turn | Input 연결, 논리 상태, 선택 모델/effort, `runConfigRevision`, 결과 |
| Attempt | Turn, Worker, generation, Lease, 실행/종료 시각, 중단 사유, 런타임 세션 ID 참조 |
| Worker | ID·GitHub 계정 ID, 활성 엔진·모델 목록·저장소 접근·슬롯·버전·Heartbeat |
| PollCursor | 저장소·조회 종류별 high-water mark, 조건부 요청 정보, 동기화 상태 |
| Control | 원본 댓글 ID, 대상 Attempt, stop/steer, 전달·적용 결과 |
| Delivery | 출력 ID·본문 원문·최종 게시 본문·출력 종류·`outputConfigRevision`·본문 해시·예상 작성자·게시 대상·게시 권한·GitHub 댓글 ID |
| ConfigSnapshot | 비밀 없는 정규화 설정, schema version, 내용 해시인 revision, 활성 시각, 지원 계약 |

이는 별도 서비스가 아닌 SQLite 안의 개념이다. `UNIQUE(host, source_kind, source_id)`와 세션별 활성 Attempt 제약, 트랜잭션 기반 Claim으로 중복을 막는다. 권한을 잃은 이전 Attempt가 새 generation에 영향을 주지 못하게 모든 보고에 식별자를 포함한다.

### 상태를 분리한다

- **Session:** active 또는 inactive. 대기·실행·오류 표시는 그 아래 작업에서 계산한다.
- **Input:** queued → dispatched → consumed; 편집·삭제·권한 오류는 해당 상태에 이유를 남긴다.
- **Turn:** queued → running → completed / needs_reply / cancelled / failed. 복구할 실행은 recovering을 거쳐 다시 running으로 간다.
- **Attempt:** starting → running → stopping → terminal. 각 재실행은 새 Attempt다.
- **Delivery:** pending → claimed → posted. 응답 유실은 unknown 상태로 두고 조회 후 확정한다.

`needs_reply`는 질문을 게시하고 끝난 Turn의 결과다. 활성 실행이나 별도의 질문 대기 서비스가 아니다. 다음 댓글은 새 Input이다. 실행 완료와 결과 게시 완료도 구별한다. Provider 실행이 끝나면 Slot을 반환하되, 해당 세션의 다음 Turn은 이전 결과의 수락·게시 정합성을 확보한 뒤 시작한다.

관련 요구: F2, F3, F7, F10, N3.

## 4. GitHub REST 폴링

### 수집 경로

| 범위 | REST 조회와 처리 |
|---|---|
| 저장소의 객체·라벨 변화 | `GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=asc&since=...` |
| 일반 댓글 | `GET /repos/{owner}/{repo}/issues/comments?sort=updated&direction=asc&since=...` |
| PR 라인 댓글 | `GET /repos/{owner}/{repo}/pulls/comments?sort=updated&direction=asc&since=...` |
| PR 리뷰 본문 | 활성 PR의 `GET /repos/{owner}/{repo}/pulls/{number}/reviews`, 제출된 비어 있지 않은 본문 |
| 라벨 행위자·활성화 경계 | 객체의 events/timeline, 필요한 구간을 페이지 순회 |
| 보정 | 활성 객체 상세, 미게시 결과, 전체 허용 저장소의 저빈도 재조회 |

Issues 조회에는 PR도 포함된다. 객체 종류를 판별해 하나의 세션으로 정규화한다.[S7] 일반 댓글과 리뷰 댓글의 저장소 단위 조회는 수정 시각 필터와 페이지 조회를 제공한다.[S8][S9] GHES 버전 번호를 제품에 고정하지 않고 운영 서버가 지원하는 API 버전을 사용한다.

### 수집 알고리즘

1. 저장소·조회 종류별로 마지막 완료 커서를 읽고 겹침 구간을 뺀 시각부터 조회한다.
2. 응답의 `Link` 페이지를 끝까지 따라가며 원본 ID·revision을 SQLite에 upsert한다. 실패하면 그 조회의 커서를 진행시키지 않는다.
3. 수집 시작 시점까지의 보수적인 high-water mark를 완료 커서로 저장한다. 관측된 가장 큰 댓글 ID나 가장 큰 수정 시각 하나로 다른 종류의 커서까지 뛰어넘지 않는다.
4. 객체·라벨·권한을 정규화한 뒤 활성화 epoch 안의 새 입력만 큐에 넣는다. 별도 조회에서 같은 댓글이 들어와도 Input은 한 번만 생성한다.
5. 시작·재접속·주기적 보정에서 새 활성 객체와 이전 실패 구간을 회수한다. 활성 라벨로 필터링한 목록만 조회해 라벨 제거를 놓치지 않는다.

빈 페이지와 304도 정상 응답이다. ETag는 같은 URL·쿼리·권한의 응답에만 재사용한다. 조건부 요청·Retry-After·레이트리밋 헤더는 해당 서버 응답에 맞춰 적용한다. 조회 종류별 재시도·동시성 제한으로 한 저장소 장애가 다른 저장소를 멈추지 않게 한다.

### 입력 경계와 순서

- 최초 활성화 이전 대화는 맥락이다. 활성화 시각 뒤의 댓글은 Dispatcher가 늦게 발견했더라도 새 입력으로 회수한다.
- 설정·활성화 이벤트와 댓글을 원본 시각·안정적인 원본 ID로 정렬한다. 같은 수집 회차의 제어 입력을 다음 Turn 배정보다 먼저 처리한다.
- 여러 REST 목록 사이에 원자적 전체 스냅샷은 없으므로 이미 실행한 입력을 늦게 발견한 댓글 때문에 되감지 않는다. 늦은 입력을 보존하고 상태에 지연을 기록한다.
- 실행 전 대기 입력의 편집은 최신 본문으로 반영한다. 이미 실행한 댓글을 편집했다고 재실행하지 않는다. 실행 전 삭제가 확인되면 그 입력은 취소한다.
- 제출 전 리뷰 초안은 입력이 아니다. 리뷰 본문·각 라인 댓글은 서로 다른 원본 키로 처리하고 코드 위치·원문 링크를 함께 전달한다.
- 폴링 전에 생성·삭제된 글이나 관측 불가능한 중간 변경을 완전히 복원한다고 약속하지 않는다.

관련 요구: F1–F3, F10, N3.

## 5. 라벨, 모델 해석, 배정

### 라벨 소유권

사용자 설정의 기본 이름은 SPEC의 `ai:enabled`, `ai:model:<계열>`, `ai:effort:<수준>`이다. 실제 이름·접두어는 중앙 YAML의 `labels`에서 읽는다. Dispatcher가 관리하는 표식의 기본 접두어는 `ai:worker:`와 `ai:status:`다. 기본 상태는 `idle`, `queued`, `running`, `blocked`, `error`다. 같은 종류의 시스템 표식은 하나만 유지하고 다른 라벨을 통째로 덮어쓰지 않는다.

배정 표식은 조회 편의를 위한 GitHub 표시다. Worker는 `gh api`로 자신에게 배정된 Issue/PR을 확인할 수 있지만, Dispatcher Claim 없이 실행하지 않는다. 사용자에 의한 배정 표식 수정은 새 실행 권한을 만들지 않는다.

### 모델 카탈로그

Worker는 활성 엔진별로 다음을 보고한다.

```text
family                 sol | terra | opus | sonnet
resolvedModelId        런타임에서 실제 확인한 모델 ID
numericVersion         정수 구성 요소 배열
supportedEfforts       해당 모델에서 확인한 effort 목록
defaultEffort          런타임 기본값
engine                 내부 어댑터 식별자
runtimeVersion         로컬 프로그램 버전
availability           ready | auth_required | rate_limited | unavailable
observedAt             확인 시각
```

Codex는 `model/list`의 페이지와 기능 정보를 사용한다.[S1] Claude는 공식 계열 alias와 런타임 초기화 결과를 이용하고, 모델 ID가 명시적으로 필요하면 검증된 카탈로그를 사용한다.[S5] 존재하지 않는 모델 조회 명령이나 지원되지 않는 모델 ID를 추측해 만들지 않는다. 공개 목록에 있다는 사실과 해당 로그인에서 실행 가능하다는 사실을 구분한다.

### 실행 대상 결정

1. 유효한 설정 revision에서 계열과 effort를 읽는다.
2. 저장소에 접근 가능하고 해당 엔진이 활성화된 정상 Worker의 신선한 모델 정보를 모은다. Slot이 꽉 차거나 모델이 일시적인 인증/사용량 제한 상태인 Worker도 최신 버전 후보 판정에는 포함한다. 최신으로 확인된 모델의 일시 장애를 이유로 낮은 버전을 선택하지 않는다.
3. 같은 계열의 숫자 버전을 정수 튜플로 비교한다. 예를 들어 `6.10`은 `6.9`보다 높다. 문자열 정렬이나 소수 계산을 사용하지 않는다.
4. 가장 높은 가용 버전을 고른 후 effort·Auto Review 지원을 검증한다. 잘못된 effort를 맞추기 위해 더 낮은 버전으로 조용히 바꾸지 않는다.
5. 해당 모델을 실행할 Worker 중 여유 Slot, 이전 작업 공간 재사용, 현재 부하를 고려해 배정한다. 동률은 등록 ID 등 안정적인 순서로 해결한다.
6. 실제 시작 시 모델·effort·권한 모드를 다시 확인하고 Turn의 설정 스냅샷을 확정한다. 요청과 실제 모델이 다르면 실행 전에 조정·보고한다.

카탈로그는 등록·런타임 변경·주기적 갱신·모델 오류 시 갱신한다. Heartbeat마다 모델 시험 실행을 하지 않는다. 런타임이 자동으로 다른 계열로 fallback하려는 경우 이를 성공으로 숨기지 않는다. 이미 시작한 Turn의 복구는 기록한 설정을 우선 사용하고 변경이 필요하면 이유를 남긴다.

관련 요구: F4, F6, F12, N6.

## 6. Dispatcher–Worker 프로토콜과 Lease

### 통신 계약

Worker는 Dispatcher로 아웃바운드 HTTP 연결만 시작한다. 업무 수신은 인증된 long polling, 생존·Lease 갱신은 별도 주기 요청으로 구현하여 대기 요청이 갱신을 막지 않게 한다. PC에 수신 포트를 공개하지 않는다.

| 동작 | 주요 계약 |
|---|---|
| register | Worker ID·엔진·버전·지원 설정 schema·슬롯·GitHub 계정, 재시도 시 멱등 |
| heartbeat | 실제 가용 슬롯·active Attempt·draining·로컬 상태 보고 |
| poll / claim | 배정 및 제어 조회, 설정 revision 일치 확인, SQLite 트랜잭션으로 실행 권한 발급 |
| config get / ack | 인증된 공통 설정 projection 조회, revision/ETag·schema 확인, Worker 적용 revision 보고 |
| renew | Attempt ID·generation으로 Lease 갱신, 만료 세대 거절 |
| control ack | 수신과 실제 적용을 구별, 동일 control ID 중복 적용 금지 |
| complete | 영속화된 결과·결과 해시·작업 링크 제출, 재전송 멱등 |
| delivery claim / receipt | 댓글 게시 권한과 게시 확인을 별도 관리 |
| reconcile | 재접속한 로컬 Attempt·결과·댓글과 중앙 상태 대조 |

Control은 원본 댓글의 작성 시각과 저장된 Attempt 실행 구간으로 대상을 정하고 이후 바꾸지 않는다. 시각 경계가 불확실하거나 대상이 끝났으면 다음 실행에 붙이지 않고 적용하지 않았음을 알린다.

계약에는 프로토콜 버전과 요청 ID를 둔다. 지원 버전 범위가 맞지 않으면 Worker는 종료하지 않고 새 작업을 받지 않는 상태로 업데이트·재시도를 수행한다. HTTP 클라이언트 타임아웃·연결 취소를 갖추며 무한 대기 요청이 실행 관리 루프를 막지 않게 한다.

### 짧은 단절과 만료

- Worker는 갱신 요청을 보낸 로컬 시점과 Dispatcher가 발급한 Lease 기간으로 보수적인 실행 마감 시각을 계산한다. 응답 수신 시점부터 기간을 새로 더해 네트워크 지연만큼 권한을 연장하지 않는다.
- 단기 실패에는 현재 Lease 안에서 실행을 유지하고 백오프·지터로 재연결한다. 새 실행 Claim과 새 게시 시작은 연결 확인 뒤 수행한다.
- Lease 마감 전에 종료에 필요한 여유를 두고 중단을 시작한다. Provider interrupt → 종료 확인 → 필요한 프로세스 트리 정리 순으로 처리한다.
- Dispatcher는 이전 Lease 만료와 종료 유예가 지난 뒤 새 generation을 발급한다. 확실한 종료 확인이 도착하면 더 빨리 회수할 수 있다.
- Worker가 다시 연결되면 소유권부터 확인한다. 만료된 Attempt를 자동으로 활성 실행으로 되돌리지 않는다.

### 프로세스와 절전

세션별 Provider 프로세스를 관리해 필요한 세션만 종료한다. POSIX 프로세스 그룹과 Windows 프로세스 트리 종료는 좁은 어댑터로 구현한다. 종료 신호 전송을 실제 종료 완료로 취급하지 않는다.[S12] 부모 프로세스 충돌 후 남은 자식 실행도 Launcher/재시작 진단에서 확인한다.

시간 역행·큰 시계 변화·긴 이벤트 루프 공백·절전 복귀를 감지하면 Lease를 다시 확인할 때까지 새 실행과 게시를 보류한다. 단조 시계만으로 모든 OS의 절전 경과를 정확히 처리한다고 가정하지 않는다.

**보증 범위:** generation은 플랫폼 보고·Claim·게시 권한을 차단한다. 이미 시작한 Git Push나 네트워크 부작용을 GitHub까지 포함한 원자적 트랜잭션으로 취소하지는 못한다. 네트워크 분할·프로세스 정지 상황의 중첩 가능성을 줄이고, 재개 전에 원격 상태와 부분 결과를 확인한다. 이는 Git 명령 순서를 런타임이 강제하는 방식이 아니다.

관련 요구: F3–F5, F7, N3.

## 7. Provider 실행과 제어

### 공통 어댑터

공통 계약은 `probe`, `openOrResume`, `run`, `interrupt`, `steer`, `events`, `close` 정도로 유지한다. 런타임별 설정과 이벤트를 억지로 완전히 동일하게 만들지 않는다. 일반 입력은 Dispatcher가 하나씩 전달하며 여러 미래 Turn을 런타임 내부 큐에 미리 밀어 넣지 않는다.

Worker는 사용자 HOME·로그인 저장소·기존 도구 설정을 유지한 상태에서 세션별 cwd와 실행 지침만 전달한다. 전역 설정 파일을 작업마다 변경하지 않는다. 구독 인증을 덮어쓰는 환경 설정이 발견되면 setup/doctor에서 알리고 해당 엔진을 구독 경로로 설정한다.

### Codex

- 로그인된 공식 실행 파일의 `app-server`를 stdio JSON-RPC로 실행한다.
- `thread/start`·`thread/resume`, `turn/start`, `turn/interrupt`, `turn/steer`를 사용한다. steer는 `expectedTurnId`를 고정한다. 완료는 응답 수신이 아니라 terminal 이벤트로 확인한다.[S1]
- Auto Review는 `approvals_reviewer = "auto_review"`와 호환되는 승인 정책을 세션 설정에 적용한다. 관리 정책과 Sandbox 경계는 유지한다.[S2]
- 사용 모델과 기능 목록은 실제 런타임 schema/카탈로그를 기준으로 한다. 세션별 App Server 인스턴스로 중단 범위를 격리한다.

### Claude

공식 Claude Code를 구조화된 프로그램 모드로 실행한다. 아래는 어댑터가 구성할 인수의 형태다. 사용자 입력은 인수 문자열에 결합하지 않고 JSON/stdin으로 전달한다.

```text
claude -p
  --input-format stream-json
  --output-format stream-json
  --verbose
  --model <해석된 모델>
  --effort <적용 effort>
  --permission-mode auto
  --permission-prompts none
  --append-system-prompt-file <고정된 Turn 지침의 로컬 전달 파일>
  --system-prompt-snapshot off
  [--resume <정확한 로컬 세션 ID>]
```

구독 로그인과 기존 프로젝트 지침을 읽는 정상 실행 모드를 사용한다. `--bare`는 구독 로그인과 지침 탐색을 사용하지 않는 모드이므로 선택하지 않는다.[S4] `--permission-prompts none`은 자동 검토 후에도 사람이 답해야 하는 요청에 무인 동작을 지정하는 옵션이다. Auto 모드 자체를 무조건 승인으로 바꾸는 옵션이 아니다.[S3][S4][S6]

Claude는 재개한 대화에서 기록된 시스템 프롬프트를 재사용할 수 있다. `--system-prompt-snapshot off`를 지원하는 버전에서는 이 옵션과 Turn별 고정 지침을 함께 사용하여 다음 Turn의 중앙 지침이 실제로 적용되게 한다.[S3] Worker는 한 Turn 안에서 전달 파일을 바꾸지 않는다. 옵션을 지원하지 않는 버전의 대체 경로는 아래 공통 지침 적용 계약을 따른다.

상위 Worker는 스트림의 session ID·terminal result·오류를 보존한다. `--continue`처럼 작업 디렉터리에서 임의의 최근 세션을 고르는 동작 대신 정확한 ID로 재개한다. 해당 버전의 구조화된 interrupt 경로를 사용하고 종료가 확인되지 않으면 프로세스 종료로 회수한다. 직접 steer가 검증되지 않은 버전은 **interrupt 후 같은 세션에 추가 지시를 넣어 재개**하는 기본 대체 경로를 사용한다. 논리 Turn은 유지하고 새 실행 Attempt를 연결한다.

### 사람에게 묻는 질문

- 기본 공통 지침은 질문을 최종 답변으로 남겨 현재 실행을 마치도록 한다.
- Codex 사용자 입력 요청은 request ID와 Attempt에 연결한다. 공식 프로토콜은 Turn 시작·종료·중단으로 보류 요청이 정리될 수 있음을 명시한다.[S1] 질문 발생만으로 반드시 실행이 멈췄다고 판단하지 않는다.
- 계속 진행 가능한 요청은 런타임 수명주기를 따른다. 실제로 응답을 기다리며 막힌 요청은 질문을 출력으로 보존하고 취소·중단 경로로 마무리한다. 무응답을 임의의 사용자 선택으로 바꾸지 않는다.
- Claude의 무인 모드는 사람 입력 도구가 장기 대기를 만들지 않도록 구성하고 최종 자연어 질문을 사용한다.[S4]
- 다음 일반 댓글은 새 Input으로 처리한다. 완료된 질문 Turn은 슬롯을 반환하고 대화 맥락만 유지한다.
- 도구 실행 승인과 업무상 질문은 요청 유형·내용으로 구별한다. 승인 요청을 사용자의 업무상 의사결정 질문으로 잘못 변환하지 않는다.

관련 요구: F3, F6, F8, N6.

## 8. 작업 공간과 공통 지침

### 파일·Git 격리

Worker 관리 디렉터리 아래에 저장소 캐시와 세션별 작업 공간을 둔다. Issue의 최초 기준은 저장소 기본 브랜치, PR은 실제 head와 base 정보를 사용한다. 이후에는 로컬 작업 상태와 사용자 지시를 우선하며 매 Turn마다 강제 reset·checkout하지 않는다.

Worktree는 로컬 참조를 공유하고 동일 브랜치의 중복 checkout에 제약이 있으므로,[S14] 동일 브랜치를 두 세션이 다루어야 할 때는 독립 clone으로 격리한다. 관리용 캐시 fetch·worktree 등록 같은 공유 메타데이터 작업만 짧게 직렬화한다. 원격 브랜치 충돌은 로컬 격리로 해결되었다고 가정하지 않고 AI에 최신 상태를 제공한다.

Provider 세션 ID는 host·repo·Session·engine·workspace와 함께 매핑한다. 다른 cwd/다른 엔진에 무조건 재사용하지 않는다. Worker가 변경되면 GitHub 대화·원격 Git·수락된 부분 결과로 새 세션을 만든다. 원래 PC의 dirty workspace는 보존하고 자동 전송·강제 삭제하지 않는다.

### 실행 시 제공할 공통 맥락

공통 지침의 원본은 중앙 YAML의 `agent.instructions`다. 초기 내용은 [config.example.yaml](../config.example.yaml)에 둔다. Worker는 설정 API로 받은 해당 revision의 지침을 사용하며 패키지 안의 오래된 문구로 대체하지 않는다.

현재 GitHub 호스트·저장소·Issue/PR URL·요청자·원본 입력·연관 객체·모델·작업 공간·이전 결과는 별도 구조화 맥락으로 제공한다. 설정된 출처 문구와 직접 GitHub 작성 시의 표기 규칙도 함께 전달한다. 사용자 댓글을 공통 지침에 문자열 템플릿으로 끼워 넣어 신뢰 수준을 섞지 않는다.

지침 적용 절차는 다음과 같다.

1. Claim이 지정한 `runConfigRevision`의 검증된 스냅샷을 확보한 뒤 실행한다. Turn의 재시도·steer 재개도 같은 지침을 사용한다.
2. Codex는 `developer_instructions`에 해당하는 세션별 추가 지침 설정을 이용한다. 설치된 App Server가 생성하는 schema의 시작·재개 설정 경로를 사용하고 사용자 전역 config를 쓰지 않는다.[S1][S20]
3. Claude는 기본 지침을 보존하는 append 인터페이스로 적용한다. 긴 문자열은 Worker 전용 전달 파일로 만들어 CLI 길이·인용 문제를 피한다. 이 파일은 중앙 YAML에서 생성한 캐시이며 운영자가 따로 관리할 프롬프트 원본이 아니다.[S3]
4. 재개 세션에서도 다음 Turn에 새 지침이 적용되는지 확인한다. 지침 교체를 지원하지 않는 런타임에서는 다음 Turn 경계에서 대화·결과·같은 작업 공간을 보존해 새 내부 세션으로 이어간다. 논리 Issue/PR 세션은 유지하고 전환 이유를 기록한다. 오래된 지침을 사용하면서 최신 revision을 적용했다고 보고하지 않는다.

변경 없는 지침을 대화 메시지에 계속 누적하지 않는다. 대상 저장소 AGENTS.md/CLAUDE.md와 사용자의 기본 런타임 지침은 유지한다. 중앙 지침 변경을 위해 Worker나 Dispatcher 프로그램을 다시 배포할 필요는 없다.

관련 요구: F2, F5, F7, F9, F12, N4, N6.

## 9. 동료 명의 게시, 중복 방지, 결과 복구

### 완료와 게시를 분리한다

1. Worker는 terminal 결과·출력 종류·모델·작업 링크·Attempt·적용 설정 revision과 최종 게시 본문을 로컬 저널에 먼저 기록한다.
2. Dispatcher에 완료를 보고한다. Dispatcher는 generation을 검증하고 Turn 결과와 Delivery를 한 트랜잭션에서 저장한다.
3. Worker가 Delivery 게시 권한을 Claim한다. 이 권한은 완료된 실행 Lease와 구별한다.
4. Worker가 자기 `gh`로 고정된 본문을 게시하고 반환된 댓글 ID·URL을 로컬에 기록한 뒤 Dispatcher에 알린다. AI 본문에는 설정된 AI 작성 표기가, 런타임 알림에는 자동화 표기가 포함된다.
5. 응답이 불확실하면 같은 Delivery 표식의 기존 댓글을 조회한 후에만 재시도한다.

Dispatcher가 불통이면 로컬 결과를 유지하고 완료 보고를 재시도한다. 이미 수락된 결과는 원래 Worker가 사라져도 다른 적합한 Worker가 **게시만** 수행할 수 있다. 이 경우 게시 계정은 새 Worker의 동료 계정이며, 실행한 Worker와 결과 전달한 Worker를 명확히 표시한다. AI 작업을 다시 실행하지 않는다.

수락되지 않은 오래된 Attempt 결과는 자동 최종 게시하지 않는다. 새 실행의 복구 참고자료로 보관하고 충돌을 알린다. 로컬 저널은 ACK 전에 지우지 않는다. 동일 Input의 새 Attempt를 만들 때 원격 Git·댓글·이미 수락된 결과부터 확인한다.

### 보이는 출처 표기와 게시 본문 고정

- `ai` 출력에는 `output.attribution`, 순수 런타임 알림에는 `output.automationAttribution`을 쓴다. AI 답변·질문·AI가 작성한 리뷰 본문은 전자다. 단순 재접속·대기·오류 안내를 AI가 작성했다고 오표시하지 않는다.
- Worker 게시기는 **본문 원문 + 빈 줄 + 출처 블록 + 내부 식별자**로 최종 본문을 구성한다. 표시 문구는 중앙 설정값이며 AI의 지시 준수에 맡기지 않는다. 문구·Markdown 형식은 바꿀 수 있지만 AI 작성 표시가 비어 있거나 숨김 주석뿐인 설정은 유효한 표기로 인정하지 않는다.
- 원문과 장식된 본문을 따로 저장한다. 새 본문을 렌더링할 때 기존의 플랫폼 관리 출처 블록만 교체하고 사용자의 인용·본문은 지우지 않는다. 끝에 열린 코드블록 등으로 표기가 코드나 주석 안에 묻히지 않도록 Markdown 경계를 정리한다.
- Turn의 출력은 그 Turn의 설정 스냅샷으로 렌더링한다. Turn 밖 런타임 알림은 Delivery 생성 시의 검증된 설정을 쓴다. Delivery가 생성되면 표기·본문·해시를 고정하고, 재전송할 때 최신 문구로 다시 렌더링하지 않는다.
- 진행 댓글 편집은 동일 댓글에 대한 새 게시 revision으로 관리하고 출처를 한 번만 붙인다. 길이 제한으로 나눈 출력은 각 부분에 표기를 포함하며, 표기·숨김 식별자 길이를 먼저 확보한다. 이미 게시된 과거 글을 설정 변경만으로 일괄 수정하지 않는다.

플랫폼 게시 경로의 댓글·리뷰는 위 처리를 보장한다. AI가 `gh` 등으로 직접 쓰는 PR 본문·다른 객체의 글에는 중앙 지침으로 같은 표기를 전달한다. 반환된 객체 ID로 실제 AI 작성 부분이 확인되면 누락을 점검하고 그 부분만 보완한다. 사람이 추가한 내용을 통째로 덮어쓰지 않는다. 관측되지 않은 직접 쓰기까지 완벽한 강제를 주장하거나 모든 GitHub 명령을 대리 실행하는 새 계층을 만들지 않는다. Git 작성자·서명과 코드 파일에는 이 게시물 footer 규칙을 적용하지 않는다.

### 자동 댓글과 사람 댓글 구별

모든 플랫폼 게시물에는 예측 불가능한 Delivery ID를 담은 숨김 표식을 넣는다.

```html
<!-- forgecrew:delivery=<opaque-id> -->
```

Dispatcher가 알고 있는 Delivery·게시 revision·작성 계정·최종 본문 해시·원본 댓글 ID를 대조해 자동 작성임을 확인한다. 화면에 보이는 출처 문구를 식별 키로 사용하지 않는다. 이미 등록된 자동 댓글 ID는 이후 본문 편집으로 해시가 달라져도 자동 생성 이력을 유지한다. 단순 작성자 ID, `Bot` 여부, 본문에 들어 있는 표식 문자열만으로 전체 계정의 댓글을 제외하지 않는다. 게시 응답보다 폴링이 먼저 도착하는 경우에도 이미 발급한 Delivery 정보로 식별한다. 검증되지 않은 표식은 실행 제어로 신뢰하지 않는다.

원본 세션의 진행·질문·최종 응답은 Worker 게시기를 한 통로로 사용한다. AI가 다른 객체에 필요한 글을 직접 게시하는 경우에는 공통 지침에 따라 자동화 표식을 사용하고 반환된 ID를 기록한다. 확인된 자동 생성 입력을 재실행하지 않으며, 추적할 수 없는 직접 게시를 완벽히 감지한다고 주장하지 않는다.

진행은 한 상태 댓글을 갱신하고 최종 결과는 별도 댓글로 남긴다. 긴 결과는 GitHub 길이 제한에 맞춰 분할하고 각 부분에 안정적인 ID를 부여한다. PR 라인 요청은 원래 스레드에 답하는 것을 우선하되, 위치가 사라졌으면 일반 PR 댓글에 원문 링크와 함께 게시한다.

관련 요구: F7, F9, F10, F12, N3, N4.

## 10. 설치와 자동 업데이트

### 사용자별 설치 구조

```text
<Worker data directory>/
  launcher.js                 안정적인 부트스트랩
  current.json                active / lastKnownGood / pending / formatVersion
  config.json                 Worker ID, 연결·엔진 설정, 비밀값 참조
  versions/<version>/         ForgeCrew 패키지: 실행·감시·업데이트 기능 포함
  staging/<install-id>/       준비 중인 설치
  cache/config/<schema>/      검증된 revision별 공통 설정 캐시
  journal/                    Attempt·미전달 결과·게시 확인
  workspaces/                 세션별 작업 공간
  logs/                       회전 로그
```

Windows는 사용자 로컬 데이터 디렉터리, Linux는 사용자 데이터 디렉터리를 사용한다. 설정으로 위치를 바꿀 수 있다. 버전 제거와 작업 공간 제거를 분리한다.

초기 사내 npm 설치가 CLI를 제공하고 setup이 Launcher·설정·버전 디렉터리를 준비한다. 실제 사내 scope·패키지명은 배포 설정으로 정한다. 목표 CLI는 `forgecrew setup`, `start`, `stop`, `status`, `doctor`다. `stop`은 의도적 종료를 기록해 Launcher가 즉시 다시 켜지 않도록 한다. 자동 시작 등록은 Windows 사용자 로그온 작업, Linux 사용자 서비스 어댑터로 처리한다. 해당 서비스 관리자가 없으면 같은 Launcher를 기존 사용자 프로세스 관리 방식에 연결할 수 있다.

setup은 Node/npm·Git·사내 호스트의 `gh` 로그인·선택 엔진·구독 인증·실행 모드·레지스트리 접근을 점검한다. 하나의 엔진만 선택했다면 다른 엔진 설치를 요구하지 않는다. 백그라운드 시작에서도 실행 파일 경로와 사용자 계정이 동일한지 검사한다.

### 두 계층의 책임

- **Launcher:** 동일 Worker 중복 기동 방지, 버전 선택, 자식 기동·종료 관찰, 로컬 READY 확인, 전환·롤백·재시작 백오프. AI·GitHub·npm 업무 로직을 넣지 않는다.
- **버전별 ForgeCrew:** 정상 Worker 기능과 업데이트 확인·다운로드·검증·Drain·전환 요청. 다음 버전에는 이 코드 전체의 수정본이 포함된다.

Launcher와 Worker는 작은 버전 명시 IPC 계약으로 통신한다. 메시지에는 `READY`, `STAGE_READY`, `SWITCH`, `EXIT_INTENT`, `HEALTH` 등이 있다. 배포 패키지는 지원 Launcher 계약 버전을 선언한다. 일반 릴리스는 안정된 계약을 유지하며 전역 npm 패키지나 실행 중 자기 디렉터리를 덮어쓰지 않는다. 부트스트랩 자체의 손상 복구는 setup의 repair 경로를 제공한다.

### 적용 순서

1. 중앙 설정에서 받은 사내 npm registry·package·dist-tag로 최신 배포 버전을 확인하고 **정확한 버전**으로 고정한다. npm 인증은 사용자 로컬 설정을 사용하며 자격 증명을 다른 registry host로 전송하지 않는다.
2. 별도 staging prefix에 npm install로 production 패키지를 설치한다.[S13] 레지스트리·scope를 설정된 값으로 제한하고 무결성·Node/프로토콜 호환성을 검사한다. Worker 배포물은 설치 스크립트 없이 설치 가능하게 빌드한다.
3. 현재 버전이 계속 일하는 동안 다운로드·설치를 완료한다. 미완성 디렉터리는 실행 후보가 아니다.
4. 준비 완료 후 Worker를 draining으로 표시한다. 신규 Turn을 받지 않지만 Heartbeat·제어·현재 Lease·결과 게시 처리는 유지한다.
5. 현재 Turn의 종료를 기다린다. 설정된 drain 한도를 넘으면 진행 내용을 기록하고 interrupt·종료를 확인한 뒤 재개 대상으로 보존한다. 새 버전은 같은 PC의 작업 공간을 그대로 사용한다.
6. 전환 journal을 기록하고 기존 프로세스와 세션 자식을 종료한다. Launcher가 새 버전을 실행한다.
7. 새 버전은 설정·로컬 상태·IPC 초기화가 정상일 때 READY를 보낸다. Dispatcher 연결 성공은 READY의 조건이 아니다.
8. READY 뒤에도 설정된 로컬 안정화 관찰 구간 동안 이전 lastKnownGood를 유지한다. 후보가 계속 정상임을 확인한 뒤 승격하고 Dispatcher 재조정 후 작업을 받는다. 관찰 중 충돌·health 실패가 나면 이전 정상 버전을 실행한다.

포인터·저널 파일 교체는 동일 파일 시스템의 원자적 교체와 복구 가능한 이전 값을 사용한다. 교체 중 강제 종료 후에도 active·pending·lastKnownGood 중 하나의 검증된 버전을 선택할 수 있어야 한다. 새 버전이 이전 버전의 상태 파일을 되돌릴 수 없게 바꾸기 전에 백업·마이그레이션 호환성을 확보한다.

### 실패 분류

| 실패 | 처리 |
|---|---|
| npm/네트워크/인증 장애, 설치 실패 | 현 버전 유지, 진단·백오프 재시도. 새 버전이 완성되기 전 Drain하지 않는다. |
| Dispatcher 일시 불통 | Worker 재연결. 로컬 기동이 정상이면 버전 실패로 분류하지 않는다. |
| 새 프로세스 기동·로컬 상태 초기화 실패 또는 READY 후 안정화 중 충돌 | 이전 버전 복귀, 실패 버전 cooldown. 같은 버전의 무한 전환 루프 방지. |
| 전환 중 프로세스·PC 종료 | 전환 journal과 lastKnownGood로 복구. 미완료 설치 경로는 실행하지 않는다. |
| Node/Launcher/프로토콜 호환 불가 | 현재 정상 버전 유지, 필요한 조치를 진단한다. 강제 설치로 정상 Worker를 깨뜨리지 않는다. |
| 사용자 로그아웃·PC 종료 | 해당 사용자 실행이 종료된 것으로 처리하고 다른 Worker 재배정을 허용한다. 다음 로그인에 자동 시작한다. |

관련 요구: F7, F11, F12, N2, N3, N5.

## 11. 중앙 YAML, 설정 배포, Docker 운영

### 단일 설정 원본과 책임 경계

운영자가 관리하는 공통 설정 원본은 Dispatcher의 `config.yaml` 하나다. 지침은 YAML의 `|` 멀티라인 문자열로 작성한다.[S18] [config.example.yaml](../config.example.yaml)은 기본 키·값·지침을 담은 설계 예제이며, 구현 시 같은 스키마로 검증한다. 예제의 시간·용량 값은 조정 가능한 초기 기본값이지 제품의 고정 제한이 아니다.

| 위치 | 관리 항목 |
|---|---|
| 중앙 YAML | GitHub host/base URL·저장소, 라벨 이름, 모델/effort 기본값, 폴링·권한 캐시·Heartbeat·Lease·재시도, 공통 지침, 출처 문구, 사내 npm 배포 정보·업데이트 정책 |
| 서버 환경변수/Secret | PAT·등록 비밀값. YAML에는 `tokenEnv` 같은 참조 이름만 둔다. |
| Worker 로컬 설정 | Dispatcher 주소·Worker ID·플랫폼 토큰, 활성 엔진, `maxConcurrentSessions`, 데이터·실행 파일 경로 |
| 동료의 기존 환경 | `gh`·Git·Codex/Claude 구독 로그인, npm 인증, 프록시·사내 CA |

일반 설정은 YAML에 둔다. 환경변수는 설정 파일 경로 등 기동 입력과 명시적 비밀값 참조에 사용하여 같은 값을 여러 곳에 중복 관리하지 않는다. YAML 전체에 `${...}` 치환이나 셸 평가를 적용하지 않는다. 프롬프트에 들어 있는 `$PATH`·명령 예제는 그대로 문자열이다.

중앙 지침과 배포 정책은 Worker 환경에서 실행을 유도할 수 있는 관리 데이터다. Worker 인증이 있다는 이유만으로 중앙 설정 쓰기 권한을 주지 않는다. 설정 파일 수정 권한은 운영자에게 있다.

### 검증·재로드·revision

1. 설정 경로를 주기적으로 다시 읽어 내용 변화를 확인한다. 파일 watcher는 빠른 감지를 돕는 수단이며 유일한 감지 경로가 아니다. 파일 교체·symlink 변경·마운트 파일의 inode 변화도 확인한다. Node `fs.watch`는 이런 환경에서 모든 변경을 보장하지 않는다.[S19]
2. YAML을 안전한 데이터 스키마로 파싱한다. 중복 키·알 수 없는 필드·타입 오류·유효하지 않은 기간·비어 있는 필수값·과도한 alias 확장 등을 거절한다. 임의 객체 생성 태그나 실행 가능한 설정을 허용하지 않는다.
3. 비밀값 참조를 정해진 서버 필드에서만 해석한다. 라벨 prefix 충돌, 필수 AI 출처 문구, 폴링/통신/Lease의 시간 관계, 업데이트 출처·기본 모델 설정을 함께 검증한다.
4. 전체 후보가 유효할 때 정규화된 비밀 없는 설정으로 내용 해시 `configRevision`을 만들고 SQLite 트랜잭션으로 스냅샷·활성 참조를 교체한다. 주석·매핑 키 순서만 바뀐 경우 새 의미 revision을 만들지 않는다. 단, 지침·표기 같은 문자열의 의미 있는 줄바꿈과 공백은 보존한다. 잘못된 후보를 항목별로 조금씩 반영하지 않는다.
5. 기존 정상 프로세스의 재로드 실패는 현재 설정을 유지하며 로그·운영 상태에 필드 경로와 오류를 남긴다. 오류 로그에 비밀값이나 전체 프롬프트는 포함하지 않는다. 최초 기동에서는 유효한 설정이 준비되기 전 작업을 받지 않는다.

원래 YAML 값을 되돌려도 정상적인 설정 배포로 처리한다. 활성 Turn·Delivery가 참조하는 이전 스냅샷은 삭제하지 않는다. 비밀값 원문은 스냅샷·revision 입력·Worker 캐시에 포함하지 않는다. 실제 Secret 값 교체는 서버 인증 갱신 또는 재시작으로 처리하며 Worker 배포와 분리한다.

### Worker 설정 API와 캐시

- 등록·Heartbeat·long-poll 응답은 Worker가 사용할 공통 설정 revision과 지원 schema를 알려준다. Worker는 인증된 설정 조회 API에서 필요한 revision을 받고 `If-None-Match`로 변경 없는 요청을 줄인다.
- 응답은 명시적으로 허용한 공통 지침·표기·운영/업데이트 설정과 Worker에 필요한 저장소 맥락으로 구성한다. 서버 YAML 전체를 직렬화한 뒤 비밀값만 지우는 방식으로 만들지 않는다. PAT·등록 비밀값·서버 데이터 경로·다른 Worker 자격 증명은 제외한다.
- 각 설정 응답은 원본 `configRevision`과 별도로, 전달한 projection의 `schemaVersion`·내용을 덮는 `payloadHash`를 가진다. Worker는 자신에게 전달되지 않은 서버 전체 설정의 해시를 재계산하지 않는다. revision은 인증을 대체하지 않는다.
- Worker는 schema·`payloadHash`·필수 필드를 검증하고 임시 파일 기록 후 캐시를 교체한다. 마지막 검증 성공 스냅샷과 실행 중 참조된 revision을 유지한다. 적용 상태를 Dispatcher에 보고한다.
- Claim은 정확한 `runConfigRevision`과 실행 설정 스냅샷 또는 그 조회 참조를 포함한다. 실행 스냅샷의 revision은 그 비밀 없는 유효 설정 내용의 해시다. Worker가 이를 확보·검증하기 전에는 Provider를 시작하지 않는다. 내려받기 도중 중앙 revision이 바뀌어도 Claim에 지정된 스냅샷을 사용한다.
- 연결이 끊기면 이미 받은 설정과 유효 Lease로 기존 실행을 유지한다. 로컬 기동·업데이트 준비에는 마지막 정상 캐시를 쓸 수 있지만, 오프라인 캐시로 새 Claim을 만들어 실행하지 않는다. 최초 동기화 전 또는 캐시가 손상됐으면 프로세스는 살아서 재요청한다.
- Worker가 해석하지 못하는 schema면 현재 유효 실행과 업데이트·Heartbeat를 유지하고 새 설정 작업을 보류한다. 현재 릴리스와 직전 정상 버전의 캐시를 혼합 덮어쓰지 않는다. 코드 롤백 뒤에는 호환 캐시를 선택하고 새 Claim 전 서버와 재조정한다.

`configRevision`은 중앙 공통 설정, `sessionConfigRevision`은 승인된 라벨·세션 설정, `runConfigRevision`은 해당 Turn에 고정된 실행 설정을 구분한다. 실행 스냅샷에는 두 원본 revision과 실제 모델 ID·effort를 기록한다. 패키지 버전은 이들과 별개다.

### 적용 시점

| 설정 | 적용 시점·동작 |
|---|---|
| 지침·출처 문구·모델 기본값 | 다음 새 Turn에서 고정. 기존 Turn의 steer·재시도와 확정된 Delivery는 기존 스냅샷 사용 |
| 폴링·재동기화·설정 확인·업데이트 확인 주기 | 검증된 새 설정을 다음 루프부터 사용. 진행 중 HTTP 요청·설치는 기존 계약으로 마무리 |
| Heartbeat·Lease·중단/재배정 유예 | 실행 권한 발급 시 함께 고정하고 응답에 명시. 기존 Attempt의 마감을 사후 단축하지 않으며 각 Worker가 보유한 활성 계약을 모두 지킴 |
| 저장소 허용 목록 | 다음 배정 전에 검사. 제거 시 새 입력·Claim을 막고 진행 중 Turn은 기존 계약으로 정리하며 상태·결과를 보존 |
| 라벨 이름·접두어 | 다음 전체 보정 전에 의미 매핑을 전환. 기존 activation epoch·Input ID·큐·진행 Attempt를 유지하고 최초 본문을 다시 실행하지 않음. 시스템이 소유한 표식만 갱신 |
| 업데이트 registry·package·channel·정책 | 다음 업데이트 시도에 적용. 이미 준비 중인 설치는 시작할 때 고정한 출처·정확한 버전으로 완료 |
| 서버 listen·port·데이터 경로·GitHub host/base URL·비밀값 참조 | Dispatcher 재시작 적용. 이 항목이 바뀐 후보는 전체 재로드를 보류하고 재시작 필요를 표시. 부분 적용으로 활성 설정을 섞지 않음 |

라벨 이름을 바꿨다고 사람의 라벨을 일괄 수정하지 않는다. 새 이름을 적용할 대상은 운영자가 조정하며, 이때 대상의 활성 여부는 새 설정으로 판단하되 기존 입력 처리 기록은 유지한다. 변경된 라벨 때문에 이미 수집된 제어 명령이 다른 Attempt에 적용되지 않는다.

단일 운영 지침 변경을 위해 Worker를 재시작하지 않는다. 긴 지침을 전달하기 위한 캐시 파일이나 revision 레코드는 구현 산출물이며 별도 운영 설정 원본이 아니다. 새로운 설정 키가 새 런타임 기능을 필요로 할 때만 코드 배포가 필요하다.

### Docker와 SQLite

Dispatcher는 단일 Linux Docker 이미지로 제공한다. 실행 명령·HTTP 포트·설정 위치·데이터 볼륨·health endpoint·종료 신호 계약을 문서화한다. 설정 파일과 데이터 경로는 운영 환경이 마운트하며 이미지는 특정 오케스트레이터 API를 호출하지 않는다. 실제 파일 내용이 컨테이너에 전달되지 않는 마운트 방식은 운영자가 수정해야 한다.

SQLite는 Dispatcher만 직접 접근하고 트랜잭션·busy timeout·migration을 관리한다. 단일 활성 Dispatcher와 파일 잠금이 정상인 영속 저장소를 운영 전제로 한다. Worker가 같은 SQLite 파일을 네트워크로 열지 않는다. 스키마 변경 전 SQLite 백업 API 등 일관된 백업과 복원 시험을 사용한다.[S15]

`/health/live`는 프로세스 생존, `/health/ready`는 유효 설정·DB 초기화 완료를 나타낸다. 정상 설정으로 운영 중인 재로드 실패와 GitHub 일시 장애를 프로세스 사망으로 표현하지 않는다. 종료 시 새 Claim을 멈추고 중앙 상태를 저장한다. Worker는 발급된 Lease와 재연결 계약을 따른다.

설정 가능한 기간의 검증 기준은 **Heartbeat가 Lease보다 충분히 짧을 것, Worker 중단 마감이 재배정 허용보다 빠를 것, 업데이트 drain 중에도 Lease를 갱신할 것**이다. PC별 용량은 Worker 로컬 설정이 기준이다. 중앙 지침이 로컬 엔진을 활성화하거나 동시 실행 수를 초과시키지 않는다.

로그에는 Session/Input/Attempt/Worker/Delivery ID, 모델·effort, 적용 설정 revision, 종료 이유, 버전을 연결한다. 캐시·구버전·staging 정리 시 활성 실행·미전달 결과가 참조하는 설정과 dirty workspace를 보존한다. 프롬프트 전문은 필요할 때만 접근 통제된 스냅샷에서 확인한다.

관련 요구: F1, F6, F7, F9–F12, N1, N3–N6.

## 12. 공식 연동 참고자료

확인 기준일: 2026-11-02. 아래 자료는 외부 기능의 근거다. 설치 버전에서의 동작 시험과 그 근거는 PLAN에 기록한다. 예제 모델·제품 버전을 회사 환경의 실제 값으로 가정하지 않는다.

- [S1] [Codex App Server](https://developers.openai.com/codex/app-server): thread/turn, 모델 목록, steer/interrupt, 사용자 입력 요청 수명.
- [S2] [Codex Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review): 자동 검토 설정과 관리 정책 경계.
- [S3] [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): 구조화된 입출력·세션 재개·모델·effort·권한 인수.
- [S4] [Run Claude Code programmatically](https://code.claude.com/docs/en/headless): 구독 환경을 유지하는 실행, 무인 프롬프트 처리.
- [S5] [Claude model configuration](https://code.claude.com/docs/en/model-config): 계열 alias와 실제 모델 해석.
- [S6] [Claude permissions](https://code.claude.com/docs/en/permissions): 자동 검토와 다른 권한 모드의 차이.
- [S7] [GHES Issues REST](https://docs.github.com/en/enterprise-server@3.20/rest/issues/issues): Issue/PR 공통 조회.
- [S8] [GHES Issue comments REST](https://docs.github.com/en/enterprise-server@3.19/rest/issues/comments): 일반 댓글 증분 조회.
- [S9] [GHES PR review comments REST](https://docs.github.com/en/enterprise-server@3.19/rest/pulls/comments): 리뷰 댓글 증분 조회.
- [S10] [GitHub collaborator permissions](https://docs.github.com/en/enterprise-cloud@latest/rest/collaborators/collaborators): 실제 권한의 정규화. 사내 GHES의 동일 경로로 시험한다.
- [S11] [gh auth login](https://cli.github.com/manual/gh_auth_login), [gh auth setup-git](https://cli.github.com/manual/gh_auth_setup-git): 호스트별 로그인과 Git 인증 설정.
- [S12] [Node.js child_process](https://nodejs.org/api/child_process.html): OS별 실행·종료와 자식 프로세스 처리.
- [S13] [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/): 정확한 패키지 버전과 별도 prefix 설치.
- [S14] [Git worktree](https://git-scm.com/docs/git-worktree): 공유 refs와 브랜치 점유.
- [S15] [SQLite Online Backup](https://www.sqlite.org/backup.html): 일관된 DB 백업.
- [S16] [Drizzle SQLite](https://orm.drizzle.team/docs/get-started-sqlite): SQLite 드라이버 구성.
- [S17] [Hono Node.js](https://hono.dev/docs/getting-started/nodejs): Node HTTP 서비스 구성.

- [S18] [YAML 1.2.2](https://yaml.org/spec/1.2.2/): 멀티라인 literal scalar와 데이터 표현.
- [S19] [Node.js fs.watch](https://nodejs.org/api/fs.html#fswatchfilename-options-listener): watcher의 파일 시스템·inode 제약.
- [S20] [Codex Configuration Reference](https://developers.openai.com/codex/config-reference/): 추가 개발자 지침 설정. App Server 전달 필드는 도입 버전 schema에 맞춘다.
