---
name: flue-dev
description: Flue 에이전트 코드(backend/src)를 쓰거나 고치기 전에 따르는 절차. 번들 문서로 API를 확인하고, 이 프로젝트에서 확인된 Flue 함정을 점검한다. Flue 훅(useModel, useTool, usePersistentState, useSkill, useAgentStart 등), app.ts 라우팅, wrangler.jsonc를 바꿀 때 사용한다.
---

# Flue 작업 절차

1. 쓰려는 API를 번들 문서에서 찾는다. 설치된 버전과 일치하고 네트워크가 필요 없다.
   ```sh
   cd backend
   npx flue docs search "<검색어>"
   npx flue docs read <경로>   # 예: guide/tools, reference/agent-hooks-api
   ```
2. 아래 체크리스트로 변경 내용을 점검한다.
3. `npm run check:types`를 실행하고, 로직을 바꿨다면 테스트도 실행한다.

## 함정 체크리스트

- **반영 시점**: 에이전트 함수는 모델을 호출하기 직전마다 다시 실행된다. 모델 선택은 제출(POST 1건) 단위로 고정되고, 시스템 프롬프트와 도구 목록은 다음 모델 호출부터 바뀐다.
- **훅 호출 위치**: 훅은 렌더 중에만 호출한다. 도구의 `run`이나 이벤트 콜백 안에서 훅을 부르면 예외가 난다. 반대로 상태 setter는 렌더 중에 부르면 안 되고, 도구나 콜백 안에서만 부른다.
- **상태 갱신**: `set((prev) => next)` 같은 updater 형태로 쓴다. 같은 턴에 일어난 다른 쓰기를 덮어쓰지 않는다.
- **프롬프트 캐시**: 자주 바뀌는 값(현재 시각, 잔여 횟수)은 시스템 프롬프트에 넣지 않고 도구로 조회하게 한다.
- **도구 설명**: 모델이 보는 유일한 문서다. 무엇을 하고, 언제 쓰고, 무엇을 돌려주는지 쓰고, 다른 도구와 설명이 겹치지 않게 한다. 도구 인자는 모델이 고른 값이므로 권한 경계로 쓰지 않는다.
- **크래시 복구**: 일반 도구는 크래시 뒤 다시 실행되지 않는다. 외부 부작용이 있으면 durable 도구, `step.do`, 멱등 키를 함께 쓴다.
- **스킬**: 설명 한 줄로 선택되므로 설명을 구체적으로 쓴다. `name`은 디렉터리 이름과 같아야 한다.
- **미들웨어 순서**: CORS 미들웨어는 인증 미들웨어보다 앞에 둔다. `exposeHeaders`에는 `Location`, `Stream-Next-Offset`, `Stream-Up-To-Date`를 넣는다.
- **트레이스**: 기본값은 대화 내용을 담는다. 회원 정보가 오가므로 `createCloudflareTracing({ content: false })`를 쓴다.
- **에이전트 이름**: 이름을 바꾸면 Durable Object 클래스도 바뀐다. `agentName`으로 고정하고, 배포 뒤에 바꿀 때는 `renamed_classes` 마이그레이션을 추가한다.
- **이미지 입력**: `cloudflare/@cf/...` 모델 중 이미지 입력을 지원하지 않는 모델은 이미지를 `(image omitted)`로 바꾼다. 이미지가 필요하면 지원 모델을 쓴다.

## 참고

- 블로그 시리즈 "Flue로 AI 에이전트 만들기"(위 함정들의 근거와 예제): https://codebydev.co.kr/category/ai/agent/
