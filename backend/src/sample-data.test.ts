// 샘플 데이터가 어느 요일에 시작해도 판정 규칙을 어기지 않는지 확인한다. 실행: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRAINER_CONFIG } from './config.ts';
import { checkBookable, pendingBookedCount, remainingSessions } from './packages.ts';
import { buildSampleAppointments, buildSampleMembers } from './sample-data.ts';
import { addDays, checkAvailability, toMinutes } from './schedule.ts';

// 2026-11-15(일)부터 7일: 시작 요일 7가지를 모두 본다
const startDays = Array.from({ length: 7 }, (_, i) => addDays('2026-11-15', i));

for (const today of startDays) {
	test(`${today} 시작: 샘플 일정은 겹치지 않고 회차권을 넘지 않으며 근무 시간 안이다`, () => {
		const members = buildSampleMembers(today);
		const appointments = buildSampleAppointments(today);

		assert.equal(new Set(appointments.map((a) => a.id)).size, appointments.length, 'id 중복 없음');
		assert.equal(new Set(members.map((m) => m.id)).size, members.length, '회원 id 중복 없음');

		for (const m of members) {
			assert.ok(pendingBookedCount(appointments, m.id) <= remainingSessions(m.package), `${m.name} 예약 수 ≤ 잔여`);
			assert.ok(appointments.filter((a) => a.memberId === m.id).every((a) => a.date <= m.package.expiresOn), `${m.name} 만료일 안`);
		}
		// 김민지는 1회 더 예약할 수 있고, 이준호는 다 찼다 (시연 시나리오)
		assert.equal(checkBookable(members[0], appointments, today).bookable, 1);
		assert.equal(checkBookable(members[1], appointments, today).bookable, 0);

		for (const a of appointments) {
			const others = appointments.filter((b) => b.id !== a.id && b.date === a.date);
			assert.ok(
				others.every((b) => toMinutes(a.end) <= toMinutes(b.start) || toMinutes(b.end) <= toMinutes(a.start)),
				`${a.date} ${a.start} 겹침 없음`,
			);
			if (a.kind === 'pt' && a.date >= today) {
				const check = checkAvailability(
					{ appointments, workingHours: TRAINER_CONFIG.workingHours },
					{ date: a.date, start: a.start, durationMinutes: TRAINER_CONFIG.sessionMinutes, ignoreId: a.id },
				);
				assert.equal(check.available, true, `${a.date} ${a.start} ${a.title} 근무 시간 안`);
			}
		}
	});
}
