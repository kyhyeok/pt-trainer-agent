// 에이전트 답변(메시지 하나 전체)에서 "회원에게 보낼 문장(초안)"만 꺼낸다(순수 함수). 화면의 초안 상자와 [복사] 버튼이 쓴다.
//
// 에이전트와의 약속(backend의 trainer.ts 규칙 7, diet-feedback/SKILL.md 출력 형식):
//   "── 회원에게 보낼 문장(초안) ──" 한 줄을 쓰고, 바로 다음 줄부터 초안만 빈 줄 없이 한 문단으로 쓴다. 초안이 없으면 이 줄을 쓰지 않는다.
//
// 잘못 복사하는 것이 버튼이 안 나오는 것보다 위험하므로, 애매하면 꺼내지 않는다.
// - 답변을 화면과 같은 마크다운 파서로 파싱해, 문서 맨 바깥(최상위)의 문단·제목·식단 코드 블록에 있는 표시 줄만 인정한다.
//   인용문·목록·HTML 블록·주석 안, 문단 중간 줄은 무시한다(회원 메시지를 옮겨 적었거나 화면에 안 보이는 글).
//   줄 단위로 찾던 방식은 이런 구조를 보지 못해 적대적 리뷰에서 여러 번 뚫렸다.
// - 초안은 표시 줄 다음 문단 하나만이다. 제목·목록·빈 줄이 나오면 끝난다(뒤에 붙는 트레이너용 메모를 섞지 않는다).
// - "트레이너 확인 필요"(안전 규칙) 줄이 있으면, 값이 정확히 '없음'일 때만 초안을 꺼낸다. 메시지 전체에서 본다.
// - 초안 안의 메타 줄("초안", "미작성", 괄호로만 된 메모)은 뺀다.
// - 복사되는 글은 화면과 같은 파서로 만들고(숨은 HTML 제외, 엔티티·강조 처리), 화면의 초안 상자에 그대로 보여 준다.

import type { Code, Nodes, PhrasingContent, Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/** 장식을 뗀 표시 줄. 예: "── 회원에게 보낼 문장(초안) ──", "### 회원에게 보낼 문장(초안)", "회원에게 보낼 문장(초안):" */
const DRAFT_MARK = /^회원에게\s*보낼\s*문장\s*[(（]\s*초안\s*[)）]\s*[:：]?$/;
/** 식단 피드백 스킬의 출력 첫 줄 */
const DIET_HEADER = /^\s*\[\s*식단\s*피드백\s*초안/;
/**
 * 안전 규칙 표시. 사이에 낱말이 끼거나("트레이너님 확인이 꼭 필요", "트레이너 직접 확인 필요", "트레이너 확인: 필요")
 * 다른 말("상담·검토", "요망")을 써도 잡는다. 넓게 잡아 틀리면 초안 상자가 안 나올 뿐이다(안전한 쪽)
 */
const REVIEW = /트레이너.{0,15}?(?:확인|상담|검토).{0,10}?(?:필요|요망)/;
/** "트레이너 확인 필요" 뒤 값으로 통과시키는 것은 이것뿐이다 */
const NO_ISSUE = /^(?:없음|없습니다|없어요|해당 ?없음)[.。]?$/;
/** 초안이 없다는 뜻의 값 */
const EMPTY_VALUE = /^[(（]?\s*(없음|없습니다|해당\s*없음|작성하지\s*않음|생략)\s*[)）]?\s*[.。]?$|^[-—–]$/;
/** 회원에게 보내는 글에는 나오지 않는 메타 표현. 이런 줄은 초안에서 뺀다 */
const META_LINE = /초안|미작성|회원에게\s*보낼|(?:쓰지|작성하지|만들지)\s*않았습니다|쓰지\s*않음/;
/** 괄호로만 된 줄은 메모다. 예: "(검토 후 보내 주세요)" */
const PARENTHESIZED = /^\s*[(（][\s\S]*[)）]\s*$/;
/** 인용 표시(여러 겹 포함) */
const QUOTE_PREFIX = /^(?:\s{0,3}>\s?)+/;
/** 화면에 안 보이는 제어 문자(폭 없는 공백, 글 방향 바꾸기 등). 검토할 수 없으므로 복사하지 않는다 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
/** 이어지는 줄을 원래 문단 안에서처럼 읽기 위해 앞에 두는 자리표시 글자(사용자 정의 영역) */
const PLACEHOLDER = '\uE000';
/** 한 메시지에서 꺼내는 초안 수 상한. 모델이 폭주해 초안·정의가 아주 많아도 화면이 멈추지 않게 한다 */
const MAX_DRAFTS = 10;

/** 화면(lib/markdown.ts)과 같은 파서 설정: GFM, 물결표 하나는 취소선 아님 */
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false });

function parse(markdown: string): Root {
	return parser.parse(markdown);
}

/** 마크다운 강조·장식을 떼고 공백을 하나로 접은 글자 */
function plain(line: string): string {
	let text = line
		.replace(/\s+/g, ' ')
		.replace(/^ ?#{1,6} /, '')
		.replace(/\*\*|__/g, '')
		.replace(/[─━═—–]+/g, '')
		.replace(/^ ?[-=]{2,}/, '');
	// 끝의 -·= 장식은 반복문으로 뗀다. 정규식(/[-=]{2,}\s*$/)은 긴 줄에서 입력 길이의 제곱만큼 느려진다(실측: 4만 자에 약 2초)
	let end = text.length;
	while (end > 0 && text[end - 1] === ' ') end--;
	let start = end;
	while (start > 0 && (text[start - 1] === '-' || text[start - 1] === '=')) start--;
	if (end - start >= 2) text = text.slice(0, start);
	return text.trim();
}

function isMark(line: string): boolean {
	return DRAFT_MARK.test(plain(line));
}

/** 안전 규칙에 걸린 답변인지: "트레이너 확인 필요" 뒤 값이 정확히 '없음'이 아니면 걸린 것으로 본다 */
function needsTrainerReview(lines: string[]): boolean {
	for (let i = 0; i < lines.length; i++) {
		let text = plain(lines[i]);
		let match = REVIEW.exec(text);
		let next = i + 1;
		if (!match && text.includes('트레이너') && i + 1 < lines.length) {
			// 줄바꿈으로 갈린 표시: "**트레이너" / "확인 필요**: 약 복용"
			const joined = `${text} ${plain(lines[i + 1])}`;
			const wrapped = REVIEW.exec(joined);
			if (wrapped && wrapped.index < text.length) {
				text = joined;
				match = wrapped;
				next = i + 2;
			}
		}
		if (!match) continue;
		let value = text.slice(match.index + match[0].length).replace(/^[\s:：—–-]+/, '');
		if (!value) {
			// 값이 다음 줄에 있는 형식: "**트레이너 확인 필요**" 다음 줄 "- 이유". 다음 줄이 없어도 걸린 것으로 본다
			let j = next;
			while (j < lines.length && lines[j].trim() === '') j++;
			value = j < lines.length ? plain(lines[j]).replace(/^(?:[-*+]|\d+[.)]) /, '') : '';
		}
		if (!NO_ISSUE.test(value)) return true;
	}
	return false;
}

// ── 마크다운 → 화면에 보이는 글 ─────────────────────────────────

interface Definitions {
	links: Map<string, string>;
	markdown: string;
}

/** 답변 전체의 링크·각주 정의. 초안만 따로 파싱해도 화면처럼 참조가 풀리도록 초안 뒤에 붙인다 */
function collectDefinitions(tree: Root): Definitions {
	const links = new Map<string, string>();
	const linkLines: string[] = [];
	const footnoteLines: string[] = [];
	const visit = (node: Nodes) => {
		if (node.type === 'definition') {
			links.set(node.identifier, node.url);
			linkLines.push(`[${node.label ?? node.identifier}]: <${node.url.replace(/[<>\s]/g, encodeURIComponent)}>`);
		} else if (node.type === 'footnoteDefinition') {
			footnoteLines.push(`[^${node.label ?? node.identifier}]: .`);
		}
		if ('children' in node) for (const child of node.children) visit(child as Nodes);
	};
	visit(tree);
	// 정의끼리 빈 줄로 띄운다. 붙여 쓰면 링크 정의가 앞 각주 정의의 내용으로 들어가 풀리지 않는다(교차검증 재현)
	return { links, markdown: [...linkLines, ...footnoteLines].join('\n\n') };
}

function inlineText(nodes: PhrasingContent[], links: Map<string, string>): string {
	return nodes
		.map((node): string => {
			switch (node.type) {
				case 'text':
					return node.value.replace(/\n/g, ' '); // 문단 안 줄바꿈은 화면에서 공백
				case 'emphasis':
				case 'strong':
					return inlineText(node.children, links);
				case 'delete':
					return `~~${inlineText(node.children, links)}~~`; // 화면의 취소선(지운 글)이라는 뜻을 남긴다
				case 'inlineCode':
					return node.value;
				case 'break':
					return '\n';
				case 'link':
				case 'linkReference': {
					// 링크 주소는 화면에 안 보이지만 회원에게 그대로 가므로 드러낸다
					const label = inlineText(node.children, links);
					const url = node.type === 'link' ? node.url : links.get(node.identifier);
					// 자동 링크(메일 주소·www)는 글과 주소가 사실상 같으므로 글만 쓴다
					const same = !url || url === label || url === `mailto:${label}` || url === `http://${label}`;
					return same ? label || url || '' : `${label} (${url})`;
				}
				case 'image':
				case 'imageReference':
					return node.alt ? `[이미지: ${node.alt}]` : '[이미지]';
				default:
					return ''; // html(화면에 안 그림), footnoteReference 등
			}
		})
		.join('');
}

function blockText(node: RootContent, links: Map<string, string>): string {
	switch (node.type) {
		case 'paragraph':
		case 'heading':
			return inlineText(node.children, links);
		case 'blockquote':
			return blocksText(node.children, links);
		case 'list':
			return node.children
				.map((item, index) => `${node.ordered ? `${(node.start ?? 1) + index}.` : '-'} ${blocksText(item.children, links).replace(/\n{2,}/g, ' ')}`)
				.join('\n');
		case 'code':
			return node.value;
		case 'table':
			return node.children.map((row) => row.children.map((cell) => inlineText(cell.children, links)).join(' | ')).join('\n');
		default:
			return ''; // html, definition, footnoteDefinition, thematicBreak
	}
}

function blocksText(nodes: RootContent[], links: Map<string, string>): string {
	let result = '';
	for (const node of nodes) {
		const text = blockText(node, links).trim();
		if (!text) continue;
		result += result ? (node.type === 'list' ? '\n' : '\n\n') + text : text;
	}
	return result;
}

/** 공백을 정리하고 전체를 감싼 따옴표를 뗀다 */
function tidy(text: string): string {
	let result = text
		.replace(INVISIBLE, '')
		.split('\n')
		.map((line) => line.replace(/[ \t ]+/g, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	const quoted = /^["“”'‘](.*)["“”'’]$/s.exec(result);
	if (quoted) result = quoted[1].trim();
	return result;
}

/** 초안 원문 줄에서 메타 줄(초안·미작성 언급, 괄호로만 된 메모)을 뺀다 */
function dropMetaLines(lines: string[]): string[] {
	return lines.filter((line) => {
		const content = line.replace(QUOTE_PREFIX, '');
		return !META_LINE.test(content) && !PARENTHESIZED.test(content);
	});
}

/**
 * 마크다운 원문 조각을 화면에 보이는 글로.
 * continuation: 표시 줄과 같은 문단의 이어지는 줄이다. 따로 파싱하면 들여쓴 줄이 코드 블록이 되고 "<span>"으로 시작하는 줄이 HTML 블록이 되어
 * 화면(한 문단)과 달라진다. 그래서 자리표시 첫 줄 뒤에 붙여 원래처럼 문단의 이어지는 줄로 읽힌 뒤 자리표시를 지운다
 */
function renderSource(lines: string[], definitions: Definitions, continuation = false): string {
	const kept = dropMetaLines(lines);
	if (kept.every((line) => line.replace(QUOTE_PREFIX, '').trim() === '')) return '';
	const source = continuation ? `${PLACEHOLDER}\n${kept.join('\n')}` : kept.join('\n');
	const doc = parse(`${source}\n\n${definitions.markdown}`);
	return tidy(blocksText(doc.children, definitions.links).replaceAll(PLACEHOLDER, ''));
}

/** 코드 블록 안 초안: 화면에 글자 그대로 보이므로 그대로 쓰되, 모델이 강제로 바꾼 줄은 공백으로 잇는다 */
function renderRaw(lines: string[]): string {
	return tidy(
		dropMetaLines(lines)
			.map((line) => line.trim())
			.filter(Boolean)
			.join(' '),
	);
}

function sourceOf(markdown: string, node: RootContent): string {
	const start = node.position?.start.offset;
	const end = node.position?.end.offset;
	return start === undefined || end === undefined ? '' : markdown.slice(start, end);
}

/** 펜스(```·~~~)로 쓴 코드 블록인지(4칸 들여쓰기 코드 제외) */
function isFenced(markdown: string, node: Code): boolean {
	return /^\s{0,3}(```|~~~)/.test(sourceOf(markdown, node));
}

/** 표시 줄 다음에 올 수 있는 초안 블록인지(최상위 문단·인용문·식단 형식이 아닌 펜스 코드). 아니면 소비하지 않는다 */
function isDraftBlock(markdown: string, node: RootContent | undefined): node is RootContent {
	if (!node) return false;
	if (node.type === 'paragraph' || node.type === 'blockquote') return true;
	return node.type === 'code' && isFenced(markdown, node) && !DIET_HEADER.test(node.value.split('\n')[0] ?? '');
}

/** 표시 줄 다음에 오는 초안 블록을 글로 */
function renderFollowing(markdown: string, node: RootContent, definitions: Definitions): string {
	if (node.type === 'paragraph' || node.type === 'blockquote') return renderSource(sourceOf(markdown, node).split('\n'), definitions);
	if (node.type !== 'code') return '';
	// 복사하기 좋게 초안만 코드 블록에 넣은 경우. 그 안에 다시 표시 줄이 있으면(옮겨 적은 글일 수 있음) 받지 않는다
	const lines = node.value.split('\n');
	return lines.some(isMark) ? '' : renderRaw(lines.slice(0, firstBlank(lines)));
}

function firstBlank(lines: string[]): number {
	const index = lines.findIndex((line) => line.trim() === '');
	return index < 0 ? lines.length : index;
}

// ── 초안 찾기 ───────────────────────────────────────────────

/**
 * 답변 메시지 하나에서 회원에게 보낼 문장 초안을 모두 꺼낸다. 없으면 빈 배열.
 * blocks: 메시지의 글 묶음들(도구 호출로 나뉨). 화면이 묶음마다 따로 그리므로 파싱도 묶음마다 따로 한다.
 * 이어 붙여 파싱하면 앞 묶음의 닫히지 않은 코드 펜스가 뒤 묶음의 구조를 바꾼다(적대적 리뷰 재현). 안전 규칙 검사만 메시지 전체에서 한다.
 */
export function extractMemberDrafts(blocks: string | readonly string[]): string[] {
	const texts = (typeof blocks === 'string' ? [blocks] : blocks).map((text) => text.replace(/\r\n?/g, '\n'));
	if (needsTrainerReview(texts.join('\n\n').split('\n'))) return [];
	const drafts: string[] = [];
	for (const markdown of texts) {
		if (drafts.length >= MAX_DRAFTS) break;
		draftsInBlock(markdown, drafts);
	}
	return drafts;
}

function draftsInBlock(markdown: string, drafts: string[]): void {
	const tree = parse(markdown);
	let definitions: Definitions | undefined;
	const nodes = tree.children;

	for (let index = 0; index < nodes.length && drafts.length < MAX_DRAFTS; index++) {
		const node = nodes[index];
		let text = '';

		if (node.type === 'paragraph') {
			// 문단의 첫 줄이 표시 줄이어야 한다(문단 중간 줄은 옮겨 적은 글일 수 있다)
			const lines = sourceOf(markdown, node).split('\n');
			if (!isMark(lines[0])) continue;
			const rest = lines.slice(1);
			if (rest.some(isMark)) continue; // 한 문단에 표시 줄이 또 있으면 형식이 깨진 것이다
			definitions ??= collectDefinitions(tree);
			if (rest.some((line) => line.trim())) text = renderSource(rest, definitions, true);
			else if (isDraftBlock(markdown, nodes[index + 1])) text = renderFollowing(markdown, nodes[++index], definitions);
		} else if (node.type === 'heading') {
			if (!isMark(sourceOf(markdown, node)) || !isDraftBlock(markdown, nodes[index + 1])) continue;
			definitions ??= collectDefinitions(tree);
			text = renderFollowing(markdown, nodes[++index], definitions);
		} else if (node.type === 'code' && isFenced(markdown, node)) {
			// 식단 피드백 형식: 첫 줄이 "[식단 피드백 초안" 머리말이고 "트레이너 확인 필요" 칸이 있는 코드 블록 안의 표시 줄.
			// 머리말만 있는 코드 블록은 회원이 심은 글을 옮겨 적은 것일 수 있다(적대적 리뷰 A13)
			const lines = node.value.split('\n');
			if (!DIET_HEADER.test(lines[0] ?? '') || !lines.some((line) => REVIEW.test(plain(line)))) continue;
			const at = lines.findIndex(isMark);
			if (at < 0) continue;
			let from = at + 1;
			while (from < lines.length && lines[from].trim() === '') from++;
			const body = lines.slice(from);
			text = renderRaw(body.slice(0, firstBlank(body)));
		} else {
			continue; // 인용문·목록·HTML·표 등 안의 표시 줄은 인정하지 않는다
		}

		// 글자·숫자가 하나도 없으면(예: ">"만 남음) 초안이 아니다
		if (text && !EMPTY_VALUE.test(text) && /[\p{L}\p{N}]/u.test(text)) drafts.push(text);
	}
}
