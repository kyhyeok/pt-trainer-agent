// 대화 id 규칙. 백엔드(app.ts)의 SAFE_ID와 같은 규칙으로 미리 검사해, 서버에서 400을 받기 전에 화면에서 알린다.

export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const DEFAULT_CONVERSATION_ID = 'trainer-demo';

export function isValidConversationId(id: string): boolean {
	return SAFE_ID.test(id);
}

/** 한국 시간 날짜와 무작위 6글자로 새 대화 id를 만든다. 예: trainer-20261110-a1b2c3 */
export function newConversationId(now: Date = new Date(), random: () => string = () => crypto.randomUUID()): string {
	const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	const ymd = kst.toISOString().slice(0, 10).replaceAll('-', '');
	const suffix = random().replaceAll('-', '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
	return `trainer-${ymd}-${suffix || '000000'}`;
}

/** 백엔드 주소를 검사한다. http(s)만 받고 끝의 /는 뗀다. 잘못되면 null */
export function normalizeAgentUrl(raw: string | undefined): string | null {
	const value = (raw ?? '').trim();
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		if (url.username || url.password || url.search || url.hash) return null;
		return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
	} catch {
		return null;
	}
}

/**
 * 토큰을 붙여 가져와도 되는 주소인지 본다. 백엔드와 출처(프로토콜·호스트·포트)가 같고 경로가 백엔드 경로 아래일 때만 허용한다.
 * 첨부 사진 주소는 서버가 준 값이라, 다른 곳을 가리키면 토큰이 새어 나갈 수 있다.
 */
export function isAgentResource(resourceUrl: string, agentUrl: string): boolean {
	try {
		const resource = new URL(resourceUrl);
		const agent = new URL(agentUrl);
		if (resource.origin !== agent.origin) return false;
		const base = agent.pathname.replace(/\/+$/, '');
		return resource.pathname === base || resource.pathname.startsWith(`${base}/`);
	} catch {
		return false;
	}
}
