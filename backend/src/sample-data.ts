// 시연용 가상 데이터. 실제 인물이 아니다.
// 대화를 처음 시작한 날을 기준으로 2주 치 일정을 만들어, 언제 실행해도 '다가오는 일정'이 보이게 한다.

import type { Member } from './packages.ts';
import { type Appointment, addDays, weekdayOf } from './schedule.ts';

export function buildSampleMembers(today: string): Member[] {
	return [
		{
			id: 'm-minji',
			name: '김민지',
			goal: '체중 감량 (3개월 -5kg), 저녁 수업 선호',
			notes: '직장인, 야근으로 일정 변경이 잦음',
			package: { total: 10, used: 4, expiresOn: addDays(today, 45) },
		},
		{
			id: 'm-junho',
			name: '이준호',
			goal: '근비대 (벤치프레스 80kg)',
			notes: '유당불내증 — 우유·유청 단백질 주의',
			package: { total: 20, used: 18, expiresOn: addDays(today, 20) },
		},
		{
			id: 'm-seoyeon',
			name: '박서연',
			goal: '체형 교정과 식습관 개선',
			notes: '오른쪽 무릎 통증 이력, 식단 기록 초보',
			package: { total: 10, used: 1, expiresOn: addDays(today, 80) },
		},
	];
}

/**
 * 오늘부터 2주 동안의 샘플 일정.
 * - 김민지: 월·수 19:00 4회 + 어제 19:00 수업 1건(아직 출석 미기록, 출석 기록 시연용) → 잔여 6회 중 5회 예약, 1회 더 예약 가능
 * - 이준호: 화·목 07:00 처음 2회 (잔여 2회를 모두 예약 → 추가 예약이 막히는 것을 시연)
 * - 박서연: 토 10:00
 * - 개인 일정: 첫 목요일 15:00-16:00 치과
 */
export function buildSampleAppointments(today: string): Appointment[] {
	const appointments: Appointment[] = [];
	let seq = 0;
	const add = (a: Omit<Appointment, 'id' | 'status'>) => appointments.push({ id: `sample-${++seq}`, status: 'booked', ...a });

	add({ kind: 'pt', memberId: 'm-minji', title: '김민지', date: addDays(today, -1), start: '19:00', end: '19:50' });

	let minji = 0;
	let junho = 0;
	let dentist = false;
	for (let offset = 0; offset < 14; offset++) {
		const date = addDays(today, offset);
		const day = weekdayOf(date);
		if ((day === 1 || day === 3) && minji < 4) {
			add({ kind: 'pt', memberId: 'm-minji', title: '김민지', date, start: '19:00', end: '19:50' });
			minji++;
		}
		if ((day === 2 || day === 4) && junho < 2) {
			add({ kind: 'pt', memberId: 'm-junho', title: '이준호', date, start: '07:00', end: '07:50' });
			junho++;
		}
		if (day === 6) {
			add({ kind: 'pt', memberId: 'm-seoyeon', title: '박서연', date, start: '10:00', end: '10:50' });
		}
		if (day === 4 && !dentist) {
			add({ kind: 'personal', title: '치과 예약', date, start: '15:00', end: '16:00' });
			dentist = true;
		}
	}
	return appointments;
}
