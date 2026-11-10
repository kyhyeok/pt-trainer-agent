// 트레이너 1명의 운영 설정과 한국 시간(KST) 처리.
// 과제용이라 트레이너는 1명으로 고정하고, 설정을 코드에 둔다.

import { DEFAULT_SESSION_MINUTES, type Now, type WorkingHours, weekdayLabel } from './schedule.ts';
import { DEFAULT_CANCEL_NOTICE_HOURS } from './packages.ts';

const WEEKDAY_SPLIT = [
	{ start: '07:00', end: '12:00' },
	{ start: '15:00', end: '22:00' },
];

/** 평일 오전·저녁 근무, 토요일 오전 근무, 일요일 휴무 */
const WORKING_HOURS: WorkingHours = {
	1: WEEKDAY_SPLIT,
	2: WEEKDAY_SPLIT,
	3: WEEKDAY_SPLIT,
	4: WEEKDAY_SPLIT,
	5: WEEKDAY_SPLIT,
	6: [{ start: '09:00', end: '14:00' }],
};

export const TRAINER_CONFIG = {
	workingHours: WORKING_HOURS,
	sessionMinutes: DEFAULT_SESSION_MINUTES,
	cancelNoticeHours: DEFAULT_CANCEL_NOTICE_HOURS,
	/** 개인 일정 길이 범위(분) */
	personalBlockMinutes: { min: 10, max: 480 },
} as const;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 현재 시각을 KST 날짜·시각 문자열로 돌려준다. 한국은 서머타임이 없어 고정 +9시간이다 */
export function nowInKst(epochMs: number = Date.now()): Now {
	const iso = new Date(epochMs + KST_OFFSET_MS).toISOString();
	return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** '2026-11-16' → '2026-11-16(월)' */
export function withWeekday(date: string): string {
	return `${date}(${weekdayLabel(date)})`;
}

export function describeWorkingHours(workingHours: WorkingHours): string {
	return [1, 2, 3, 4, 5, 6, 0]
		.map((day) => {
			const ranges = workingHours[day] ?? [];
			const label = ['일', '월', '화', '수', '목', '금', '토'][day];
			return `${label} ${ranges.length ? ranges.map((r) => `${r.start}-${r.end}`).join(', ') : '휴무'}`;
		})
		.join(' / ');
}
