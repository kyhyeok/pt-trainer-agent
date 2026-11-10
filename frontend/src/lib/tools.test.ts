import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlueConversationPart } from '@flue/sdk';
import { toolLine } from './tools.ts';

type ToolPart = Extract<FlueConversationPart, { type: 'dynamic-tool' }>;
const done = (toolName: string, output: unknown, input: unknown = {}): ToolPart => ({ type: 'dynamic-tool', toolName, toolCallId: 't', state: 'output-available', input, output });

test('도구 줄은 한국어 이름과 짧은 결과를 보여 준다', () => {
	assert.deepEqual(toolLine(done('list_schedule', { count: 6 })), { label: '일정 조회', brief: '6건', tone: 'normal' });
	assert.deepEqual(toolLine(done('check_availability', { available: true })), { label: '가능 여부 확인', brief: '가능', tone: 'normal' });
	assert.deepEqual(toolLine(done('check_availability', { available: false })), { label: '가능 여부 확인', brief: '불가', tone: 'normal' });
	assert.deepEqual(toolLine(done('member_status', { name: '박서연' })), { label: '회원 현황 조회', brief: '박서연', tone: 'normal' });
	assert.deepEqual(toolLine(done('activate_skill', 'long', { name: 'diet-feedback' })), { label: '스킬 사용', brief: 'diet-feedback', tone: 'normal' });
	assert.deepEqual(toolLine(done('propose_pt_session', { status: 'rejected', reasons: ['x'] })), { label: 'PT 예약 제안', brief: '제안 불가', tone: 'normal' });
	assert.deepEqual(toolLine(done('propose_cancel', { status: 'needs_decision' })), { label: '취소 제안', brief: '차감 여부 확인 필요', tone: 'normal' });
	assert.deepEqual(toolLine(done('unknown_tool', {})), { label: 'unknown_tool', brief: '완료', tone: 'normal' });
	assert.deepEqual(toolLine({ type: 'dynamic-tool', toolName: 'list_schedule', toolCallId: 't', state: 'input-available', input: {} }), { label: '일정 조회', brief: '실행 중…', tone: 'normal' });
	assert.deepEqual(toolLine({ type: 'dynamic-tool', toolName: 'list_schedule', toolCallId: 't', state: 'output-error', input: {}, errorText: 'x' }), { label: '일정 조회', brief: '실패', tone: 'error' });
});

test('카드로 만들 수 없는 확정 대기 제안은 "완료"가 아니라 경고로 보여 준다(적대적 리뷰 재현)', () => {
	// approvalId 형식이 다르거나 요약이 비어 확정 카드를 만들지 못한 경우
	const line = toolLine(done('propose_cancel', { status: 'pending_approval', approvalId: 'functions.propose_cancel:0', summary: '취소' }));
	assert.equal(line.tone, 'warning');
	assert.match(line.brief, /확정 대기/);
	assert.doesNotMatch(line.brief, /완료/);
});

test('모델이 준 스킬 이름이 길면 한 줄에 맞게 자른다', () => {
	const line = toolLine(done('activate_skill', 'x', { name: 'a'.repeat(500) }));
	assert.ok(line.brief.length <= 41, String(line.brief.length));
});

test('스킬 이름은 글자(코드 포인트) 단위로 잘라 서러게이트 쌍을 가르지 않는다(적대적 리뷰 재현)', () => {
	const line = toolLine(done('activate_skill', 'x', { name: `${'a'.repeat(39)}😀😀` }));
	assert.ok(line.brief.isWellFormed(), JSON.stringify(line.brief));
	assert.equal(line.brief, `${'a'.repeat(39)}😀…`);
});
