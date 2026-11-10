// 회차권·출석·취소 규칙 테스트. 실행: npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	type Member,
	type SessionState,
	bookSession,
	cancellationPolicy,
	cancelSession,
	checkBookable,
	pendingBookedCount,
	recordAttendance,
	remainingSessions,
	rescheduleSession,
} from './packages.ts';
import type { Appointment, WorkingHours } from './schedule.ts';

// 평일 07:00-12:00, 15:00-22:00 / 토 09:00-14:00 / 일 휴무
const workingHours: WorkingHours = {
	1: [{ start: '07:00', end: '12:00' }, { start: '15:00', end: '22:00' }],
	2: [{ start: '07:00', end: '12:00' }, { start: '15:00', end: '22:00' }],
	3: [{ start: '07:00', end: '12:00' }, { start: '15:00', end: '22:00' }],
	4: [{ start: '07:00', end: '12:00' }, { start: '15:00', end: '22:00' }],
	5: [{ start: '07:00', end: '12:00' }, { start: '15:00', end: '22:00' }],
	6: [{ start: '09:00', end: '14:00' }],
};

function member(overrides: Partial<Member['package']> = {}): Member {
	return {
		id: 'm1',
		name: '김민지',
		goal: '체중 감량',
		notes: '',
		package: { total: 10, used: 8, expiresOn: '2026-12-31', ...overrides },
	};
}

function pt(id: string, date: string, start: string, end: string): Appointment {
	return { id, kind: 'pt', memberId: 'm1', title: '김민지', date, start, end, status: 'booked' };
}

describe('회차권', () => {
	test('잔여 횟수는 총 횟수에서 사용 횟수를 뺀 값이다', () => {
		assert.equal(remainingSessions(member().package), 2);
		assert.equal(remainingSessions(member({ used: 10 }).package), 0);
	});

	test('잔여 2회, 예약 1건이면 1건 더 잡을 수 있다', () => {
		const result = checkBookable(member(), [pt('a1', '2026-11-16', '19:00', '19:50')], '2026-11-17');
		assert.equal(result.ok, true);
		assert.equal(result.bookable, 1);
	});

	test('잔여 횟수만큼 이미 예약했으면 더 잡을 수 없다', () => {
		const booked = [pt('a1', '2026-11-16', '19:00', '19:50'), pt('a2', '2026-11-18', '19:00', '19:50')];
		const result = checkBookable(member(), booked, '2026-11-20');
		assert.equal(result.ok, false);
		assert.match(result.reasons.join(), /이미 모두 예약/);
	});

	test('일정을 옮길 때는 옮길 예약을 빼고 센다', () => {
		const booked = [pt('a1', '2026-11-16', '19:00', '19:50'), pt('a2', '2026-11-18', '19:00', '19:50')];
		assert.equal(checkBookable(member(), booked, '2026-11-20', 'a2').ok, true);
	});

	test('잔여 횟수가 0이면 예약할 수 없다', () => {
		const result = checkBookable(member({ used: 10 }), [], '2026-11-17');
		assert.equal(result.ok, false);
		assert.match(result.reasons.join(), /잔여 횟수가 없습니다/);
	});

	test('만료일 이후 날짜는 예약할 수 없고, 만료일 당일은 된다', () => {
		assert.equal(checkBookable(member(), [], '2026-12-31').ok, true);
		const result = checkBookable(member(), [], '2027-01-01');
		assert.equal(result.ok, false);
		assert.match(result.reasons.join(), /만료일/);
	});
});

describe('취소 규칙', () => {
	const appointment = pt('a1', '2026-11-16', '19:00', '19:50');

	test('24시간 이상 남았으면 늦은 취소가 아니다 (정확히 24시간 포함)', () => {
		assert.equal(cancellationPolicy(appointment, { date: '2026-11-15', time: '18:00' }).lateCancel, false);
		assert.equal(cancellationPolicy(appointment, { date: '2026-11-15', time: '19:00' }).lateCancel, false);
	});

	test('24시간 미만이면 늦은 취소다', () => {
		const policy = cancellationPolicy(appointment, { date: '2026-11-15', time: '20:00' });
		assert.equal(policy.lateCancel, true);
		assert.equal(policy.hoursBefore, 23);
	});

	const state = (): SessionState => ({ appointments: [appointment], members: [member()] });

	test('기한 전 취소는 일정을 지우고 차감하지 않는다', () => {
		const result = cancelSession(state(), 'a1', { date: '2026-11-14', time: '10:00' }, { chargeSession: true });
		assert.equal(result.outcome, 'removed');
		assert.equal(result.charged, false);
		assert.equal(result.appointments.length, 0);
		assert.equal(result.members[0].package.used, 8);
	});

	test('늦은 취소에 차감을 선택하면 당일 취소로 남기고 1회 차감한다', () => {
		const result = cancelSession(state(), 'a1', { date: '2026-11-16', time: '12:00' }, { chargeSession: true });
		assert.equal(result.outcome, 'late_cancel');
		assert.equal(result.appointments[0].status, 'late_cancel');
		assert.equal(result.members[0].package.used, 9);
	});

	test('늦은 취소라도 차감하지 않기로 하면 기록만 남긴다', () => {
		const result = cancelSession(state(), 'a1', { date: '2026-11-16', time: '12:00' }, { chargeSession: false });
		assert.equal(result.appointments[0].status, 'late_cancel');
		assert.equal(result.members[0].package.used, 8);
	});

	test('개인 일정 취소는 언제든 지우기만 한다', () => {
		const personal: Appointment = { id: 'p1', kind: 'personal', title: '치과', date: '2026-11-16', start: '15:00', end: '16:00', status: 'booked' };
		const result = cancelSession(
			{ appointments: [personal], members: [member()] },
			'p1',
			{ date: '2026-11-16', time: '14:00' },
			{ chargeSession: true },
		);
		assert.equal(result.outcome, 'removed');
		assert.equal(result.members[0].package.used, 8);
	});
});

describe('리뷰에서 나온 경우', () => {
	const appointment = pt('a1', '2026-11-16', '19:00', '19:50');

	test('남은 시간은 내림으로 표시해 24시간 미만인데 24로 보이지 않는다', () => {
		const policy = cancellationPolicy(appointment, { date: '2026-11-15', time: '19:02' });
		assert.equal(policy.lateCancel, true);
		assert.equal(policy.hoursBefore, 23.9);
	});

	test('이미 시작한 PT는 취소할 수 없고 출석 기록을 안내한다', () => {
		assert.throws(
			() => cancelSession({ appointments: [appointment], members: [member()] }, 'a1', { date: '2026-11-17', time: '10:00' }, { chargeSession: true }),
			/이미 시작한 수업.*propose_attendance/,
		);
	});

	test('잔여 0회 회원의 늦은 취소에 차감을 고르면, 차감 없이 기록하는 방법을 알려 준다', () => {
		assert.throws(
			() => cancelSession({ appointments: [appointment], members: [member({ used: 10 })] }, 'a1', { date: '2026-11-16', time: '12:00' }, { chargeSession: true }),
			/chargeSession: false/,
		);
	});

	test('예약 중인 수는 이 회원의 예약 상태 PT만 센다', () => {
		const mixed: Appointment[] = [
			pt('b1', '2026-11-16', '07:00', '07:50'),
			{ ...pt('b2', '2026-11-17', '07:00', '07:50'), status: 'late_cancel' },
			{ ...pt('b3', '2026-11-18', '07:00', '07:50'), status: 'attended' },
			{ ...pt('b4', '2026-11-19', '07:00', '07:50'), memberId: 'm2' },
			{ id: 'b5', kind: 'personal', title: '치과', date: '2026-11-20', start: '07:00', end: '07:50', status: 'booked' },
		];
		assert.equal(pendingBookedCount(mixed, 'm1'), 1);
	});

	test('만료일 형식이 잘못된 회차권은 예외로 알린다', () => {
		assert.throws(() => checkBookable(member({ expiresOn: '2026/12/31' }), [], '2026-11-17'), /날짜 형식/);
	});

	test('취소와 출석 기록은 입력 상태를 바꾸지 않는다', () => {
		const input: SessionState = { appointments: [appointment], members: [member()] };
		const snapshot = structuredClone(input);
		cancelSession(input, 'a1', { date: '2026-11-16', time: '12:00' }, { chargeSession: true });
		recordAttendance(input, 'a1', 'attended', { date: '2026-11-16', time: '20:00' });
		assert.deepEqual(input, snapshot);
	});
});

describe('bookSession / rescheduleSession (회차권 + 일정 함께 판정)', () => {
	const now = { date: '2026-11-10', time: '14:00' };
	const ctx = { workingHours, now };
	const base = (): SessionState => ({ appointments: [pt('a1', '2026-11-16', '19:00', '19:50')], members: [member()] });

	test('회차권과 일정이 모두 되면 회원 이름으로 예약한다', () => {
		const result = bookSession(base(), { id: 'n1', kind: 'pt', memberId: 'm1', date: '2026-11-17', start: '08:00', durationMinutes: 50 }, ctx);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.appointment.title, '김민지');
		assert.equal(result.appointments.length, 2);
	});

	test('잔여 횟수가 모자라면 시간이 비어 있어도 예약하지 않는다', () => {
		const state = base();
		state.appointments.push(pt('a2', '2026-11-18', '19:00', '19:50'));
		const result = bookSession(state, { id: 'n1', kind: 'pt', memberId: 'm1', date: '2026-11-17', start: '08:00', durationMinutes: 50 }, ctx);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.reasons.join(), /이미 모두 예약/);
	});

	test('대안 시간에서 회차권 만료일 이후는 뺀다', () => {
		const state: SessionState = { appointments: [], members: [member({ used: 0, expiresOn: '2026-11-16' })] };
		// 일요일(11-15) 요청 → 대안은 월요일(11-16)까지만, 화요일(11-17)은 만료일 이후라 빠진다
		const result = bookSession(
			state,
			{ id: 'n1', kind: 'pt', memberId: 'm1', date: '2026-11-15', start: '10:00', durationMinutes: 50 },
			{ ...ctx, maxAlternatives: 30 },
		);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.alternatives.length > 0);
		assert.ok(result.alternatives.every((s) => s.date <= '2026-11-16'));
	});

	test('없는 회원으로 PT를 잡으면 예외로 알린다', () => {
		assert.throws(
			() => bookSession(base(), { id: 'n1', kind: 'pt', memberId: 'ghost', date: '2026-11-17', start: '08:00', durationMinutes: 50 }, ctx),
			/회원을 찾을 수 없습니다/,
		);
	});

	test('개인 일정은 회차권과 상관없이 잡는다', () => {
		const state: SessionState = { appointments: [], members: [member({ used: 10 })] };
		const result = bookSession(state, { id: 'p1', kind: 'personal', title: '치과', date: '2026-11-17', start: '13:00', durationMinutes: 60 }, ctx);
		assert.equal(result.ok, true);
	});

	test('이동은 만료일을 넘길 수 없고, 잔여를 다 쓴 상태여도 자기 예약은 옮길 수 있다', () => {
		const state: SessionState = {
			appointments: [pt('a1', '2026-11-16', '19:00', '19:50'), pt('a2', '2026-11-18', '19:00', '19:50')],
			members: [member()],
		};
		assert.equal(rescheduleSession(state, { id: 'a2', date: '2026-11-19', start: '19:00' }, ctx).ok, true);
		const expired = rescheduleSession(state, { id: 'a2', date: '2027-01-04', start: '19:00' }, ctx);
		assert.equal(expired.ok, false);
		if (expired.ok) return;
		assert.match(expired.reasons.join(), /만료일/);
	});
});

describe('교차검증·적대적 리뷰에서 나온 경우', () => {
	const appointment = pt('a1', '2026-11-16', '19:00', '19:50');
	const state = (): SessionState => ({ appointments: [appointment], members: [member()] });
	const ctx = { workingHours, now: { date: '2026-11-16', time: '12:00' } };

	test('출석 상태값은 attended 또는 no_show만 받는다 (같은 수업 반복 차감 방지)', () => {
		const afterClass = { date: '2026-11-16', time: '20:00' };
		assert.throws(() => recordAttendance(state(), 'a1', 'booked' as never, afterClass), /attended 또는 no_show/);
		assert.throws(() => recordAttendance(state(), 'a1', 'present' as never, afterClass), /attended 또는 no_show/);
	});

	test('chargeSession은 true/false만 받는다', () => {
		const now = { date: '2026-11-16', time: '12:00' };
		assert.throws(() => cancelSession(state(), 'a1', now, { chargeSession: 'false' as never }), /chargeSession/);
		assert.throws(() => cancelSession(state(), 'a1', now, { chargeSession: undefined as never }), /chargeSession/);
	});

	test('취소 기준 시간은 양의 유한수만 받는다', () => {
		const now = { date: '2026-11-16', time: '12:00' };
		for (const noticeHours of [0, -1, Number.NaN, null as never]) {
			assert.throws(() => cancellationPolicy(appointment, now, noticeHours), /기준 시간/);
		}
	});

	test('회차권 숫자가 잘못되면 예외로 알린다 (NaN으로 무제한 예약되는 것 방지)', () => {
		const broken: Member['package'][] = [
			{ used: 8, expiresOn: '2026-12-31' } as never,
			{ total: 10, used: '8' as never, expiresOn: '2026-12-31' },
			{ total: 10.5, used: 8, expiresOn: '2026-12-31' },
			{ total: 10, used: -1, expiresOn: '2026-12-31' },
			{ total: 10, used: 11, expiresOn: '2026-12-31' },
		];
		for (const pkg of broken) {
			assert.throws(() => checkBookable({ ...member(), package: pkg }, [], '2026-11-17'), /회차권/);
		}
	});

	test('늦은 취소는 차감하지 않더라도 회차권 데이터가 깨져 있으면 예외로 알린다', () => {
		const broken: SessionState = { appointments: [appointment], members: [{ ...member(), package: { total: 10, used: 11, expiresOn: '2026-12-31' } }] };
		assert.throws(() => cancelSession(broken, 'a1', { date: '2026-11-16', time: '12:00' }, { chargeSession: false }), /회차권 숫자/);
	});

	test('이미 모두 예약한 경우 다음에 할 일을 알려 준다', () => {
		const booked = [appointment, pt('a2', '2026-11-18', '19:00', '19:50')];
		const result = checkBookable(member(), booked, '2026-11-20');
		assert.match(result.reasons.join(), /옮기거나 취소하거나, 회차권을 추가/);
	});

	test('24시간 이내 이동은 허용하되 경고를 함께 돌려준다', () => {
		const result = rescheduleSession(state(), { id: 'a1', date: '2026-11-18', start: '19:00' }, ctx);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.match(result.warnings.join(), /24시간 이내/);
		const early = rescheduleSession(state(), { id: 'a1', date: '2026-11-18', start: '19:00' }, { workingHours, now: { date: '2026-11-14', time: '12:00' } });
		assert.equal(early.ok, true);
		if (!early.ok) return;
		assert.deepEqual(early.warnings, []);
	});

	test('변경 함수는 현재 시각(now)이 없으면 예외로 알린다', () => {
		assert.throws(
			() => bookSession(state(), { id: 'n1', kind: 'pt', memberId: 'm1', date: '2026-11-17', start: '08:00', durationMinutes: 50 }, { workingHours } as never),
			/현재 시각/,
		);
		assert.throws(() => rescheduleSession(state(), { id: 'a1', date: '2026-11-18', start: '19:00' }, { workingHours } as never), /현재 시각/);
	});
});

describe('출석 기록', () => {
	const appointment = pt('a1', '2026-11-16', '19:00', '19:50');
	const state = (used = 8): SessionState => ({ appointments: [appointment], members: [member({ used })] });
	const afterClass = { date: '2026-11-16', time: '20:00' };

	test('출석을 기록하면 1회 차감한다', () => {
		const result = recordAttendance(state(), 'a1', 'attended', afterClass);
		assert.equal(result.appointment.status, 'attended');
		assert.equal(result.member.package.used, 9);
	});

	test('노쇼도 1회 차감한다', () => {
		const result = recordAttendance(state(), 'a1', 'no_show', afterClass);
		assert.equal(result.appointment.status, 'no_show');
		assert.equal(result.member.package.used, 9);
	});

	test('시작 전 수업, 이미 처리된 수업, 잔여 0회는 기록할 수 없다', () => {
		assert.throws(() => recordAttendance(state(), 'a1', 'attended', { date: '2026-11-16', time: '18:59' }), /아직 시작하지 않은/);
		const done = recordAttendance(state(), 'a1', 'attended', afterClass);
		assert.throws(() => recordAttendance(done, 'a1', 'attended', afterClass), /이미 처리된 일정/);
		assert.throws(() => recordAttendance(state(10), 'a1', 'attended', afterClass), /잔여 횟수가 없어/);
	});
});
