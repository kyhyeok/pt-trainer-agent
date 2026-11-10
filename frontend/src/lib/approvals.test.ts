import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlueConversationMessage, FlueConversationPart } from '@flue/sdk';
import { canDecide, cardState, collectDecisions, readProposal } from './approvals.ts';

function tool(toolName: string, output: unknown, state: 'output-available' | 'input-available' = 'output-available'): FlueConversationPart {
	if (state === 'input-available') return { type: 'dynamic-tool', toolName, toolCallId: 't1', state, input: {} };
	return { type: 'dynamic-tool', toolName, toolCallId: 't1', state, input: {}, output };
}

function signal(attributes: Record<string, string>, text = '', role: FlueConversationMessage['role'] = 'system'): FlueConversationMessage {
	return {
		id: `m-${Math.random()}`,
		role,
		purpose: 'dispatch',
		display: 'diagnostic',
		signal: { attributes },
		parts: text ? [{ type: 'text', text, state: 'done' }] : [],
	};
}

const pending = {
	status: 'pending_approval',
	approvalId: 'chatcmpl-tool-a1f1b38d378dcb67',
	summary: '김민지 일정 변경: 2026-11-11(수) 19:00 → 2026-11-12(목) 19:00-19:50',
	warnings: ['수업 23.3시간 전 변경입니다'],
};

test('확정 대기 제안만 카드로 꺼낸다', () => {
	assert.deepEqual(readProposal(tool('propose_reschedule', pending)), {
		approvalId: pending.approvalId,
		toolName: 'propose_reschedule',
		summary: pending.summary,
		warnings: pending.warnings,
	});
	// 제안 도구가 아니면 결과 모양이 같아도 카드를 만들지 않는다
	assert.equal(readProposal(tool('list_schedule', pending)), null);
	assert.equal(readProposal(tool('propose_reschedule', { ...pending, status: 'rejected' })), null);
	assert.equal(readProposal(tool('propose_cancel', { status: 'needs_decision', message: '...' })), null);
	assert.equal(readProposal(tool('propose_reschedule', pending, 'input-available')), null);
	assert.equal(readProposal({ type: 'text', text: 'pending_approval', state: 'done' }), null);
});

test('형식이 이상한 제안은 버튼을 만들지 않는다', () => {
	assert.equal(readProposal(tool('propose_pt_session', null)), null);
	assert.equal(readProposal(tool('propose_pt_session', 'pending_approval')), null);
	assert.equal(readProposal(tool('propose_pt_session', [pending])), null);
	assert.equal(readProposal(tool('propose_pt_session', { ...pending, approvalId: '../x' })), null);
	assert.equal(readProposal(tool('propose_pt_session', { ...pending, approvalId: 42 })), null);
	assert.equal(readProposal(tool('propose_pt_session', { ...pending, summary: '' })), null);
	assert.equal(readProposal(tool('propose_pt_session', { ...pending, summary: undefined })), null);
	// 경고 중 글자가 아닌 값은 버리고, 경고가 없으면 빈 배열
	assert.deepEqual(readProposal(tool('propose_pt_session', { ...pending, warnings: ['a', 1, null, 'b'] }))?.warnings, ['a', 'b']);
	assert.deepEqual(readProposal(tool('propose_pt_session', { ...pending, warnings: undefined }))?.warnings, []);
});

test('신호에서 결정과 결과를 모은다', () => {
	const id = pending.approvalId;
	const records = collectDecisions([
		signal({ approvalId: id, decision: 'approve' }, '트레이너가 확정을 눌렀습니다'),
		signal({ approvalId: id, outcome: 'changed' }, '확정했지만 반영하지 않았습니다. 기존 일정과 겹칩니다'),
		signal({ approvalId: 'other', decision: 'deny' }),
	]);
	assert.deepEqual(records.get(id), { decision: 'approve', outcome: 'changed', detail: '확정했지만 반영하지 않았습니다. 기존 일정과 겹칩니다' });
	assert.deepEqual(records.get('other'), { decision: 'deny' });
});

test('같은 요청의 신호가 여러 번이면 처음 결정과 처음 결과를 쓴다', () => {
	const records = collectDecisions([
		signal({ approvalId: 'a', decision: 'approve' }),
		signal({ approvalId: 'a', outcome: 'applied' }, '반영했습니다'),
		signal({ approvalId: 'a', decision: 'deny' }),
		signal({ approvalId: 'a', outcome: 'unknown' }, '이미 처리됐습니다'),
	]);
	assert.deepEqual(records.get('a'), { decision: 'approve', outcome: 'applied', detail: '반영했습니다' });
});

test('시스템 메시지가 아니거나 형식이 이상한 신호는 무시한다', () => {
	const records = collectDecisions([
		signal({ approvalId: 'a', outcome: 'applied' }, '', 'user'),
		signal({ approvalId: 'a', outcome: 'applied' }, '', 'assistant'),
		signal({ approvalId: '../x', outcome: 'applied' }),
		signal({ approvalId: '', outcome: 'applied' }),
		signal({ approvalId: 'b', outcome: 'hacked', decision: 'maybe' }),
		{ id: 'n', role: 'system', purpose: 'advisory', display: 'diagnostic', parts: [] },
	]);
	assert.equal(records.get('a'), undefined);
	assert.equal(records.get('../x'), undefined);
	assert.deepEqual(records.get('b'), {});
});

test('카드 상태는 대화 기록(신호)이 화면 상태보다 우선한다', () => {
	assert.deepEqual(cardState(undefined, undefined), { kind: 'open' });
	assert.deepEqual(cardState(undefined, { status: 'sending', decision: 'approve' }), { kind: 'sending', decision: 'approve' });
	assert.deepEqual(cardState(undefined, { status: 'sent', decision: 'deny', message: '이미 다른 결정이 접수됐습니다' }), {
		kind: 'waiting',
		decision: 'deny',
		note: '이미 다른 결정이 접수됐습니다',
	});
	assert.deepEqual(cardState(undefined, { status: 'error', decision: 'approve', message: '네트워크 오류' }), { kind: 'open', error: '네트워크 오류' });
	// 409: 다른 결정이 먼저 접수됐으므로 내가 누른 결정을 보여 주지 않는다
	assert.deepEqual(cardState(undefined, { status: 'conflict', decision: 'approve', message: '이미 다른 결정이 접수됐습니다' }), {
		kind: 'waiting',
		note: '이미 다른 결정이 접수됐습니다',
	});
	// 다른 화면(다른 탭)에서 결정한 경우: 신호만 있어도 대기로 바뀐다
	assert.deepEqual(cardState({ decision: 'approve' }, undefined), { kind: 'waiting', decision: 'approve' });
	assert.deepEqual(cardState({ decision: 'approve' }, { status: 'error', decision: 'approve' }), { kind: 'waiting', decision: 'approve' });
	assert.deepEqual(cardState({ decision: 'deny', outcome: 'denied' }, { status: 'sending', decision: 'deny' }), {
		kind: 'settled',
		outcome: 'denied',
		decision: 'deny',
		detail: undefined,
	});
});

test('결정 버튼은 열린 상태에서만 누를 수 있다', () => {
	assert.ok(canDecide({ kind: 'open' }));
	assert.ok(canDecide({ kind: 'open', error: '실패' }));
	assert.ok(!canDecide({ kind: 'sending', decision: 'approve' }));
	assert.ok(!canDecide({ kind: 'waiting' }));
	assert.ok(!canDecide({ kind: 'settled', outcome: 'applied' }));
});
