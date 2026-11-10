import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { markdownOptions } from './markdown.ts';

function render(text: string): string {
	return renderToStaticMarkup(createElement(ReactMarkdown, markdownOptions, text));
}

test('범위 표기(~)는 취소선이 되지 않는다', () => {
	const html = render('아침: 약 200~250kcal / 단백질 16~19g');
	assert.ok(!html.includes('<del>'), html);
	assert.ok(html.includes('200~250kcal / 단백질 16~19g'), html);
	// 물결표 두 개는 여전히 취소선
	assert.ok(render('~~취소~~').includes('<del>취소</del>'));
});

test('원시 HTML은 그리지 않는다', () => {
	for (const text of ['<img src=x onerror="alert(1)">', '<script>alert(1)</script>', '앞 <b onclick="x()">굵게</b> 뒤', '<iframe src="https://evil.example"></iframe>']) {
		const html = render(text);
		assert.ok(!/<(img|script|iframe|b)\b/i.test(html), html);
		assert.ok(!/onerror|onclick/i.test(html), html);
	}
});

test('javascript: 링크는 지워지고, 보통 링크는 새 창·noopener로 연다', () => {
	assert.ok(!render('[누르기](javascript:alert(1))').includes('javascript:'));
	const html = render('[문서](https://example.com/a)');
	assert.ok(html.includes('href="https://example.com/a"'), html);
	assert.ok(html.includes('rel="noopener noreferrer nofollow"'), html);
});

test('마크다운 이미지는 불러오지 않고 글자로 보여 준다', () => {
	const html = render('![식단](https://evil.example/t.png?d=secret)');
	assert.ok(!html.includes('<img'), html);
	assert.ok(!html.includes('evil.example'), html);
	assert.ok(html.includes('[이미지: 식단]'), html);
});

test('표(GFM)는 그린다', () => {
	assert.ok(render('| 끼니 | 열량 |\n|---|---|\n| 점심 | 600~800kcal |').includes('<table>'));
});

test('문서 안 이동 링크(각주 #…)는 새 창으로 열지 않는다(적대적 리뷰 재현)', () => {
	const html = render('본문[^1]\n\n[^1]: 각주');
	assert.match(html, /href="#user-content-fn-1"/);
	for (const anchor of html.match(/<a [^>]*href="#[^"]*"[^>]*>/g) ?? []) assert.ok(!anchor.includes('target='), anchor);
});

test('각주 참조 링크의 id를 남겨 되돌아가기(↩)가 동작하도록 한다(적대적 리뷰 재현)', () => {
	const html = render('본문[^1]\n\n[^1]: 각주');
	assert.match(html, /<a [^>]*id="user-content-fnref-1"/);
	assert.match(html, /href="#user-content-fnref-1"/);
});

test('한 줄 바꿈도 화면에서 줄바꿈으로 보인다(실측: 코드 블록 없이 쓴 식단 피드백이 한 문단으로 뭉개짐)', () => {
	const html = render('[식단 피드백 초안 · 트레이너 검토 후 전송]\n회원: 이준호 / 끼니: 점심 (사진)\n확인 필요: 소스 종류\n잘한 점:\n- 단백질 충분\n바꿔 보면 좋은 점:\n- 채소 추가');
	assert.match(html, /\[식단 피드백 초안 · 트레이너 검토 후 전송\]<br\/?>\s*회원: 이준호/);
	assert.match(html, /확인 필요: 소스 종류<br\/?>\s*잘한 점:/);
	assert.match(html, /단백질 충분<br\/?>\s*바꿔 보면 좋은 점:/);
	// 코드 블록 안 줄바꿈은 그대로 글자로 둔다
	assert.ok(!render('```\n가\n나\n```').includes('<br'));
});
