// 화면 진입점: 접속 양식(토큰·대화 이름) → 채팅.
// 토큰은 번들이나 localStorage에 넣지 않고, 이 탭의 sessionStorage에만 둔다.

import { type SubmitEvent, useState } from 'react';
import { Chat } from './Chat.tsx';
import { AGENT_URL, conversationUrl, errorText } from './lib/config.ts';
import { DEFAULT_CONVERSATION_ID, isValidConversationId, newConversationId } from './lib/conversation.ts';
import { session } from './lib/session.ts';

interface Connection {
	token: string;
	conversationId: string;
}

function initialConnection(): Connection | null {
	const token = session.token();
	const conversationId = session.conversationId();
	if (!token || !conversationId || !isValidConversationId(conversationId)) return null;
	return { token, conversationId };
}

export default function App() {
	const [connection, setConnection] = useState<Connection | null>(initialConnection);

	if (!AGENT_URL) {
		return (
			<main className="flex min-h-dvh items-center justify-center bg-stone-50 p-4 text-stone-800">
				<p role="alert" className="max-w-md rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
					VITE_AGENT_URL 값이 올바른 http(s) 주소가 아닙니다. <code>frontend/.env</code>를 확인하세요.
				</p>
			</main>
		);
	}

	if (!connection) {
		return (
			<ConnectScreen
				agentUrl={AGENT_URL}
				onConnect={(next) => {
					session.save(next.token, next.conversationId);
					setConnection(next);
				}}
			/>
		);
	}

	return (
		<Chat
			// 대화가 바뀌면 화면 상태(누른 버튼, 입력 중인 글)를 모두 새로 시작한다
			key={connection.conversationId}
			agentUrl={AGENT_URL}
			token={connection.token}
			conversationId={connection.conversationId}
			onNewConversation={() => {
				const conversationId = newConversationId();
				session.saveConversation(conversationId);
				setConnection({ ...connection, conversationId });
			}}
			onDisconnect={() => {
				session.clearToken();
				setConnection(null);
			}}
		/>
	);
}

function ConnectScreen({ agentUrl, onConnect }: { agentUrl: string; onConnect: (connection: Connection) => void }) {
	const [token, setToken] = useState('');
	const [conversationId, setConversationId] = useState(session.conversationId() ?? DEFAULT_CONVERSATION_ID);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (checking) return;
		const trimmedToken = token.trim();
		const trimmedId = conversationId.trim();
		if (!trimmedToken) return setError('토큰을 입력하세요');
		if (!isValidConversationId(trimmedId)) return setError('대화 이름은 영문·숫자·-·_만, 128자까지 쓸 수 있습니다');

		// 들어가기 전에 토큰이 맞는지 확인한다. 아직 없는 대화는 404라서 그것도 정상으로 본다(모델은 부르지 않는다)
		setChecking(true);
		setError(null);
		try {
			const response = await fetch(conversationUrl(agentUrl, trimmedId), { headers: { Authorization: `Bearer ${trimmedToken}` } });
			if (response.ok || response.status === 404) {
				onConnect({ token: trimmedToken, conversationId: trimmedId });
				return;
			}
			const body = await response.json().catch(() => null);
			setError(response.status === 401 ? '토큰이 맞지 않습니다' : errorText(body, `백엔드가 오류를 돌려줬습니다 (${response.status})`));
		} catch {
			setError(`백엔드(${agentUrl})에 연결할 수 없습니다. 백엔드 개발 서버가 켜져 있는지, 이 화면을 http://localhost:5173 으로 열었는지 확인하세요`);
		} finally {
			setChecking(false);
		}
	}

	return (
		<main className="flex min-h-dvh items-center justify-center bg-stone-50 px-4 py-10 text-stone-900">
			<form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
				<header className="space-y-1">
					<h1 className="text-xl font-semibold">PT 트레이너 비서</h1>
					<p className="text-sm text-stone-500">일정 조율과 식단 피드백 초안을 돕는 에이전트입니다.</p>
				</header>

				<label className="block space-y-1.5">
					<span className="text-sm font-medium">접근 토큰</span>
					<input
						type="password"
						autoComplete="off"
						value={token}
						onChange={(event) => setToken(event.target.value)}
						className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20"
						placeholder="backend/.dev.vars의 AGENT_TOKEN"
						autoFocus
					/>
					<span className="block text-xs text-stone-500">이 탭에만 저장되고, 탭을 닫으면 지워집니다.</span>
				</label>

				<label className="block space-y-1.5">
					<span className="text-sm font-medium">대화 이름</span>
					<input
						value={conversationId}
						onChange={(event) => setConversationId(event.target.value)}
						className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20"
						spellCheck={false}
					/>
					<span className="block text-xs text-stone-500">일정·회원 데이터는 대화마다 따로 저장됩니다. 새 이름이면 시연용 샘플 데이터로 시작합니다.</span>
				</label>

				{error && (
					<p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
						{error}
					</p>
				)}

				<button
					type="submit"
					disabled={checking}
					className="w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{checking ? '확인 중…' : '들어가기'}
				</button>
			</form>
		</main>
	);
}
