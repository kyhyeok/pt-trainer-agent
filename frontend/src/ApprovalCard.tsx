// 확정 카드: 에이전트가 제안한 일정 변경을 요약·경고와 함께 보여 주고, 트레이너가 [확정]/[거절]을 누른다.
// 반영 여부는 에이전트가 확정 시점의 최신 상태로 다시 판정한 결과(outcome)로 보여 준다.

import { type CardState, type Decision, type Outcome, type Proposal, canDecide } from './lib/approvals.ts';

const KIND_LABEL: Record<string, string> = {
	propose_pt_session: 'PT 예약',
	propose_personal_block: '개인 일정',
	propose_reschedule: '일정 변경',
	propose_cancel: '취소',
	propose_attendance: '출석 기록',
};

const OUTCOME_VIEW: Record<Outcome, { label: string; tone: string }> = {
	applied: { label: '반영했습니다', tone: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
	denied: { label: '거절했습니다. 반영하지 않았습니다', tone: 'border-stone-200 bg-stone-50 text-stone-600' },
	changed: { label: '확정했지만 반영하지 않았습니다. 그사이 상황이 바뀌었습니다', tone: 'border-amber-200 bg-amber-50 text-amber-900' },
	expired: { label: '만료된 제안이라 반영하지 않았습니다', tone: 'border-stone-200 bg-stone-50 text-stone-600' },
	unknown: { label: '이미 처리됐거나 없는 제안입니다. 아무것도 바꾸지 않았습니다', tone: 'border-stone-200 bg-stone-50 text-stone-600' },
};

const DECISION_LABEL: Record<Decision, string> = { approve: '확정', deny: '거절' };

interface Props {
	proposal: Proposal;
	state: CardState;
	onDecide: (decision: Decision) => void;
}

export function ApprovalCard({ proposal, state, onDecide }: Props) {
	const enabled = canDecide(state);
	const kind = KIND_LABEL[proposal.toolName] ?? '일정 변경';
	const settled = state.kind === 'settled';

	return (
		<section
			aria-label={`확정 요청: ${kind}`}
			className={`my-3 overflow-hidden rounded-xl border bg-white shadow-sm ${settled ? 'border-stone-200' : 'border-emerald-300'}`}
		>
			<header className="flex items-center justify-between gap-3 border-b border-stone-100 px-4 py-2.5">
				<span className="text-xs font-semibold text-emerald-800">{kind} 제안 · 트레이너 확정 필요</span>
				{state.kind === 'open' && <span className="text-[11px] text-stone-400">확정 전에는 반영되지 않습니다</span>}
			</header>

			<div className="space-y-3 px-4 py-3">
				<p className="text-[15px] leading-6 font-medium text-stone-900 [overflow-wrap:anywhere]">{proposal.summary}</p>

				{proposal.warnings.length > 0 && (
					<ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 [overflow-wrap:anywhere]">
						{proposal.warnings.map((warning, index) => (
							<li key={index} className="flex gap-2">
								<span aria-hidden="true">⚠</span>
								<span>{warning}</span>
							</li>
						))}
					</ul>
				)}

				<div aria-live="polite">
					{state.kind === 'settled' && (
						<div className={`rounded-lg border px-3 py-2 text-sm [overflow-wrap:anywhere] ${OUTCOME_VIEW[state.outcome].tone}`}>
							<p className="font-medium">
								{state.decision ? `${DECISION_LABEL[state.decision]} → ` : ''}
								{OUTCOME_VIEW[state.outcome].label}
							</p>
							{/* 반영하지 않은 이유와 대안 시간은 에이전트의 결과 신호 본문에 있다 */}
							{state.outcome === 'changed' && state.detail && <p className="mt-1 whitespace-pre-wrap text-[13px] leading-5">{state.detail}</p>}
						</div>
					)}
					{state.kind === 'waiting' && (
						<p className="flex items-center gap-2 text-sm text-stone-500">
							<span className="size-2 animate-pulse rounded-full bg-emerald-600" aria-hidden="true" />
							{state.decision ? `${DECISION_LABEL[state.decision]} 요청을 보냈습니다. 반영 결과를 기다리는 중…` : '결정을 접수했습니다. 결과를 기다리는 중…'}
							{state.note && <span className="text-stone-400">({state.note})</span>}
						</p>
					)}
					{state.kind === 'sending' && <p className="text-sm text-stone-500">{DECISION_LABEL[state.decision]} 요청을 보내는 중…</p>}
					{state.kind === 'open' && state.error && (
						<p role="alert" className="text-sm text-red-700">
							{state.error}
						</p>
					)}
				</div>

				{(state.kind === 'open' || state.kind === 'sending') && (
					<div className="flex gap-2">
						<button
							type="button"
							disabled={!enabled}
							onClick={() => onDecide('approve')}
							className="flex-1 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
						>
							확정
						</button>
						<button
							type="button"
							disabled={!enabled}
							onClick={() => onDecide('deny')}
							className="flex-1 rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
						>
							거절
						</button>
					</div>
				)}
			</div>
		</section>
	);
}
