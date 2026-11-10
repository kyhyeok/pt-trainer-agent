import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONVERSATION_ID, isAgentResource, isValidConversationId, newConversationId, normalizeAgentUrl } from './conversation.ts';

test('대화 id 규칙은 백엔드와 같다', () => {
	assert.ok(isValidConversationId(DEFAULT_CONVERSATION_ID));
	assert.ok(isValidConversationId('a_B-9'));
	assert.ok(!isValidConversationId(''));
	assert.ok(!isValidConversationId('a b'));
	assert.ok(!isValidConversationId('../x'));
	assert.ok(!isValidConversationId('한글'));
	assert.ok(!isValidConversationId('x'.repeat(129)));
	assert.ok(isValidConversationId('x'.repeat(128)));
});

test('새 대화 id는 한국 날짜와 무작위 글자로 만든다', () => {
	// UTC 15:30은 한국 시간으로 다음 날 00:30
	const id = newConversationId(new Date('2026-11-10T15:30:00Z'), () => 'ABCDEF12-3456');
	assert.equal(id, 'trainer-20261111-abcdef');
	assert.ok(isValidConversationId(id));
	assert.equal(newConversationId(new Date('2026-11-10T00:00:00Z'), () => '!!!'), 'trainer-20261110-000000');
	assert.ok(isValidConversationId(newConversationId()));
});

test('백엔드 주소는 http(s)만 받고 끝의 /를 뗀다', () => {
	assert.equal(normalizeAgentUrl('http://localhost:8787/'), 'http://localhost:8787');
	assert.equal(normalizeAgentUrl(' https://a.example.com/base// '), 'https://a.example.com/base');
	assert.equal(normalizeAgentUrl(undefined), null);
	assert.equal(normalizeAgentUrl(''), null);
	assert.equal(normalizeAgentUrl('javascript:alert(1)'), null);
	assert.equal(normalizeAgentUrl('ftp://x'), null);
	assert.equal(normalizeAgentUrl('http://user:pw@x.com'), null);
	assert.equal(normalizeAgentUrl('http://x.com/?q=1'), null);
	assert.equal(normalizeAgentUrl('not a url'), null);
});

test('토큰을 붙여도 되는 주소는 백엔드와 출처·경로가 같을 때만이다', () => {
	const agent = 'http://localhost:8787';
	assert.ok(isAgentResource('http://localhost:8787/agents/pt-trainer/x/attachments/att_1', agent));
	assert.ok(!isAgentResource('http://localhost:8788/agents/pt-trainer/x/attachments/att_1', agent));
	assert.ok(!isAgentResource('https://localhost:8787/a', agent));
	assert.ok(!isAgentResource('http://localhost:8787.evil.com/a', agent));
	assert.ok(!isAgentResource('http://localhost:8787@evil.com/a', agent));
	assert.ok(!isAgentResource('http://evil.com/http://localhost:8787/a', agent));
	assert.ok(!isAgentResource('data:image/png;base64,AAAA', agent));
	assert.ok(!isAgentResource('not a url', agent));
	const based = 'https://a.example.com/base';
	assert.ok(isAgentResource('https://a.example.com/base/agents/x', based));
	assert.ok(!isAgentResource('https://a.example.com/based/agents/x', based));
	assert.ok(!isAgentResource('https://a.example.com/other', based));
});
