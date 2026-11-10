# AGENTS.md

헬스장 PT 트레이너의 일정 조율과 식단 피드백 초안 작성을 돕는 AI 에이전트입니다(과제용). 기획은 `docs/planning.md`에 있습니다.

## 구조

- `backend/` — Flue 에이전트(Cloudflare Workers). Flue 관련 규칙은 `backend/AGENTS.md`를 따른다.
- `frontend/` — Vite + React 채팅 화면(확정 카드, 사진 첨부). 구조와 규칙은 `frontend/AGENTS.md`를 따른다.
- `docs/` — 기획안과 README 이미지(`docs/images/`).

## 명령어

`backend/`에서 실행:

- `npm test` — 일정·회차권 판정 로직과 첨부 검사 단위 테스트(`node --test`, Node 22.18 이상, 모델 호출 없음)
- `npm run check:types` — 타입체크
- `npm run dev` — 로컬 개발 서버(http://localhost:8787). 먼저 `.dev.vars.example`을 `.dev.vars`로 복사해 토큰을 넣는다. `cloudflare/...` 모델 호출은 실제 Cloudflare 계정의 Workers AI 사용량으로 잡힌다.

`frontend/`에서 실행:

- `npm test` — 화면 로직 단위 테스트(`node --test`)
- `npm run check:types` / `npm run lint` / `npm run build` — 타입체크, 린트(oxlint), 빌드
- `npm run dev` — 개발 서버(http://localhost:5173). 백엔드 CORS가 이 주소만 허용하므로 포트를 바꾸지 않는다.

## 작업 규칙

- 일정 충돌과 회차권 계산은 순수 함수 코드로 판정한다. 모델이 프롬프트로 판단하게 두지 않는다.
- 일정을 바꾸는 작업은 트레이너가 화면에서 확정해야만 반영한다.
- 회원에게 보낼 글은 모두 초안으로만 만든다. 자동 발송 기능은 만들지 않는다.
- 비밀값(토큰, API 키)은 `.dev.vars` 또는 `wrangler secret`에만 둔다. 저장소에 커밋하지 않는다.
- 샘플 회원 데이터에는 가상 인물만 쓴다.
- 코드 주석, 커밋 메시지, 문서는 한국어로 쓰고 식별자는 영어로 쓴다.
