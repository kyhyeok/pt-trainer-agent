// 라우트 맵. 미들웨어 순서가 중요하다: CORS → 인증 → 라우트.
// CORS가 인증보다 앞에 있어야 브라우저의 사전 요청(OPTIONS, Authorization 헤더 없음)이 401로 막히지 않는다.

import { dispatch, instrument } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as v from 'valibot';
import { APPROVAL_SIGNAL, TrainerAssistant } from './agents/trainer.ts';
import { validateAttachments } from './attachments.ts';

// 회원의 식단·건강 정보가 오가므로 Workers Traces에 대화 내용을 남기지 않는다(모듈 최상단에서 등록해야 기본값을 대신한다).
// 개발 서버가 의존성 최적화 뒤 같은 isolate에서 이 모듈을 다시 실행하면 두 번째 instrument()가 예외를 던진다.
// 그래서 '이 모듈이 이미 설치했다'는 표시가 있을 때만 건너뛴다. 다른 이유로 실패하면(예: 기본 트레이싱이 먼저 설치됨) 그대로 예외를 내
// 대화 내용이 담기는 트레이싱이 조용히 켜진 채 넘어가지 않게 한다.
const TRACING_INSTALLED = Symbol.for('pt-trainer-agent.tracing-installed');
const globals = globalThis as Record<symbol, boolean | undefined>;
if (!globals[TRACING_INSTALLED]) {
	instrument(createCloudflareTracing({ content: false }));
	globals[TRACING_INSTALLED] = true;
}

interface Bindings {
	/** 트레이너용 접근 토큰. 로컬은 .dev.vars, 배포는 `wrangler secret put AGENT_TOKEN` */
	AGENT_TOKEN?: string;
	/** 프런트엔드 출처(예: http://localhost:5173). wrangler.jsonc의 vars */
	ALLOWED_ORIGIN?: string;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use(
	'*',
	cors({
		origin: (origin, c) => (origin && origin === c.env.ALLOWED_ORIGIN ? origin : null),
		allowHeaders: ['Content-Type', 'Authorization'],
		// SDK가 다음 읽기 위치(offset)를 헤더에서 읽으므로 교차 출처에서도 노출해야 한다
		exposeHeaders: ['Location', 'Stream-Next-Offset', 'Stream-Up-To-Date'],
	}),
);

/** 길이가 같을 때 끝까지 비교해, 일치하는 글자 수로 토큰을 추측하기 어렵게 한다 */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

app.use('*', async (c, next) => {
	const token = c.env.AGENT_TOKEN;
	if (!token) return c.json({ error: '서버에 AGENT_TOKEN이 설정되지 않았습니다' }, 500);
	if (!safeEqual(c.req.header('Authorization') ?? '', `Bearer ${token}`)) {
		return c.json({ error: '인증이 필요합니다' }, 401);
	}
	await next();
});

/** 대화 id와 확정 요청 id는 영문·숫자·-·_만 받는다(도구 호출 id 형식: chatcmpl-tool-<hex>) */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const ApprovalBody = v.object({
	approvalId: v.pipe(v.string(), v.regex(SAFE_ID)),
	decision: v.picklist(['approve', 'deny']),
});

// 에이전트 대화 URL로는 트레이너의 채팅 메시지(kind: 'user')만 받는다.
// 신호(kind: 'signal')를 직접 보내면 확정 신호를 승인 라우트(형식 검사, 멱등 키) 없이 넣을 수 있기 때문이다.
app.on('POST', '/agents/pt-trainer/:id', async (c, next) => {
	const body = await c.req.raw.clone().json().catch(() => null);
	if (!body || typeof body !== 'object' || (body as { kind?: unknown }).kind !== 'user') {
		return c.json({ error: '이 경로로는 트레이너 메시지(kind: "user")만 보낼 수 있습니다' }, 403);
	}
	// 잘못된 사진이 대화를 멈추거나 이후 사진 기능을 망가뜨리지 않도록, Flue에 넘기기 전에 검사한다
	const check = validateAttachments((body as { attachments?: unknown }).attachments);
	if (!check.ok) return c.json({ error: check.reason }, 400);
	await next();
});

// 확정 카드의 [확정]/[거절] 버튼이 부르는 라우트. 결정을 신호로 에이전트에 넣는다.
// idempotencyKey를 approvalId로 묶어, 같은 요청이 두 번 와도 한 번만 처리되고 다른 결정은 409로 거부된다.
app.post('/api/approvals/:conversationId', async (c) => {
	const conversationId = c.req.param('conversationId');
	if (!SAFE_ID.test(conversationId)) return c.json({ error: '대화 id 형식이 잘못되었습니다' }, 400);
	const parsed = v.safeParse(ApprovalBody, await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: 'approvalId와 decision(approve|deny)이 필요합니다' }, 400);
	const { approvalId, decision } = parsed.output;

	try {
		const receipt = await dispatch(TrainerAssistant, {
			id: conversationId,
			message: {
				kind: 'signal',
				type: APPROVAL_SIGNAL,
				body: `트레이너가 ${decision === 'approve' ? '확정' : '거절'}을 눌렀습니다 (${approvalId})`,
				attributes: { approvalId, decision },
			},
			idempotencyKey: `approval:${approvalId}`,
		});
		return c.json(receipt, 202);
	} catch (error) {
		// Flue의 HTTP 오류는 status를 가진다. 같은 idempotencyKey에 다른 결정이 오면 409(submission_conflict)다
		const status = (error as { status?: unknown } | null)?.status;
		if (status === 409) return c.json({ error: '이미 다른 결정이 접수된 요청입니다' }, 409);
		// 내부 오류 메시지는 서버 로그에만 남기고 응답에는 일반 문구만 보낸다
		console.error('approval dispatch failed', error);
		const clientError = typeof status === 'number' && status >= 400 && status < 500;
		return c.json({ error: clientError ? '요청을 처리할 수 없습니다' : '확정을 처리하지 못했습니다' }, clientError ? 400 : 500);
	}
});

app.route('/agents/pt-trainer', createAgentRouter(TrainerAssistant));

export default app;
