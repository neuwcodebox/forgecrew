# 핵심 요구사항 대조와 누락 보완

## 범위와 판단

SPEC의 핵심 계약을 코드와 대조해 입력 검증·stop/steer·복구·게시 안내를 보완했다. 기존 Dispatcher 저장소와 Worker 어댑터·제어 모듈을 사용한다. AGENTS 지침·요구사항 ID·중앙 YAML 키·DB/로컬 파일 schema·동료 명의 GitHub 작업·Auto Review 정책은 유지했다.

| 요구·단계 | 발견한 문제와 보완 |
|---|---|
| F1, F3, N4 / P2–P3 | 제어 명령이 권한 캐시를 사용해 권한 회수 직후 stop을 허용하거나 새로 권한을 얻은 사용자를 거절할 수 있었다. stop/steer 접수에는 신선한 Write 권한 조회를 사용한다. |
| F1, F2, F7, F10, N3, N4 / P2–P3 | Worker는 일반 댓글만 실제 원본과 대조했다. 최초 본문·PR 리뷰·리뷰 댓글도 변경/삭제를 확인해 Provider 시작 전 재조정한다. 계정이 삭제된 댓글도 게시 재조정을 막지 않도록 nullable 작성자를 처리한다. |
| F1, F3, F7, N3 / P2–P3 | 중앙에 stop이 접수된 뒤 release하면 Turn이 recovering으로 돌아갈 수 있었다. release·preflight·Lease 만료·steer 재개에서 stop을 지키고 취소한 Input은 소비 처리한다. 대기 중인 다른 Input은 보존한다. |
| F2, F3, N3, N6 / P2–P4 | 여러 steer가 동시에 처리되거나 Claude 재개 후 이전 Attempt에 남아 다음 지시를 잃을 수 있었다. 실행별 steer를 직렬화하고 남은 명령은 같은 Turn의 새 Attempt로 이동한다. stop은 막힌 steer RPC와 파일 조회를 기다리지 않으며, 접수된 stop이 있으면 새 실행을 발급하지 않는다. |
| F3, F10, F12, N3 / P2–P4 | 대상이 없는 제어와 Claude 대체 재개를 GitHub에 표시하는 경로가 빠져 있었다. 기존 Delivery·Worker 게시기를 사용해 자동화 안내를 멱등적으로 보낸다. 최초 활성화 이전 명령과 한 번도 활성화하지 않은 객체는 재생하지 않는다. |
| F3, F7, N3 / P2–P3 | 완료와 제어 ACK가 경합할 때 적용 성공과 미적용을 단정할 수 없다. 확인 불가 상태를 기록·안내하고 늦은 정상 ACK는 확정할 수 있게 했다. 확정된 미적용을 ACK가 덮어쓰지는 않는다. |
| F1, F3, N3 / P2–P3 | 같은 타임스탬프의 Input을 문자열 ID로 정렬해 `10`이 `9`보다 먼저 실행되거나 최초 본문이 뒤로 갈 수 있었다. 본문 우선·숫자 ID 순서로 결정한다. |

## Windows 배포 검사에서 확인한 추가 복구 경로

[첫 코드 CI 41542832508](https://github.com/neuwcodebox/forgecrew/actions/runs/41542832508)의 Windows 검사에서는 165개 시험·빌드가 통과했으나 packed Worker의 READY 확인이 실패했다. Worker 재연결 로그와 Launcher 상태 처리 오류가 있었고, 뒤의 권한 수정 커밋에서는 같은 Launcher 코드로 Windows 전체 검사가 통과했다. 첫 실패의 구체 OS 오류 코드는 당시 로그에 없어 단정하지 않는다.

READY 수신 후 파일 저장에 실패하면 상태가 `starting`에 남고 다시 저장하지 않는 경로를 코드에서 확인했다. 상태 파일 자리를 디렉터리로 바꿔 저장을 실패시키고 복원하는 시험으로 재현한 뒤, READY 정보를 보존해 저장을 재시도하도록 수정했다. 준비·안정화 시각은 저장 성공 후 확정한다. 건강한 Worker를 재기동하지 않고 복구하는 것을 시험했으며 Launcher 진단에는 비밀값 없는 오류 코드도 남긴다. 부트스트랩은 기존 단일 파일·프로토콜 1·setup/repair 갱신 계약을 유지한다.

## 상태와 게시 계약

- 제어 수신과 안내 생성, 실행 종료와 남은 제어 정리는 같은 SQLite 트랜잭션에 둔다. 안내는 Control ID에 연결한 별도 Delivery 그룹이므로 실행 결과 재전송 목록과 섞이지 않는다.
- 안내도 발급된 작성 계정·본문 hash·Delivery 표식·receipt로 재조정하고 중앙 automationAttribution을 사용한다. 새 Input/AI Turn으로 바꾸지 않는다.
- Claude의 `steer-restart` 응답은 stop이 우선 적용되면 `claim: null`이다. Worker는 이 응답으로 Provider를 시작하지 않는다.
- 확인하지 못한 명령을 적용/거절 성공으로 위장하지 않는다. `unconfirmed` 안내는 당시 확인 한계를 나타내며 이후 ACK가 도착해도 그 문장을 거짓으로 만들지 않는다.

## 검증

30개 계약·통합 시험을 추가했다. 네 입력 종류의 변경·삭제·정상 맥락, 삭제된 계정, 캐시 안의 권한 회수·부여, stop의 release/preflight/steer 경합, 명령 순서·preemption·재개 시 대상 유지, 미적용 안내의 멱등성·동료 명의 게시·자동화 표기, 과거 명령 제외, ACK 경합과 같은 시각의 FIFO를 포함한다. 변경 전 실패를 재현한 뒤 보완했으며 Promise gate·이벤트 루프 경계로 동시성 순서를 제어했다.

로컬 Linux / Node.js 24.22.1에서 `npm run check`의 포맷·미사용 코드·타입 검사, 168개 테스트, 세 패키지 빌드, Dispatcher·packed Worker 설치·서비스 단절 중 READY·정상 stop, loopback npm의 tarball 자동 전환/rollback·영속 상태 보존 smoke가 통과했다.

코드는 `c53e87d`(입력·제어 계약), `aa5700c`(권한 재확인), `548f3b122468f1844d3a173370186bd2e65c91ea`(READY 저장 복구)에 반영했다. 최종 [CI 41544032721](https://github.com/neuwcodebox/forgecrew/actions/runs/41544032721)에서 Linux·Windows의 168개 테스트·빌드·세 smoke와 Docker 검사가 모두 통과했다. 실제 GHES·구독 모델/Auto Review·사내 npm·사용자 OS 로그인/절전의 수용 검증은 기존 PLAN에서 계속 미완료다.
