// 도구 호출을 접힌 한 줄로 보여 줄 때의 이름과 짧은 결과(순수 함수).
// 확정 카드로 그리지 못한 제안(status: pending_approval)은 처리되지 않은 채 남으므로 "완료"가 아니라 경고로 보여 준다.

import type { ToolPart } from './parts.ts';

const TOOL_LABEL: Record<string, string> = {
	list_schedule: '일정 조회',
	check_availability: '가능 여부 확인',
	member_status: '회원 현황 조회',
	activate_skill: '스킬 사용',
	propose_pt_session: 'PT 예약 제안',
	propose_personal_block: '개인 일정 제안',
	propose_reschedule: '일정 변경 제안',
	propose_cancel: '취소 제안',
	propose_attendance: '출석 기록 제안',
	task: '하위 작업',
};

export interface ToolLineView {
	label: string;
	brief: string;
	tone: 'normal' | 'warning' | 'error';
}

function field(value: unknown, key: string): unknown {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

export function toolLine(part: ToolPart): ToolLineView {
	const label = TOOL_LABEL[part.toolName] ?? part.toolName;
	const view = (brief: string, tone: ToolLineView['tone'] = 'normal'): ToolLineView => ({ label, brief, tone });
	if (part.state === 'input-available') return view('실행 중…');
	if (part.state === 'output-error') return view('실패', 'error');

	const { output, input } = part;
	const status = field(output, 'status');
	if (status === 'pending_approval') return view('확정 대기 — 이 화면에서 처리할 수 없는 형식이라 반영되지 않았습니다', 'warning');
	if (status === 'rejected') return view('제안 불가');
	if (status === 'needs_decision') return view('차감 여부 확인 필요');
	if (part.toolName === 'check_availability') return view(field(output, 'available') === true ? '가능' : '불가');
	const count = field(output, 'count');
	if (part.toolName === 'list_schedule' && typeof count === 'number') return view(`${count}건`);
	const name = field(output, 'name');
	if (part.toolName === 'member_status' && typeof name === 'string') return view(name);
	const skill = field(input, 'name');
	if (part.toolName === 'activate_skill' && typeof skill === 'string') {
		// 글자(코드 포인트) 단위로 자른다. UTF-16 단위로 자르면 이모지 같은 서러게이트 쌍이 갈라진다
		const chars = Array.from(skill);
		return view(chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : skill);
	}
	return view('완료');
}

/** 펼쳤을 때 보여 줄 입력·결과(길면 자른다) */
export function previewValue(value: unknown): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	if (text === undefined) return '';
	return text.length > 3000 ? `${text.slice(0, 3000)}\n…(생략)` : text;
}
