# SOLID·클린 코드 리팩토링

## 범위와 판단

사용자는 전체 구현에 SOLID·클린 코드 원칙을 적용하도록 요청했다. 기존 F/N 요구와 P1–P6 수용 기준은 유지하며, 책임·의존 방향·명명·중복·검증 수단을 정리했다. `AGENTS.md`는 기준 커밋 `c38a56c`와 동일하다.

## 구조 변경

- Dispatcher 저장소를 설정·Worker·Session·실행·Delivery·진단·checkpoint로 분리했다. `Store`는 연결 소유와 조립을 맡고 호출자는 필요한 저장 컴포넌트를 직접 사용한다. 실행 완료와 Delivery 생성의 SQLite 트랜잭션 경계는 유지했다.
- Worker 실행 정책을 `ConfigurationSync`, `WorkerInventory`, `AttemptRunner`, `ControlProcessor`, `ResultReporter`, `DeliveryPump`로 나눴다. 각 컴포넌트는 필요한 Dispatcher·GitHub·작업 공간 기능만 받는다. `WorkerRuntime`은 루프·초기화·drain·종료를 조정한다.
- `application.ts`에 실제 HTTP·gh·Git·AI 어댑터 조립을 모았다. 핵심 실행 코드가 구체 어댑터를 생성하거나 환경변수·프로세스 IPC로 배포 환경을 결정하지 않도록 버전·로그·READY·안정화 상태를 주입한다.
- Worker의 URL·JSON 요청 조립은 Dispatcher HTTP 어댑터에 모으고 호출자는 `complete`, `renewAttempt`, `claimDelivery` 같은 명시적 작업 계약을 사용한다. GitHub 조회·게시와 Git 작업 공간 준비도 별도 계약을 사용한다. 테스트 대역은 실제 `GhClient` 상속 대신 필요한 인터페이스를 구현한다.
- CLI의 명령별 작업과 setup 설정 구성을 분리했다. setup 설정은 기존 객체를 변경하지 않고 한 번 검증하며 Worker ID·토큰·기존 실행 파일 선택을 보존한다.
- GitHub REST 어댑터와 수집 정책을 분리했다. Poller는 세션·댓글·리뷰·라벨 단계를 명명된 메서드로 구분하고 각 수집 스트림의 checkpoint 의미를 유지한다.
- 공통 설정을 스키마·projection·재로드로 나눴다. Provider도 모델 카탈로그와 통신·실행 책임을 분리하고 메시지 처리의 명시적 `any`를 없앴다. Claude의 잘못된 session ID는 저널에 저장하기 전에 거절한다.
- Prettier 3.9.10과 설정을 고정하고 포맷 검사와 TypeScript 미사용 코드 검사를 기본 `check`에 포함했다. 이전 경로를 유지하기 위한 빈 전달 모듈·범용 DI 프레임워크·기능별 동일 계층 반복은 추가하지 않았다. 독립 Launcher는 배포 계약상 단일 파일을 유지했다.

## 보존한 계약

Session/Input/Turn/Attempt/Delivery 식별·FIFO·stop 대상·Claude의 같은 Turn steer 재시작, frozen RunConfig·Lease, 완료 저널·중복 게시 방지·stale 결과 보존을 유지했다. HTTP 경로·요청 형식·DB migration·파일 상태 schema·Launcher IPC·패키지 진입점도 유지했다. Auto Review·구독 로그인·로컬 사용자 권한을 바꾸거나 승인·Sandbox 우회를 추가하지 않았다.

## 검증

- 로컬 Linux / Node.js 24.22.1에서 131개 계약·통합·프로세스 테스트, TypeScript 검사, 세 패키지 빌드와 smoke 검사가 통과했다. 포맷·미사용 코드 검사도 통과했다.
- 추가 시험은 setup의 초기 엔진 선택·재설정 시 ID/토큰/실행 파일 보존·엔진 추가/제거·잘못된 옵션 거절과 Claude의 잘못된 세션 ID를 검증한다.
- smoke는 빌드된 Dispatcher의 SQLite·인증·YAML 재로드, packed Worker의 깨끗한 설치·서비스 불통 중 READY·정상 stop, loopback npm의 실제 tarball 전환·불량 버전 rollback·ID/저널/작업 파일 보존을 포함한다.
- 코드 `06316f6710fc20d9de355e9ecb121160739f78c9`의 [CI 41465251432](https://github.com/neuwcodebox/forgecrew/actions/runs/41465251432)에서 Linux/Windows의 포맷·미사용 코드·타입 검사·131개 시험·빌드·세 smoke와 Docker 검사가 모두 통과했다. Docker에서는 비루트·읽기 전용 실행, 원자적 설정 교체, SQLite 재시작과 백업·복원도 확인했다.

실제 GHES·구독 모델 Turn/Auto Review·회사 npm·실제 사용자 로그인/절전 수용 시험은 제공된 환경이 없어 진행하지 않았다. 기존 PLAN의 미완료 표시는 유지한다.

## 커밋

- `b8dc39d`: 포맷 기준과 일관된 코드 서식.
- `83c7e67`: 책임별 Dispatcher 저장소.
- `ab5c509`: 계약 주입과 Worker 실행 유스케이스 분리.
- `06316f6`: 설정·CLI·GitHub·Provider 경계와 검증 기준 정리.
