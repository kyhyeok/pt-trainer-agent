// 답변 파트를 화면에 그릴 묶음으로 나눈다(순수 함수).
// SDK는 실시간으로 받을 때 글(text)과 추론(reasoning) 조각이 번갈아 오면 텍스트 파트를 여러 개로 나눈다.
// 이 모델(glm-5.3)은 답변 중간에 추론 조각을 끼워 보내기도 해서, 추론을 숨기면 "11" / "월 17일(화)…"처럼 글이 끊겨 보였다(실측).
// 서버의 완성본은 하나의 텍스트이므로, 화면에서도 도구 호출 사이의 텍스트를 이어 붙여 하나로 그린다.

import type { FlueConversationPart } from '@flue/sdk';

export type ToolPart = Extract<FlueConversationPart, { type: 'dynamic-tool' }>;

export type RenderGroup = { kind: 'text'; text: string; done: boolean } | { kind: 'tool'; part: ToolPart };

export function groupParts(parts: readonly FlueConversationPart[]): RenderGroup[] {
	const groups: RenderGroup[] = [];
	for (const part of parts) {
		if (part.type === 'dynamic-tool') {
			groups.push({ kind: 'tool', part });
			continue;
		}
		if (part.type !== 'text') continue; // 추론·파일·데이터 파트는 그리지 않는다
		const last = groups.at(-1);
		if (last?.kind === 'text') {
			last.text += part.text;
			last.done = last.done && part.state === 'done';
		} else {
			groups.push({ kind: 'text', text: part.text, done: part.state === 'done' });
		}
	}
	return groups;
}
