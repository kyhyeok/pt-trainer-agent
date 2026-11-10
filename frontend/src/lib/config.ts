import { normalizeAgentUrl } from './conversation.ts';

/** 백엔드 주소. VITE_AGENT_URL이 잘못되면 null(화면에 오류를 보여 준다) */
export const AGENT_URL: string | null = normalizeAgentUrl(import.meta.env.VITE_AGENT_URL ?? 'http://localhost:8787');

/** app.ts가 에이전트를 붙인 경로 */
export function conversationUrl(agentUrl: string, conversationId: string): string {
	return `${agentUrl}/agents/pt-trainer/${encodeURIComponent(conversationId)}`;
}

export function approvalUrl(agentUrl: string, conversationId: string): string {
	return `${agentUrl}/api/approvals/${encodeURIComponent(conversationId)}`;
}

/** 서버 오류 응답({ error: string })에서 보여 줄 문구를 꺼낸다. 길면 자른다 */
export function errorText(body: unknown, fallback: string): string {
	if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
		const text = (body as { error: string }).error.trim();
		if (text) return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	}
	return fallback;
}
