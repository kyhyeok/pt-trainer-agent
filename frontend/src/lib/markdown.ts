// 에이전트 답변을 마크다운으로 그릴 때의 설정. 화면(Chat.tsx)과 테스트가 같은 설정을 쓴다.
// - 원시 HTML은 버린다(skipHtml). 링크의 javascript: 같은 주소는 react-markdown 기본 처리로 지워진다.
// - 이미지는 불러오지 않고 글자로만 보여 준다. 모델이 만든 이미지 주소를 자동으로 불러오면 대화 내용이 바깥으로 새어 나갈 수 있다.
// - 물결표 하나(~)는 취소선으로 보지 않는다. "200~250kcal", "16~19g" 같은 범위 표기가 취소선으로 바뀌기 때문이다(실측).
//   취소선은 물결표 두 개(~~글자~~)만 쓴다.
// - 한 줄 바꿈도 화면에서 줄바꿈으로 보여 준다(remark-breaks). 마크다운 기본값은 공백으로 합치는데,
//   모델이 식단 피드백 형식(한 줄에 한 칸)을 코드 블록 없이 쓰면 항목이 한 문단으로 뭉개졌다(실측).

import { createElement } from 'react';
import type { Options } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

export const markdownOptions: Readonly<Omit<Options, 'children'>> = {
	remarkPlugins: [[remarkGfm, { singleTilde: false }], remarkBreaks],
	skipHtml: true,
	components: {
		img: ({ alt }) => createElement('span', { className: 'text-stone-400' }, `[이미지${alt ? `: ${alt}` : ''}]`),
		// 바깥 링크만 새 창으로 연다. 각주 같은 문서 안 이동(#…)을 새 창으로 열면 접속 화면이 뜬다.
		// id·aria 속성은 그대로 넘긴다(각주 되돌아가기 ↩ 링크의 이동 대상이 각주 참조 링크의 id다)
		a: ({ node: _node, href, children, ...rest }) =>
			href?.startsWith('#')
				? createElement('a', { ...rest, href, className: 'text-emerald-700 underline' }, children)
				: createElement('a', { ...rest, href, target: '_blank', rel: 'noopener noreferrer nofollow', className: 'text-emerald-700 underline' }, children),
	},
};
