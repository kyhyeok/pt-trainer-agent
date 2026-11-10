// 확정 카드의 상태 계산(순수 함수).
// - 제안: 제안 도구(propose_*)의 결과 중 status가 'pending_approval'인 것.
// - 결정과 결과: 승인 라우트가 넣은 신호(system 메시지)의 attributes에서 읽는다.
//   { approvalId, decision }은 트레이너가 누른 결정, { approvalId, outcome }은 에이전트가 다시 판정한 결과다.
// 새로 고침해도 같은 화면이 나오도록 결정 여부는 화면 상태가 아니라 대화 기록(신호)으로 판단한다.

import type { FlueConversationMessage, FlueConversationPart } from '@flue/sdk';
import { SAFE_ID } from './conversation.ts';

export type Decision = 'approve' | 'deny';
export type Outcome = 'applied' | 'denied' | 'changed' | 'expired' | 'unknown';

const OUTCOMES: readonly string[] = ['applied', 'denied', 'changed', 'expired', 'unknown'];

export interface Proposal {
	approvalId: string;
	toolName: string;
	summary: string;
	warnings: string[];
}

/** 신호에서 모은 확정 요청 하나의 기록 */
export interface DecisionRecord {
	decision?: Decision;
	outcome?: Outcome;
	/** 결과 신호의 본문(반영하지 않은 이유, 대안 시간 등) */
	detail?: string;
}

/**
 * 이 화면에서 누른 결정의 전송 상태. 새로 고치면 사라지고, 그 뒤로는 신호가 기준이 된다.
 * conflict: 같은 제안에 다른 결정이 이미 접수됨(409). 어느 결정인지는 신호가 도착하면 보여 준다.
 */
export interface LocalDecision {
	status: 'sending' | 'sent' | 'conflict' | 'error';
	decision: Decision;
	message?: string;
}

export type CardState =
	| { kind: 'open'; error?: string }
	| { kind: 'sending'; decision: Decision }
	| { kind: 'waiting'; decision?: Decision; note?: string }
	| { kind: 'settled'; outcome: Outcome; decision?: Decision; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOutcome(value: unknown): value is Outcome {
	return typeof value === 'string' && OUTCOMES.includes(value);
}

/** 도구 결과가 확정 대기 제안이면 꺼낸다. 형식이 하나라도 다르면 null(버튼을 만들지 않는다) */
export function readProposal(part: FlueConversationPart): Proposal | null {
	if (part.type !== 'dynamic-tool' || part.state !== 'output-available') return null;
	if (!part.toolName.startsWith('propose_')) return null;
	const out = part.output;
	if (!isRecord(out) || out.status !== 'pending_approval') return null;
	if (typeof out.approvalId !== 'string' || !SAFE_ID.test(out.approvalId)) return null;
	if (typeof out.summary !== 'string' || out.summary.trim() === '') return null;
	const warnings = Array.isArray(out.warnings) ? out.warnings.filter((w): w is string => typeof w === 'string') : [];
	return { approvalId: out.approvalId, toolName: part.toolName, summary: out.summary, warnings };
}

function textOf(message: FlueConversationMessage): string {
	return message.parts
		.filter((p): p is Extract<FlueConversationPart, { type: 'text' }> => p.type === 'text')
		.map((p) => p.text)
		.join('\n')
		.trim();
}

/**
 * 대화의 신호 메시지에서 확정 요청별 결정과 결과를 모은다.
 * 같은 요청에 신호가 여러 번 있으면 처음 것을 쓴다. 서버는 한 요청을 한 번만 처리하고, 그 뒤의 신호는 '이미 처리됨'(unknown)이기 때문이다.
 */
export function collectDecisions(messages: readonly FlueConversationMessage[]): Map<string, DecisionRecord> {
	const records = new Map<string, DecisionRecord>();
	for (const message of messages) {
		// 신호는 system 메시지에만 붙는다. 사용자 메시지는 신호를 가질 수 없으므로 흉내 낼 수 없다
		if (message.role !== 'system') continue;
		const attributes = message.signal?.attributes;
		if (!isRecord(attributes)) continue;
		const approvalId = attributes.approvalId;
		if (typeof approvalId !== 'string' || !SAFE_ID.test(approvalId)) continue;

		const record = records.get(approvalId) ?? {};
		const decision = attributes.decision;
		if (record.decision === undefined && (decision === 'approve' || decision === 'deny')) record.decision = decision;
		if (record.outcome === undefined && isOutcome(attributes.outcome)) {
			record.outcome = attributes.outcome;
			record.detail = textOf(message) || undefined;
		}
		records.set(approvalId, record);
	}
	return records;
}

/** 카드에 보여 줄 상태. 대화 기록(신호)이 화면 상태보다 우선한다 */
export function cardState(record: DecisionRecord | undefined, local: LocalDecision | undefined): CardState {
	if (record?.outcome) return { kind: 'settled', outcome: record.outcome, decision: record.decision, detail: record.detail };
	if (record?.decision) return { kind: 'waiting', decision: record.decision };
	if (!local) return { kind: 'open' };
	if (local.status === 'sending') return { kind: 'sending', decision: local.decision };
	if (local.status === 'sent') return { kind: 'waiting', decision: local.decision, note: local.message };
	if (local.status === 'conflict') return { kind: 'waiting', note: local.message };
	return { kind: 'open', error: local.message };
}

/** 버튼을 눌러도 되는 상태인지. 같은 요청에 결정을 두 번 보내지 않게 한다 */
export function canDecide(state: CardState): boolean {
	return state.kind === 'open';
}
