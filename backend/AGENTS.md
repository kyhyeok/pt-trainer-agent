# backend — Flue 에이전트 (Cloudflare Workers)

[Flue](https://flueframework.com) 프로젝트입니다. 에이전트는 TypeScript 함수이고, 함수 본문의 훅으로 모델, 도구, 스킬, 상태를 붙입니다.

## 구조

- `src/schedule.ts` — 일정 판정 순수 함수: 근무 시간, 겹침, 지난 시간, 대안 시간, 추가·이동.
- `src/packages.ts` — 회차권 순수 함수: 잔여 횟수, 예약 가능 여부, 24시간 취소 규칙, 출석·노쇼 차감. 에이전트 도구는 일정 변경 시 `bookSession`·`rescheduleSession`·`cancelSession`·`recordAttendance`를 써서 회차권 검사가 빠지지 않게 한다.
- `src/*.test.ts` — 위 두 모듈의 테스트(`npm test`). 판정 규칙을 바꾸면 테스트를 먼저 고친다.
- `src/agents/` — 에이전트 모듈. 첫 줄이 `'use agent'`인 파일에서 export한 대문자 함수가 에이전트다. 함수 이름(또는 `agentName` 정적 속성)이 에이전트의 정체성이자 저장소 키다.
- `src/app.ts` — 라우트 맵(Hono). 에이전트와 커스텀 라우트를 모두 여기서 직접 마운트한다.
- `src/cloudflare.ts` — Worker 수준 export와 cron 같은 비 HTTP 핸들러.
- `wrangler.jsonc` — Worker 설정. 에이전트마다 Durable Object 마이그레이션 항목이 필요하다.

## 명령어

- `npm run dev` — 개발 서버. `cloudflare/...` 모델은 이 서버에서만 동작한다.
- `npm test` — 판정 로직 단위 테스트
- `npm run check:types` — 타입체크
- `npm run deploy` — 빌드 후 배포. 사용자 승인을 받은 뒤에만 실행한다.
- `npx flue docs search <검색어>` / `npx flue docs read <경로>` — 설치된 버전의 Flue 문서를 오프라인으로 본다.
- `npx flue add` — 채널, DB, 샌드박스 블루프린트 목록을 본다.

## 주의

- `npx flue run`은 `cloudflare/` 모델이면 `Unknown provider "cloudflare"`로 실패한다. `npm run dev`를 띄우고 HTTP로 테스트한다.
- 배포된 마이그레이션 항목은 수정하거나 순서를 바꾸지 않는다. 새 태그를 추가한다.
- `@cf/zai-org/glm-5.3`은 텍스트 전용이다. 이미지를 보내면 `(image omitted)`로 바뀐다. 이미지가 필요하면 `@cf/zai-org/glm-5.3-flash`처럼 이미지 입력을 받는 모델을 쓴다.
- 로컬 비밀값은 `.dev.vars`(커밋 금지)에, 배포 비밀값은 `npx wrangler secret put <이름>`으로 넣는다.
