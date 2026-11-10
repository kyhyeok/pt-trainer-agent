import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlueConversationPart } from '@flue/sdk';
import { groupParts } from './parts.ts';

const text = (t: string, state: 'streaming' | 'done' = 'done'): FlueConversationPart => ({ type: 'text', text: t, state });
const reasoning = (t: string): FlueConversationPart => ({ type: 'reasoning', text: t, state: 'done' });
const tool = (id: string): FlueConversationPart => ({ type: 'dynamic-tool', toolName: 'list_schedule', toolCallId: id, state: 'input-available', input: {} });

test('추론 조각에 끊긴 텍스트는 하나로 합친다(실측: "11" / "월 17일(화)…"로 나뉘어 보임)', () => {
	const groups = groupParts([reasoning('a'), text('11'), reasoning('b'), text('월 17일(화) 20:00으로 제안하겠습니다.')]);
	assert.deepEqual(groups, [{ kind: 'text', text: '11월 17일(화) 20:00으로 제안하겠습니다.', done: true }]);
});

test('도구 호출은 텍스트를 나눈다', () => {
	const groups = groupParts([text('확인해 볼게요.'), tool('t1'), text('가능합니다.')]);
	assert.equal(groups.length, 3);
	assert.deepEqual(groups[0], { kind: 'text', text: '확인해 볼게요.', done: true });
	assert.equal(groups[1].kind, 'tool');
	assert.deepEqual(groups[2], { kind: 'text', text: '가능합니다.', done: true });
});

test('하나라도 스트리밍 중이면 묶음 전체가 진행 중이다', () => {
	assert.deepEqual(groupParts([text('앞', 'done'), reasoning('x'), text('뒤', 'streaming')]), [{ kind: 'text', text: '앞뒤', done: false }]);
});

test('파일·데이터 파트는 그리지 않고 텍스트도 나누지 않는다', () => {
	const file: FlueConversationPart = { type: 'file', mediaType: 'image/jpeg' };
	const data: FlueConversationPart = { type: 'data-progress', data: {} };
	assert.deepEqual(groupParts([text('가'), file, data, text('나')]), [{ kind: 'text', text: '가나', done: true }]);
	assert.deepEqual(groupParts([reasoning('only')]), []);
	assert.deepEqual(groupParts([]), []);
});
