// 채팅 화면. Flue 대화 하나를 useFlueAgent로 따라가며 보여 준다.
// - 제안 도구 결과(pending_approval) → 확정 카드, 조회 도구 → 접힌 한 줄
// - 답변의 "회원에게 보낼 문장"만 복사하는 버튼
// - 입력창은 Composer.tsx(입력할 때 메시지 목록이 다시 그려지지 않도록 분리)
// 긴 대화에서도 느려지지 않도록 메시지·마크다운·초안 추출을 메모이제이션한다. 실시간 조각이 오면 그 메시지만 다시 그린다.

import { type DeliveredImageAttachment, type FlueConversationMessage, type FlueConversationPart, useFlueAgent } from '@flue/react';
import { FlueApiError, createFlueClient } from '@flue/sdk';
import { Component, type ReactNode, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ApprovalCard } from './ApprovalCard.tsx';
import { Composer, type ComposerHandle } from './Composer.tsx';
import { type Decision, type DecisionRecord, type LocalDecision, cardState, collectDecisions, readProposal } from './lib/approvals.ts';
import { approvalUrl, conversationUrl, errorText } from './lib/config.ts';
import { isAgentResource } from './lib/conversation.ts';
import { extractMemberDrafts } from './lib/drafts.ts';
import { markdownOptions } from './lib/markdown.ts';
import { type ToolPart, groupParts } from './lib/parts.ts';
import { previewValue, toolLine } from './lib/tools.ts';

interface Props {
	agentUrl: string;
	token: string;
	conversationId: string;
	onNewConversation: () => void;
	onDisconnect: () => void;
}

const SUGGESTIONS = [
	'이번 주 일정 보여줘',
	'민지 회원이 이번 주 수요일 저녁 7시 수업을 목요일 저녁 7시로 바꾸고 싶대',
	'서연 회원 남은 횟수랑 다음 예약 알려줘',
	'준호 회원 점심이야. 피드백 초안 써줘 (사진 첨부)',
];

const NEW_CONVERSATION_NOTICE = '새 대화는 시연용 샘플 일정으로 다시 시작합니다(지금 대화의 일정 변경은 이 대화에만 남습니다).';
const TOKEN_REJECTED = '토큰이 맞지 않습니다. [나가기] 후 다시 접속하세요';
/** 확정 요청을 기다리는 최대 시간. 넘으면 다시 누를 수 있게 한다(같은 결정은 서버가 한 번만 처리한다) */
const APPROVAL_TIMEOUT_MS = 20_000;

/** @flue/react가 실패한 응답(settlement)으로 오류 문구를 만드는 방식과 같다(settlementError) */
function settlementMessage(value: unknown): string {
	return value && typeof value === 'object' && 'message' in value ? String((value as { message: unknown }).message) : 'Agent submission failed';
}

function isUnauthorized(error: unknown): boolean {
	return error instanceof FlueApiError && error.status === 401;
}

/** 오류를 화면 문구로 바꾼다. 서버가 준 { error } 문구가 있으면 그것을 쓴다 */
function describeError(error: unknown): string {
	if (error instanceof FlueApiError) {
		if (error.status === 401) return TOKEN_REJECTED;
		return errorText(error.body, `요청이 실패했습니다 (${error.status})`);
	}
	if (error instanceof Error && error.message) return error.message.length > 200 ? `${error.message.slice(0, 200)}…` : error.message;
	return '알 수 없는 오류가 났습니다';
}

function isImageFile(part: FlueConversationPart): part is Extract<FlueConversationPart, { type: 'file' }> {
	return part.type === 'file' && part.mediaType.startsWith('image/');
}

/** 확정 요청을 보낸다. 응답이 없으면 APPROVAL_TIMEOUT_MS 뒤 포기한다 */
async function postDecision(url: string, token: string, approvalId: string, decision: Decision): Promise<LocalDecision> {
	const controller = new AbortController();
	const timer = window.setTimeout(() => controller.abort(), APPROVAL_TIMEOUT_MS);
	const timedOut = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout'))));
	try {
		const response = await Promise.race([
			fetch(url, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ approvalId, decision }),
				signal: controller.signal,
			}),
			timedOut,
		]);
		if (response.ok) return { status: 'sent', decision };
		if (response.status === 409) return { status: 'conflict', decision, message: '이미 다른 결정이 접수된 제안입니다' };
		const body = await response.json().catch(() => null);
		return { status: 'error', decision, message: response.status === 401 ? TOKEN_REJECTED : errorText(body, `요청이 실패했습니다 (${response.status})`) };
	} catch {
		const message = controller.signal.aborted ? '응답이 없어 기다리기를 멈췄습니다' : '네트워크 오류로 보내지 못했습니다';
		return { status: 'error', decision, message: `${message}. 다시 눌러 주세요(같은 결정은 한 번만 처리됩니다)` };
	} finally {
		window.clearTimeout(timer);
	}
}

export function Chat({ agentUrl, token, conversationId, onNewConversation, onDisconnect }: Props) {
	// 클라이언트를 새로 만들면 대화 관찰이 처음부터 다시 시작되므로 고정한다
	const client = useMemo(() => createFlueClient({ url: conversationUrl(agentUrl, conversationId), token }), [agentUrl, conversationId, token]);
	const agent = useFlueAgent({ client });
	const { sendMessage } = agent;

	// 신호에서 모은 결정·결과. 내용이 같으면 같은 객체를 써서, 실시간 조각마다 모든 메시지가 다시 그려지지 않게 한다
	const collected = collectDecisions(agent.messages);
	const decisionsKey = JSON.stringify([...collected]);
	const decisions = useMemo(() => new Map<string, DecisionRecord>(JSON.parse(decisionsKey) as [string, DecisionRecord][]), [decisionsKey]);
	const failedIds = useMemo(() => new Set(agent.failedSends.map((failed) => failed.id)), [agent.failedSends]);
	const [localDecisions, setLocalDecisions] = useState<Record<string, LocalDecision>>({});
	// 버튼 연타 방지: 상태 갱신보다 먼저 동기적으로 막는다
	const inflight = useRef(new Set<string>());

	const decide = useCallback(
		async (approvalId: string, decision: Decision) => {
			if (inflight.current.has(approvalId)) return;
			inflight.current.add(approvalId);
			setLocalDecisions((previous) => ({ ...previous, [approvalId]: { status: 'sending', decision } }));
			const next = await postDecision(approvalUrl(agentUrl, conversationId), token, approvalId, decision);
			inflight.current.delete(approvalId);
			setLocalDecisions((previous) => ({ ...previous, [approvalId]: next }));
		},
		[agentUrl, conversationId, token],
	);

	const renderTool = useCallback(
		(part: ToolPart) => {
			const proposal = readProposal(part);
			if (!proposal) return <ToolLine part={part} />;
			const state = cardState(decisions.get(proposal.approvalId), localDecisions[proposal.approvalId]);
			return <ApprovalCard proposal={proposal} state={state} onDecide={(decision) => void decide(proposal.approvalId, decision)} />;
		},
		[decisions, localDecisions, decide],
	);

	const startNewConversation = useCallback(() => {
		if (window.confirm(`새 대화를 시작할까요?\n${NEW_CONVERSATION_NOTICE}`)) onNewConversation();
	}, [onNewConversation]);

	const send = useCallback(
		async (text: string, images: DeliveredImageAttachment[], idempotencyKey: string) => {
			await sendMessage(text, images.length > 0 ? { images, idempotencyKey } : { idempotencyKey });
		},
		[sendMessage],
	);

	const composer = useRef<ComposerHandle>(null);
	const busy = agent.status === 'submitted' || agent.status === 'streaming';

	// ── 스크롤: 아래쪽을 보고 있을 때만 새 메시지를 따라간다 ──────
	const scroller = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);
	useEffect(() => {
		const element = scroller.current;
		if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
	}, [agent.messages, busy]);

	// ── 상태 표시 ───────────────────────────────────────
	const lastUser = agent.messages.findLast((message) => message.role === 'user');
	const photoPending =
		busy &&
		lastUser !== undefined &&
		lastUser.parts.some(isImageFile) &&
		!agent.settlements.some((settlement) => settlement.submissionId === lastUser.submissionId);
	const visibleCount = agent.messages.filter((message) => message.role !== 'system' && message.display !== 'hidden').length;
	// 보내기 실패는 입력창이, 응답 실패는 해당 메시지 자리의 안내가 알려 준다. 여기서는 대화 불러오기·연결 오류만 다룬다
	// agent.error가 보내기 실패나 응답 실패에서 온 것인지는 SDK가 만든 오류와 같은지로 가린다(마지막 settlement만 보면 확정 신호 처리 뒤에 틀린다)
	const sendFailed = agent.failedSends.some((failed) => failed.error === agent.error);
	const turnFailed =
		agent.error !== undefined && agent.settlements.some((settlement) => settlement.outcome === 'failed' && settlementMessage(settlement.error) === agent.error?.message);
	const connectionError =
		agent.error !== undefined && (agent.status === 'connecting' || isUnauthorized(agent.error) || (!sendFailed && !turnFailed)) ? agent.error : undefined;
	const loadFailed = connectionError !== undefined && (agent.status === 'error' || agent.status === 'connecting');

	return (
		<div className="flex h-dvh flex-col bg-stone-50 text-stone-900">
			<header className="border-b border-stone-200 bg-white">
				<div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
					<div className="min-w-0">
						<h1 className="text-base font-semibold">PT 트레이너 비서</h1>
						<p className="truncate font-mono text-xs text-stone-500">대화: {conversationId}</p>
					</div>
					<div className="flex shrink-0 gap-2 text-sm">
						<button type="button" onClick={startNewConversation} className="rounded-lg border border-stone-300 px-3 py-1.5 hover:bg-stone-50">
							새 대화
						</button>
						<button type="button" onClick={onDisconnect} className="rounded-lg px-3 py-1.5 text-stone-500 hover:bg-stone-100">
							나가기
						</button>
					</div>
				</div>
			</header>

			<div
				ref={scroller}
				onScroll={(event) => {
					const element = event.currentTarget;
					stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
				}}
				className="flex-1 overflow-y-auto"
			>
				<section aria-label="대화" aria-live="polite" className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
					{!agent.historyReady && !loadFailed && <p className="text-sm text-stone-500">대화를 불러오는 중…</p>}

					{agent.historyReady && visibleCount === 0 && (
						<div className="space-y-3 rounded-2xl border border-dashed border-stone-300 p-5">
							<p className="text-sm text-stone-600">
								회원 일정 확인·변경, 회차권 현황, 식단 사진 피드백 초안을 도와드려요. 일정 변경은 아래에 나오는 카드에서 <b>확정</b>을 눌러야 반영됩니다.
							</p>
							<div className="flex flex-wrap gap-2">
								{SUGGESTIONS.map((suggestion) => (
									<button
										key={suggestion}
										type="button"
										onClick={() => composer.current?.fill(suggestion.replace(' (사진 첨부)', ''))}
										className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-left text-sm text-stone-700 hover:border-emerald-600 hover:text-emerald-800"
									>
										{suggestion}
									</button>
								))}
							</div>
						</div>
					)}

					{agent.messages.map((message) => (
						<MessageBoundary key={message.id}>
						<MessageView
							message={message}
							failed={failedIds.has(message.id)}
							agentUrl={agentUrl}
							token={token}
							renderTool={renderTool}
							onNewConversation={startNewConversation}
						/>
						</MessageBoundary>
					))}

					{busy && (
						<div role="status" className="flex items-center gap-2 px-1 text-sm text-stone-500">
							<span aria-hidden="true" className="flex gap-1">
								<span className="size-1.5 animate-pulse rounded-full bg-stone-400" />
								<span className="size-1.5 animate-pulse rounded-full bg-stone-400 [animation-delay:150ms]" />
								<span className="size-1.5 animate-pulse rounded-full bg-stone-400 [animation-delay:300ms]" />
							</span>
							{photoPending ? '사진을 분석하는 중입니다. 1~2분 걸릴 수 있어요' : '답을 만드는 중…'}
						</div>
					)}

					<ConnectionNotice
						status={agent.status}
						error={connectionError}
						onRefresh={agent.refresh}
						onNewConversation={startNewConversation}
						onDisconnect={onDisconnect}
					/>
				</section>
			</div>

			<Composer ref={composer} ready={agent.historyReady} onSend={send} describeError={describeError} />
		</div>
	);
}

// ── 메시지 ──────────────────────────────────────────────

/**
 * 메시지 하나를 그리다 예외가 나도(예: 아주 깊게 중첩된 마크다운) 화면 전체가 하얘지지 않게, 그 메시지만 대신 안내를 보여 준다
 */
class MessageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	render() {
		if (this.state.failed) {
			return <p className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-500">이 메시지는 형식 문제로 표시할 수 없습니다.</p>;
		}
		return this.props.children;
	}
}

interface MessageViewProps {
	message: FlueConversationMessage;
	failed: boolean;
	agentUrl: string;
	token: string;
	renderTool: (part: ToolPart) => ReactNode;
	onNewConversation: () => void;
}

const MessageView = memo(function MessageView({ message, failed, agentUrl, token, renderTool, onNewConversation }: MessageViewProps) {
	if (message.display === 'hidden') return null;

	if (message.role === 'system') {
		// 신호·런타임 안내는 숨긴다. 응답이 실패·중단된 경우만 알린다
		if (!message.settlement) return null;
		return (
			<div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
				<p>{message.settlement.outcome === 'aborted' ? '응답이 중단됐습니다.' : '응답을 만들지 못했습니다.'} 다시 보내 보고, 계속 안 되면 새 대화로 시작하세요.</p>
				<button type="button" onClick={onNewConversation} className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1 text-red-800 hover:bg-red-100">
					새 대화로 시작
				</button>
			</div>
		);
	}

	if (message.role === 'user') {
		const text = message.parts
			.filter((part): part is Extract<FlueConversationPart, { type: 'text' }> => part.type === 'text')
			.map((part) => part.text)
			.join('\n');
		const photos = message.parts.filter(isImageFile);
		return (
			<article className="flex flex-col items-end gap-1">
				{photos.length > 0 && (
					<div className="flex flex-wrap justify-end gap-2">
						{photos.map((photo, index) => (
							<AuthedImage key={photo.id ?? index} url={photo.url} alt={photo.filename ?? '첨부 사진'} agentUrl={agentUrl} token={token} />
						))}
					</div>
				)}
				{/* 트레이너가 쓴 글(붙여 넣은 회원 메시지 포함)은 마크다운으로 해석하지 않고 글자 그대로 보여 준다 */}
				{text && (
					<p className="max-w-[85%] rounded-2xl rounded-br-md bg-emerald-700 px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-white [overflow-wrap:anywhere]">
						{text}
					</p>
				)}
				{failed && <span className="text-xs text-red-700">전송 실패</span>}
			</article>
		);
	}

	return <AssistantMessage parts={message.parts} renderTool={renderTool} />;
});

/**
 * 답변 메시지 하나. 회원에게 보낼 초안은 메시지 전체 글에서 한 번에 찾는다.
 * 글 묶음(도구 호출로 나뉨)마다 찾으면 앞 묶음의 "트레이너 확인 필요"(안전 규칙)를 뒤 묶음이 보지 못한다(적대적 리뷰 재현).
 */
const AssistantMessage = memo(function AssistantMessage({ parts, renderTool }: { parts: FlueConversationPart[]; renderTool: (part: ToolPart) => ReactNode }) {
	const groups = useMemo(() => groupParts(parts), [parts]);
	const texts = groups.flatMap((group) => (group.kind === 'text' ? [group.text] : []));
	const textsKey = texts.join('\u0000');
	const done = groups.every((group) => group.kind === 'tool' || group.done);
	// 스트리밍 중에는 초안을 찾지 않는다(글이 다 오기 전에 상자가 생겼다 사라지지 않게).
	// 글 묶음은 화면처럼 따로 파싱하도록 배열로 넘긴다. 초안을 못 찾는 오류가 나도 답변은 보여야 하므로 상자만 뺀다
	const drafts = useMemo(() => {
		if (!done) return [];
		try {
			return extractMemberDrafts(textsKey.split('\u0000'));
		} catch {
			return [];
		}
	}, [textsKey, done]);
	return (
		<article className="flex flex-col items-start gap-1">
			<div className="w-full max-w-[95%] text-[15px] leading-7 text-stone-800">
				{groups.map((group, index) =>
					group.kind === 'tool' ? <div key={group.part.toolCallId}>{renderTool(group.part)}</div> : <TextBlock key={index} text={group.text} />,
				)}
				{drafts.map((draft, index) => (
					<DraftBox key={index} draft={draft} />
				))}
			</div>
		</article>
	);
});

/** 답변 글 한 덩어리. 글이 같으면 다시 파싱하지 않는다 */
const TextBlock = memo(function TextBlock({ text }: { text: string }) {
	// 각주 id가 답변끼리 겹치면 다른 답변의 각주로 이동하므로, 글 묶음마다 접두어를 달리한다
	const prefix = `fn${useId().replace(/[^A-Za-z0-9]/g, '')}-`;
	return (
		<div className="markdown">
			<ReactMarkdown {...markdownOptions} remarkRehypeOptions={{ clobberPrefix: prefix }}>
				{text}
			</ReactMarkdown>
		</div>
	);
});

// ── 회원에게 보낼 문장 복사 ─────────────────────────────────

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// 클립보드 API를 못 쓰는 환경용 예전 방식
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.position = 'fixed';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand('copy');
		area.remove();
		return ok;
	}
}

/**
 * 초안 상자: 복사될 글을 그대로 보여 주고 [복사] 버튼을 둔다.
 * 복사 범위가 화면에 보여야 트레이너가 검토할 수 있다. 받는 사람(첫 호칭)을 함께 보여 다른 회원에게 잘못 보내지 않게 한다.
 */
function DraftBox({ draft }: { draft: string }) {
	const [copied, setCopied] = useState(false);
	const [failed, setFailed] = useState(false);
	const addressee = /^\s*([^\s,.!?]{1,12}님)/.exec(draft)?.[1];

	async function copy() {
		const ok = await copyText(draft);
		setFailed(!ok);
		if (!ok) return;
		setCopied(true);
		window.setTimeout(() => setCopied(false), 2000);
	}

	return (
		<section aria-label="회원에게 보낼 문장(초안)" className="my-3 rounded-xl border border-emerald-200 bg-white p-3 shadow-sm">
			<div className="flex items-center justify-between gap-3">
				<p className="text-xs font-semibold text-emerald-800">
					회원에게 보낼 문장(초안){addressee ? ` · ${addressee}` : ''}
				</p>
				<button
					type="button"
					aria-label={`회원에게 보낼 문장 복사${addressee ? ` (${addressee})` : ''}`}
					onClick={() => void copy()}
					className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
				>
					{copied ? '복사했습니다' : '복사'}
				</button>
			</div>
			<p className="mt-2 text-sm leading-6 whitespace-pre-wrap text-stone-800 [overflow-wrap:anywhere]">{draft}</p>
			<p className="mt-1.5 text-[11px] text-stone-500">[복사]를 누르면 위 글이 그대로 복사됩니다. 검토하고 고친 뒤 직접 보내세요.</p>
			{failed && <p className="mt-1 text-xs text-red-700">복사하지 못했습니다. 글을 직접 선택해 복사하세요</p>}
		</section>
	);
}

// ── 도구 호출 한 줄 ────────────────────────────────────────

const TONE_CLASS = { normal: 'text-stone-500', warning: 'text-amber-700', error: 'text-red-700' } as const;

function ToolLine({ part }: { part: ToolPart }) {
	const view = toolLine(part);
	return (
		<details className="group my-1 text-sm">
			<summary className={`cursor-pointer list-none text-[13px] select-none ${TONE_CLASS[view.tone]} hover:text-stone-700`}>
				<span className="mr-1 inline-block transition group-open:rotate-90" aria-hidden="true">
					›
				</span>
				{view.label} · {view.brief}
			</summary>
			<div className="mt-1 space-y-1 rounded-lg bg-stone-100 p-3 font-mono text-xs leading-5 text-stone-700">
				<pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">입력: {previewValue(part.input)}</pre>
				{part.state === 'output-available' && <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">결과: {previewValue(part.output)}</pre>}
				{part.state === 'output-error' && <pre className="whitespace-pre-wrap text-red-700 [overflow-wrap:anywhere]">오류: {part.errorText}</pre>}
			</div>
		</details>
	);
}

// ── 첨부 사진: 첨부 주소는 인증이 필요해 토큰을 붙여 받아 온다 ──────

function AuthedImage({ url, alt, agentUrl, token }: { url?: string; alt: string; agentUrl: string; token: string }) {
	// 보내는 중인 사진은 브라우저 안의 미리보기(data:)라 그대로 쓴다
	const isPreview = url?.startsWith('data:image/') ?? false;
	// 토큰은 백엔드 주소로만 보낸다
	const fetchable = url !== undefined && !isPreview && isAgentResource(url, agentUrl);
	// 받아 온 결과는 어느 주소의 것인지 함께 둔다. 주소가 바뀌면 이전 결과를 쓰지 않는다
	const [loaded, setLoaded] = useState<{ url: string; src: string | null } | null>(null);

	useEffect(() => {
		if (!fetchable || !url) return;
		let cancelled = false;
		let objectUrl: string | null = null;
		fetch(url, { headers: { Authorization: `Bearer ${token}` } })
			.then((response) => {
				if (!response.ok) throw new Error(String(response.status));
				return response.blob();
			})
			.then((blob) => {
				if (cancelled) return;
				if (!blob.type.startsWith('image/')) throw new Error('not image');
				objectUrl = URL.createObjectURL(blob);
				setLoaded({ url, src: objectUrl });
			})
			.catch(() => {
				if (!cancelled) setLoaded({ url, src: null });
			});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [fetchable, url, token]);

	const result = loaded && loaded.url === url ? loaded : null;
	const src = isPreview ? (url ?? null) : (result?.src ?? null);
	const failed = (url !== undefined && !isPreview && !fetchable) || (result !== null && result.src === null);

	if (!src) {
		return (
			<div className="flex size-28 items-center justify-center rounded-xl border border-stone-200 bg-stone-100 text-xs text-stone-500">
				{failed ? '사진을 불러오지 못함' : '사진'}
			</div>
		);
	}
	return <img src={src} alt={alt} className="max-h-48 max-w-[60vw] rounded-xl border border-stone-200 object-cover sm:max-w-xs" />;
}

// ── 연결·오류 안내 ─────────────────────────────────────────

interface NoticeProps {
	status: ReturnType<typeof useFlueAgent>['status'];
	error: Error | undefined;
	onRefresh: () => void;
	onNewConversation: () => void;
	onDisconnect: () => void;
}

function ConnectionNotice({ status, error, onRefresh, onNewConversation, onDisconnect }: NoticeProps) {
	if (!error) return null;
	// 토큰 문제는 새 대화로 풀리지 않으므로 다시 접속하도록 안내한다
	if (isUnauthorized(error)) {
		return (
			<div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
				<p>{TOKEN_REJECTED}</p>
				<button type="button" onClick={onDisconnect} className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1 hover:bg-red-100">
					나가기
				</button>
			</div>
		);
	}
	if (status === 'connecting') return <p className="text-sm text-amber-700">연결이 끊겨 다시 연결하는 중입니다…</p>;
	if (status !== 'error') return null;
	return (
		<div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
			<p className="[overflow-wrap:anywhere]">문제가 생겼습니다: {describeError(error)}</p>
			<p className="mt-1">다시 보내 보고, 계속 안 되면 새 대화로 시작하세요. {NEW_CONVERSATION_NOTICE}</p>
			<div className="mt-2 flex gap-2">
				<button type="button" onClick={onRefresh} className="rounded-lg border border-red-300 bg-white px-3 py-1 hover:bg-red-100">
					다시 불러오기
				</button>
				<button type="button" onClick={onNewConversation} className="rounded-lg border border-red-300 bg-white px-3 py-1 hover:bg-red-100">
					새 대화로 시작
				</button>
			</div>
		</div>
	);
}
