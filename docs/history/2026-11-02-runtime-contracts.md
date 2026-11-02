# Provider 실행 계약 확인

## 환경과 확인 범위

- 개발 환경: Linux, Node.js 24.22.1.
- Codex: 공식 `@openai/codex` 0.166.0 실행 파일의 `app-server generate-json-schema`로 시작·재개·Turn·모델·승인 필드를 확인했다. 실제 App Server 기동과 initialize·account/read·config/read를 수행해 `auto_review`와 `on-request`의 적용을 확인했다. 실제 구독 모델 Turn과 도구 승인 판단은 실행하지 않았다.
- Claude: 공식 `@anthropic-ai/claude-agent-sdk` 0.3.316의 공개 타입·프로토콜 정의를 참조했다. SDK를 제품 의존성이나 인증 경로에 추가하지 않았으며, 구현은 공식 `claude` 실행 파일의 stream-json 인터페이스를 사용한다. 실제 Claude 구독 실행은 미시험이다.

## 구현에 반영한 계약

- Codex 0.166.0의 승인 정책 wire 값은 `on-request`이며 reviewer 값은 `auto_review`다. 스레드 응답의 실제 모델·effort·reviewer를 검사하고, sandbox는 기존 로컬·관리 정책을 사용한다.
- 기존 Codex `developer_instructions`를 읽어 중앙 지침과 결합한다. 저장소 지침·사용자 전역 파일을 덮어쓰지 않는다.
- Claude initialize 모델 목록의 `resolvedModel`, `supportsAutoMode`, `supportedEffortLevels`로 카탈로그를 만든다. 숫자 모델 ID를 확인할 수 없는 alias는 추측해 광고하지 않는다.
- Claude control initialize·get_settings·set_permission_mode·interrupt와 system/init·result를 구분한다. 실제 모델과 effort를 확인한 뒤 사용자 입력을 보낸다. 재개 시에는 새 중앙 지침을 적용하도록 prompt snapshot을 끈다.
- stop은 현재 Turn 취소, Worker 종료는 미완료 Turn 회수, Claude steer는 기존 실행 종료 후 같은 Turn의 새 Attempt 발급으로 구분한다.
- 완료 보고와 GitHub 게시를 분리한다. 로컬 저널은 완료 ACK 뒤에 정리하며, 게시 응답 유실은 표식·작성 계정·본문 해시로 조정한다. 런타임 오류에는 자동화 표기를 사용한다.

## 검증 근거

`tests/providers.test.ts`는 별도 프로세스 Fixture로 질문·모델 불일치·steer·Claude 설정 확인을 시험한다. `tests/runtime.test.ts`는 실제 Hono API와 SQLite를 연결해 실행·세션 재개·지침 변경·완료 ACK 유실·게시 응답 유실·stop·Claude steer·중복 기동 방지를 검증한다. Fixture 통과는 실제 계정·회사 정책·네트워크 환경의 승인으로 간주하지 않는다.

공식 자료: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Codex Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review), [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Claude headless](https://code.claude.com/docs/en/headless).
