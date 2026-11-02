# Launcher와 버전 전환 계약 구현

관련 요구는 F7·F11·F12·N2·N3·N5, 단계는 P1·P3·P5다.

## 구현

Worker 패키지에 의존성 없는 Launcher protocol 1 부트스트랩을 포함한다. setup이 로컬 Launcher·실행 경로·최초 버전 snapshot을 준비하고 start/stop/status가 사용자별 단일 프로세스와 의도적 종료 상태를 관리한다. setup 재실행은 정지 상태의 부트스트랩 repair 경로다. Linux 사용자 systemd 서비스와 Windows 현재 사용자의 제한된 로그온 작업 등록/해제를 제공한다. 전역 npm이나 실행 중 버전 디렉터리를 덮어쓰지 않는다.

버전별 Worker가 중앙 업데이트 설정으로 정확한 npm 버전을 staging에 설치한다. 사용자 npm 인증·프록시·CA를 유지하며 설치 스크립트를 비활성화한다. tarball registry origin, lock integrity·resolved URL, package 이름·버전·단독 번들·bin, Node engine, Launcher protocol·상태 schema를 확인한 완성된 설치만 versions로 옮긴다. 실패 버전 cooldown은 설치기와 Launcher에서 확인한다.

STAGE_READY를 포인터에 기록한 뒤 ACK한다. Worker는 새 Claim을 중지하고 Lease·제어·결과 게시를 유지한다. 현재 Turn 종료 또는 drain 한도 interrupt·종료 후 SWITCH를 요청한다. 새 Worker는 안정화 중 새 Claim을 받지 않으며, READY·로컬 HEALTH와 관찰 구간을 통과한 뒤 ACTIVATE를 받는다. Dispatcher 불통은 로컬 버전 실패로 분류하지 않는다. 호환 schema의 마지막 설정 캐시를 사용해 초기 연결 실패 중에도 업데이트를 확인할 수 있다.

포인터는 원자적으로 교체하며 이전 포인터를 보존한다. 전환/관찰 도중 Launcher가 충돌하면 후보를 정상으로 간주하지 않고 lastKnownGood로 복구한다. 자식 프로세스 ID와 OS 생성 식별자를 기록해 재시작 시 PID 재사용으로 다른 프로세스를 종료하지 않게 확인한다. Worker 출력은 크기를 제한해 회전한다.

## 검증 범위

- Launcher 자식 프로세스로 중복 start, 의도적 stop, 명시적 재시작, 전환 순서, READY·안정화·승격, 후보 충돌·rollback·cooldown, 전환 도중 충돌 복구와 포인터 손상을 시험했다.
- npm metadata/설치 Fixture로 정확한 버전·ignore-scripts·engine-strict·lock 무결성·registry origin·배포 계약을 확인했다.
- Worker 통합 시험으로 Turn 경계 drain과 한도 interrupt 후 recovering 상태, 대기 입력·미게시 Delivery 보존을 확인했다.
- 실제 `npm pack` 산출물을 개발 의존성 없는 별도 prefix에 설치해 CLI·Launcher·로컬 READY·graceful stop을 시험했다. gh를 로컬 실패 Fixture로 바꿔 외부 계정이나 모델을 사용하지 않았다.

실제 사내 registry 게시·인증·실행 중 새 릴리스 감지, Windows/Linux 로그인/로그아웃·절전·자식 프로세스 트리 종료, 실제 구독 모델·Auto Review·GHES 대화는 별도 운영 수용 시험으로 남아 있다. 어댑터/Fixture 통과를 해당 시험의 완료로 표시하지 않는다.

## CI와 컨테이너 검증

코드 `4ddc3c8`의 [CI 41451169932](https://github.com/neuwcodebox/forgecrew/actions/runs/41451169932)는 Linux/Windows 90개 테스트·빌드·패키지 smoke와 Docker 검사를 모두 통과했다. 컨테이너 시험은 production 이미지의 native SQLite 로딩, 비루트·읽기 전용 실행, YAML의 잘못된/정상 후보 원자 교체, SIGTERM 종료·재시작, 다른 볼륨으로 복사한 SQLite 상태에서 Worker 인증 복구를 확인했다. 테스트 컨테이너는 `--network none`을 사용해 사내 GitHub나 외부 서비스에 접근하지 않는다. 설정의 원자적 파일 교체는 파일 대신 상위 디렉터리를 마운트하는 방식으로 유지한다.

Windows Launcher 전환 시험에서 native 프로세스 식별 검사 때문에 기본 Vitest 5초 한도를 초과했다. 상태·이벤트 조건 검증은 유지하고 해당 suite의 실패 한도를 20초로 조정했다. 고정 대기 시간으로 성공을 판단하지 않는다.

배포 패키지 smoke의 gh 실패 Fixture는 기존 OS PATH 앞에 추가한다. 시스템 경로를 제거하지 않으며 로컬 READY 관찰 한도를 Launcher의 30초 기동 한도에 맞췄다. 실패 시 상태와 로컬 로그를 남기며 외부 로그인이나 모델 실행을 사용하지 않는다.

## 실제 npm 전환 시험

`scripts/update-smoke.mjs`는 loopback npm packument·tarball 서버를 띄우고 실제 `npm view`·`npm install`로 정확한 새 버전을 설치한다. 원래 Worker의 오프라인 설정 캐시에서 자동 업데이트를 시작하고 정상 후보의 READY·관찰·승격, 기동 실패 후보의 lastKnownGood 복귀·cooldown까지 연결했다. 그 전후 Worker ID·로컬 토큰 설정·미전달 결과 저널·작업 파일을 비교했다. gh는 로컬 실패 Fixture이므로 외부 로그인·모델 Turn을 호출하지 않는다.

scope별 `.npmrc` registry가 중앙 출처를 덮어쓰지 못하도록 npm 명령에 전역 registry와 해당 scope registry를 함께 고정한다. 시험에서는 사용자 scope 설정을 실패하는 다른 loopback 주소로 둬 이 우선순위를 검증한다. 사내 registry 게시·인증과 사용자 로그인 자동 시작의 실제 검증을 대체하지 않는다.

설치 실패·lock 무결성 불일치·지원하지 않는 상태 계약을 각각 주입해 정상 active/lastKnownGood 포인터가 바뀌지 않고 staging이 정리되는 시험도 통과했다. 실제 npm/프로세스 전환 시험과 이 실패 주입 시험의 범위를 구분한다.
