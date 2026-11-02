# ForgeCrew

**GitHub에서 대화하고, 동료 PC의 AI가 작업합니다.**

ForgeCrew는 사내 GitHub Enterprise Server의 Issue와 Pull Request를 AI 대화 세션으로 사용하는 경량 셀프호스팅 플랫폼입니다. 단일 Dispatcher가 요청을 분배하고, 여러 PC의 Worker가 각 동료의 개발 환경과 로그인으로 Codex·Claude를 실행합니다.

> 개발 중입니다. 중앙 설정·SQLite 실행 상태·인증된 Dispatcher API·기본 GitHub 폴링과 Worker 진단이 구현되어 있습니다. 실제 AI 실행 어댑터와 Worker 실행 루프, Launcher·무인 업데이트는 아직 구현 중입니다. 실사용 릴리스 완료 여부는 [개발 계획](docs/PLAN.md)을 기준으로 확인하세요.

## 개발 환경에서 실행

Node.js 24 LTS와 npm을 사용합니다. 의존성 버전은 `package-lock.json`으로 고정합니다.

```bash
npm ci
npm run check
cp config.example.yaml config.yaml
```

`config.yaml`의 GitHub 호스트·API 주소·허용 저장소와 `server.dataDir`를 실제 환경에 맞게 수정합니다. 로컬 개발의 데이터 경로는 `.local/dispatcher`처럼 쓰기 가능한 경로를 사용하세요. PAT와 32자 이상의 Worker 등록용 비밀값을 각각 `FORGECREW_GITHUB_PAT`, `FORGECREW_REGISTRATION_TOKEN` 환경변수로 설정한 뒤 시작합니다.

```bash
npm run dev:dispatcher
```

`/health/live`, `/health/ready`에서 상태를 확인할 수 있습니다. 설정 파일은 주기적으로 다시 읽으며, 잘못된 변경은 마지막 정상 설정을 유지합니다. Worker용 `/v1/*` API는 Worker별 인증이 필요합니다. 최초 등록에는 등록용 비밀값을 사용하며, AI·GitHub 로그인 토큰을 등록 요청에 포함하지 않습니다.

Worker 진단은 [worker.example.json](worker.example.json) 형식의 로컬 설정을 읽습니다. PC마다 새 UUID와 무작위 플랫폼 토큰을 생성해 `id`, `token`을 바꾸세요. GitHub나 AI의 로그인 토큰을 복사하지 않습니다. 사용할 엔진만 `engines`에 남깁니다.

```bash
node packages/worker/dist/cli.js doctor --config /path/to/worker.json
```

현재 CLI는 `doctor`를 제공합니다. 설치·백그라운드 실행·자동 업데이트 명령과 두 엔진의 실제 작업 실행은 개발 중입니다.

Dispatcher의 Dockerfile도 제공합니다. 이미지에는 설정 파일과 비밀값을 넣지 않습니다. `/config/config.yaml`을 읽기 전용으로, `/data`를 쓰기 가능한 영속 볼륨으로 마운트하세요. 기본 healthcheck 포트는 설정 예제와 같은 8080입니다. Docker 이미지 빌드·컨테이너 시험은 아직 수행하지 않았습니다.

## 사용 방식

관리자가 허용한 저장소에서 Issue 또는 PR에 라벨을 붙이고, 평소처럼 본문과 댓글로 대화합니다. 기본 라벨 이름은 다음과 같으며 중앙 설정에서 조정할 수 있습니다.

| 라벨 | 의미 |
|---|---|
| `ai:enabled` | AI 세션 활성화 |
| `ai:model:sol` · `ai:model:terra` · `ai:model:opus` · `ai:model:sonnet` | 모델 계열 선택 |
| `ai:effort:low` · `ai:effort:medium` · `ai:effort:high` · `ai:effort:xhigh` | 추론 노력 수준 선택 |

모델 계열에서 사용 가능한 가장 높은 숫자 버전을 실행합니다. 모델·effort를 생략하면 저장소 또는 전체 기본 설정을 적용합니다. 라벨 변경은 다음 실행부터 반영됩니다.

일반 댓글은 순서대로 처리합니다. `/ai steer <내용>`은 진행 중인 작업에 추가 지시를 전달하고, `/ai stop`은 현재 작업을 중단합니다. AI가 질문을 남기면 이후 일반 댓글로 답하면 됩니다. 명령의 정확한 동작은 [SPEC](docs/SPEC.md#f3-일반-댓글-큐와-실행-제어-명령)에 정의되어 있습니다.

## 동료가 자신의 자동화를 실행하는 구조

| 구성 요소 | 역할과 환경 |
|---|---|
| Dispatcher | PAT로 GitHub를 폴링하고 배정·큐·공통 설정을 관리합니다. Linux Docker 이미지와 SQLite를 사용합니다. |
| Worker | Windows/Linux의 로컬 Node.js, 로그인된 `gh`, Codex 또는 Claude를 사용합니다. 두 엔진을 함께 활성화할 수도 있습니다. |
| 작업 결과 | 답변·댓글·PR 작업은 Worker에 로그인된 동료 계정으로 수행합니다. Git 작성자·서명은 해당 PC의 Git 설정을 따릅니다. |
| 운영 | Worker는 사내 npm으로 설치하며, 이후 업데이트·재시작은 자동으로 처리합니다. 일시적인 연결 장애에는 재접속합니다. |

Issue와 PR은 연결 정보를 참고하되 별도 세션으로 유지합니다. 작업이 반드시 코드 수정이나 PR 생성으로 끝날 필요는 없습니다. 요청을 시작하고 제어할 수 있는 사용자는 해당 저장소의 Write 이상 권한 보유자입니다.

## 공통 설정과 AI 작성 표기

운영자는 `config.yaml` 하나에서 저장소·라벨·모델 기본값·동작 주기·업데이트 정책·공통 작업 지침·출처 문구를 관리합니다. 프롬프트도 같은 YAML의 멀티라인 문자열로 작성합니다. [config.example.yaml](config.example.yaml)에 초기 설정 예제를 제공합니다.

Worker는 Dispatcher에서 필요한 설정을 받아 캐시하고 다음 Turn부터 적용합니다. 지침·표기 변경에는 패키지 재배포가 필요하지 않습니다. 잘못된 수정이나 일시적인 연결 실패는 마지막 정상 설정을 유지하며 재시도합니다. 개인 로그인·사용 엔진·PC의 동시 실행 수는 로컬에서 관리합니다.

Worker가 게시하는 AI 답변에는 다음과 같은 작은 표기를 자동으로 붙입니다. 문구와 형식은 중앙 설정으로 바꿀 수 있습니다.

<sub>🤖 AI-generated · ForgeCrew</sub>

직접 생성하는 PR 본문 등에도 같은 표기를 사용하도록 안내하고 확인 가능한 결과를 점검합니다. 런타임이 강제하는 게시 경로와 직접 작성 경로의 범위는 TECH에 정의되어 있습니다.

## 개발 문서

| 문서 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | 개발 시 항상 지킬 원칙 |
| [docs/SPEC.md](docs/SPEC.md) | 제품 동작, 기능·비기능 요구사항, 수용 기준 |
| [docs/TECH.md](docs/TECH.md) | 기술 스택, 실행·게시·중앙 설정·업데이트 계약 |
| [config.example.yaml](config.example.yaml) | 공통 설정·지침·표기의 초기 예제 |
| [docs/PLAN.md](docs/PLAN.md) | 구현 단계와 검증 시나리오, 현재 진행 상태 |

검증 결과와 다음 구현 항목은 PLAN에서 관리합니다.
