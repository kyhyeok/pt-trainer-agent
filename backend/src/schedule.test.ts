// 일정 판정 로직 테스트. 실행: npm test (node --test, 추가 의존성 없음)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	type Appointment,
	type AvailabilityContext,
	type WorkingHours,
	addAppointment,
	addDays,
	checkAvailability,
	findFreeSlots,
	listAppointments,
	moveAppointment,
	weekdayOf,
} from './schedule.ts';

// 평일 07:00-12:00, 15:00-22:00 / 토 09:00-14:00 / 일 휴무
const workingHours: WorkingHours = {
	1: [{ start: '07:00', end: '12:00' }, { start: '15:00', end: '22:00' }],
	2: [{ start: '07:00', end: '12:00' }, { start: '15:00', end: '22:00' }],
	3: [{ start: '07:00', end: '12:00' }, { start: '15:00', end: '22:00' }],
	4: [{ start: '07:00', end: '12:00' }, { start: '15:00', end: '22:00' }],
	5: [{ start: '07:00', end: '12:00' }, { start: '15:00', end: '22:00' }],
	6: [{ start: '09:00', end: '14:00' }],
};

// 2026-11-16은 월요일, 2026-11-15는 일요일이다
const appointments: Appointment[] = [
	{ id: 'a1', kind: 'pt', memberId: 'm1', title: '김민지', date: '2026-11-16', start: '19:00', end: '19:50', status: 'booked' },
	{ id: 'a2', kind: 'personal', title: '치과', date: '2026-11-16', start: '15:00', end: '16:00', status: 'booked' },
	{ id: 'a3', kind: 'pt', memberId: 'm2', title: '이준호', date: '2026-11-16', start: '10:00', end: '10:50', status: 'late_cancel' },
];

const ctx: AvailabilityContext = {
	appointments,
	workingHours,
	now: { date: '2026-11-10', time: '14:00' },
};

describe('날짜 유틸', () => {
	test('요일과 날짜 더하기는 시간대와 무관하게 계산된다', () => {
		assert.equal(weekdayOf('2026-11-10'), 2);
		assert.equal(weekdayOf('2026-11-15'), 0);
		assert.equal(addDays('2026-12-31', 1), '2027-01-01');
		assert.equal(addDays('2028-02-28', 1), '2028-02-29');
	});

	test('잘못된 입력은 예외로 알린다', () => {
		assert.throws(() => checkAvailability(ctx, { date: '2026-02-30', start: '10:00', durationMinutes: 50 }), /존재하지 않는 날짜/);
		assert.throws(() => checkAvailability(ctx, { date: '2026-11-16', start: '25:00', durationMinutes: 50 }), /시각 형식/);
		assert.throws(() => checkAvailability(ctx, { date: '2026/11/16', start: '10:00', durationMinutes: 50 }), /날짜 형식/);
		assert.throws(() => checkAvailability(ctx, { date: '2026-11-16', start: '10:00', durationMinutes: 0 }), /양의 정수/);
	});
});

describe('checkAvailability', () => {
	test('근무 시간 안의 빈 시간은 가능하고 대안을 내지 않는다', () => {
		const result = checkAvailability(ctx, { date: '2026-11-16', start: '08:00', durationMinutes: 50 });
		assert.equal(result.available, true);
		assert.deepEqual(result.requested, { date: '2026-11-16', start: '08:00', end: '08:50' });
		assert.deepEqual(result.alternatives, []);
	});

	test('겹치면 불가이고, 같은 날 요청 시각에 가까운 대안 3개를 낸다', () => {
		const result = checkAvailability(ctx, { date: '2026-11-16', start: '19:30', durationMinutes: 50 });
		assert.equal(result.available, false);
		assert.deepEqual(result.conflicts.map((c) => c.id), ['a1']);
		assert.match(result.reasons.join(), /기존 일정과 겹칩니다/);
		// 20:00(30분 차), 20:30(60분 차), 18:00과 21:00(90분 차) 중 이른 18:00
		assert.deepEqual(result.alternatives.map((s) => s.start), ['20:00', '20:30', '18:00']);
	});

	test('끝과 시작이 맞닿은 일정은 겹치지 않는다', () => {
		assert.equal(checkAvailability(ctx, { date: '2026-11-16', start: '19:50', durationMinutes: 50 }).available, true);
		assert.equal(checkAvailability(ctx, { date: '2026-11-16', start: '18:10', durationMinutes: 50 }).available, true);
	});

	test('당일 취소로 기록된 일정은 시간을 차지하지 않는다', () => {
		assert.equal(checkAvailability(ctx, { date: '2026-11-16', start: '10:00', durationMinutes: 50 }).available, true);
	});

	test('근무 시간대를 벗어나거나 걸치면 불가다', () => {
		const result = checkAvailability(ctx, { date: '2026-11-16', start: '11:30', durationMinutes: 50 });
		assert.equal(result.available, false);
		assert.match(result.reasons.join(), /근무 시간 밖입니다 \(월요일: 07:00-12:00, 15:00-22:00\)/);
	});

	test('휴무일이면 다음 근무일의 빈 시간을 대안으로 낸다', () => {
		const result = checkAvailability(ctx, { date: '2026-11-15', start: '10:00', durationMinutes: 50 });
		assert.equal(result.available, false);
		assert.match(result.reasons.join(), /휴무일/);
		assert.deepEqual(
			result.alternatives.map((s) => `${s.date} ${s.start}`),
			['2026-11-16 07:00', '2026-11-16 07:30', '2026-11-16 08:00'],
		);
	});

	test('지난 시간은 불가이고, 대안에도 지난 시간은 넣지 않는다', () => {
		const result = checkAvailability(ctx, { date: '2026-11-10', start: '08:00', durationMinutes: 50 });
		assert.equal(result.available, false);
		assert.match(result.reasons.join(), /이미 지난 시간/);
		assert.equal(result.alternatives[0].start, '15:00');
		assert.ok(result.alternatives.every((s) => s.date > '2026-11-10' || s.start >= '14:00'));
	});

	test('자정을 넘기는 일정은 불가다', () => {
		const result = checkAvailability(ctx, { date: '2026-11-16', start: '23:30', durationMinutes: 60, kind: 'personal' });
		assert.equal(result.available, false);
		assert.match(result.reasons.join(), /자정/);
	});

	test('개인 일정은 근무 시간 밖에도 잡을 수 있다', () => {
		assert.equal(
			checkAvailability(ctx, { date: '2026-11-15', start: '10:00', durationMinutes: 60, kind: 'personal' }).available,
			true,
		);
	});
});

describe('경계와 리뷰에서 나온 경우', () => {
	test('자정(24:00)에 끝나는 일정은 잡을 수 없다', () => {
		const result = checkAvailability(ctx, { date: '2026-11-16', start: '23:00', durationMinutes: 60, kind: 'personal' });
		assert.equal(result.available, false);
		assert.match(result.reasons.join(), /자정/);
		assert.equal(
			checkAvailability(ctx, { date: '2026-11-16', start: '23:00', durationMinutes: 50, kind: 'personal' }).available,
			true,
		);
	});

	test('근무 종료 시각에 딱 맞게 끝나면 가능하고, 1분이라도 넘으면 불가다', () => {
		assert.equal(checkAvailability(ctx, { date: '2026-11-16', start: '21:10', durationMinutes: 50 }).available, true);
		assert.equal(checkAvailability(ctx, { date: '2026-11-16', start: '21:11', durationMinutes: 50 }).available, false);
	});

	test('현재 시각과 시작 시각이 같으면 지난 시간이 아니다', () => {
		const atEight = { ...ctx, now: { date: '2026-11-16', time: '08:00' } };
		assert.equal(checkAvailability(atEight, { date: '2026-11-16', start: '08:00', durationMinutes: 50 }).available, true);
	});

	test('출석·노쇼로 처리된 일정은 시간을 차지하지 않는다', () => {
		const processed: AvailabilityContext = {
			...ctx,
			appointments: [
				{ id: 'x1', kind: 'pt', memberId: 'm1', title: '김민지', date: '2026-11-17', start: '08:00', end: '08:50', status: 'attended' },
				{ id: 'x2', kind: 'pt', memberId: 'm1', title: '김민지', date: '2026-11-17', start: '09:00', end: '09:50', status: 'no_show' },
			],
		};
		assert.equal(checkAvailability(processed, { date: '2026-11-17', start: '08:00', durationMinutes: 50 }).available, true);
		assert.equal(checkAvailability(processed, { date: '2026-11-17', start: '09:00', durationMinutes: 50 }).available, true);
	});

	test('근무 시간대 배열 순서와 상관없이 대안은 시간순이다', () => {
		const reversed: AvailabilityContext = {
			...ctx,
			workingHours: { ...workingHours, 1: [{ start: '15:00', end: '22:00' }, { start: '07:00', end: '12:00' }] },
		};
		const result = checkAvailability(reversed, { date: '2026-11-15', start: '10:00', durationMinutes: 50 });
		assert.deepEqual(result.alternatives.map((s) => s.start), ['07:00', '07:30', '08:00']);
	});

	test('같은 날 대안이 부족하면 다음 근무일에서 채운다', () => {
		// 토요일(2026-11-21) 09:00-13:00을 막으면 그날 빈 시간은 13:00 하나, 일요일은 휴무, 월요일 07:00부터
		const busySaturday: AvailabilityContext = {
			...ctx,
			appointments: [{ id: 'p1', kind: 'personal', title: '세미나', date: '2026-11-21', start: '09:00', end: '13:00', status: 'booked' }],
		};
		const result = checkAvailability(busySaturday, { date: '2026-11-21', start: '10:00', durationMinutes: 50 });
		assert.deepEqual(
			result.alternatives.map((s) => `${s.date} ${s.start}`),
			['2026-11-21 13:00', '2026-11-23 07:00', '2026-11-23 07:30'],
		);
	});

	test('지난 날짜를 요청하면 오늘부터 대안을 찾는다', () => {
		const result = checkAvailability(ctx, { date: '2025-11-17', start: '10:00', durationMinutes: 50 });
		assert.equal(result.available, false);
		assert.deepEqual(result.alternatives[0], { date: '2026-11-10', start: '15:00', end: '15:50' });
	});

	test('대안 개수가 음수로 들어오면 대안을 내지 않는다', () => {
		const result = checkAvailability({ ...ctx, maxAlternatives: -1 }, { date: '2026-11-16', start: '19:30', durationMinutes: 50 });
		assert.deepEqual(result.alternatives, []);
	});

	test('같은 id나 회원이 없는 PT는 추가할 수 없다', () => {
		assert.throws(
			() => addAppointment(ctx, { id: 'a1', kind: 'personal', title: '중복', date: '2026-11-17', start: '08:00', durationMinutes: 50 }),
			/이미 있는 일정 id/,
		);
		assert.throws(
			() => addAppointment(ctx, { id: 'new', kind: 'pt', title: '회원 없음', date: '2026-11-17', start: '08:00', durationMinutes: 50 }),
			/회원 id/,
		);
	});
});

describe('교차검증·적대적 리뷰에서 나온 경우', () => {
	test('근무 시간대가 겹쳐도 같은 시각 슬롯을 두 번 내지 않는다', () => {
		const overlapping: AvailabilityContext = {
			appointments: [],
			workingHours: { 1: [{ start: '09:00', end: '14:00' }, { start: '12:00', end: '15:00' }] },
		};
		const starts = findFreeSlots(overlapping, '2026-11-16', 50).map((s) => s.start);
		assert.equal(new Set(starts).size, starts.length);
	});

	test('맞닿은 근무 시간대는 이어진 근무로 보고, 경계를 걸치는 수업도 가능하다', () => {
		const adjacent: AvailabilityContext = {
			appointments: [],
			workingHours: { 1: [{ start: '07:00', end: '12:00' }, { start: '12:00', end: '22:00' }] },
		};
		assert.equal(checkAvailability(adjacent, { date: '2026-11-16', start: '11:30', durationMinutes: 50 }).available, true);
	});

	test('잘못된 근무 시간 설정(끝이 시작보다 이르거나 같음)은 예외로 알린다', () => {
		const broken: AvailabilityContext = { appointments: [], workingHours: { 1: [{ start: '12:00', end: '09:00' }] } };
		assert.throws(() => checkAvailability(broken, { date: '2026-11-16', start: '10:00', durationMinutes: 50 }), /근무 시간 설정/);
	});

	test('이미 시작한 일정은 옮길 수 없다', () => {
		const during = { ...ctx, now: { date: '2026-11-16', time: '19:10' } };
		assert.throws(() => moveAppointment(during, { id: 'a1', date: '2026-11-17', start: '19:00' }), /이미 시작한 일정.*propose_attendance/);
		const after = { ...ctx, now: { date: '2026-11-16', time: '20:30' } };
		assert.throws(() => moveAppointment(after, { id: 'a1', date: '2026-11-25', start: '19:00' }), /이미 시작한 일정/);
	});

	test('이동 대안에 지금 자리(바뀌는 것이 없는 제안)는 넣지 않는다', () => {
		// 19:00 a1 주변을 꽉 채워, 자기 자리를 빼지 않으면 19:00이 1순위가 되는 상황
		const crowded: AvailabilityContext = {
			...ctx,
			appointments: [
				...appointments,
				{ id: 'c1', kind: 'pt', memberId: 'm2', title: '이준호', date: '2026-11-16', start: '20:00', end: '20:50', status: 'booked' },
				{ id: 'c2', kind: 'pt', memberId: 'm3', title: '박서연', date: '2026-11-16', start: '21:00', end: '21:50', status: 'booked' },
			],
		};
		const result = moveAppointment(crowded, { id: 'a1', date: '2026-11-16', start: '22:00' });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.availability.alternatives.length > 0);
		assert.ok(result.availability.alternatives.every((s) => !(s.date === '2026-11-16' && s.start === '19:00')));
	});

	test('지원 범위(2000~2100년) 밖 날짜는 예외로 알리고, 범위 끝에서 대안을 찾다가 깨지지 않는다', () => {
		assert.throws(() => checkAvailability(ctx, { date: '2101-01-03', start: '10:00', durationMinutes: 50 }), /2000~2100/);
		// 2100-12-31(금) 22:00은 근무 시간 밖 → 대안 탐색이 2101년으로 넘어가지 않아야 한다
		const result = checkAvailability({ ...ctx, now: undefined }, { date: '2100-12-31', start: '22:00', durationMinutes: 50 });
		assert.equal(result.available, false);
		assert.ok(result.alternatives.every((s) => s.date <= '2100-12-31'));
	});

	test('빈 문자열 memberId로 조회하면 다른 회원 일정을 돌려주지 않는다', () => {
		assert.equal(listAppointments(appointments, { from: '2026-11-01', to: '2026-11-30', memberId: '' }).length, 0);
		assert.equal(listAppointments(appointments, { from: '2026-11-01', to: '2026-11-30', memberId: 'm1' }).length, 1);
	});
});

describe('addAppointment / moveAppointment', () => {
	test('추가하면 종료 시각을 계산해 예약 상태로 넣는다', () => {
		const result = addAppointment(ctx, {
			id: 'new', kind: 'pt', memberId: 'm3', title: '박서연', date: '2026-11-16', start: '08:00', durationMinutes: 50,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.appointment, {
			id: 'new', kind: 'pt', memberId: 'm3', title: '박서연', date: '2026-11-16', start: '08:00', end: '08:50', status: 'booked',
		});
		assert.equal(result.next.length, appointments.length + 1);
		assert.equal(appointments.length, 3, '원본 배열은 바꾸지 않는다');
	});

	test('겹치는 시간에는 추가하지 않고 판정 결과를 돌려준다', () => {
		const result = addAppointment(ctx, {
			id: 'new', kind: 'pt', memberId: 'm3', title: '박서연', date: '2026-11-16', start: '15:30', durationMinutes: 50,
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.deepEqual(result.availability.conflicts.map((c) => c.id), ['a2']);
	});

	test('옮길 때 자기 원래 시간과 겹치는 것은 충돌로 보지 않는다', () => {
		const result = moveAppointment(ctx, { id: 'a1', date: '2026-11-16', start: '19:30' });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.appointment.end, '20:20');
		assert.equal(result.next.find((a) => a.id === 'a1')?.start, '19:30');
	});

	test('다른 일정과 겹치는 곳으로는 옮기지 않는다', () => {
		const result = moveAppointment(ctx, { id: 'a1', date: '2026-11-16', start: '15:00' });
		assert.equal(result.ok, false);
	});

	test('이미 처리된 일정이나 없는 일정은 옮길 수 없다', () => {
		assert.throws(() => moveAppointment(ctx, { id: 'a3', date: '2026-11-17', start: '10:00' }), /이미 처리된 일정/);
		assert.throws(() => moveAppointment(ctx, { id: 'nope', date: '2026-11-17', start: '10:00' }), /찾을 수 없습니다/);
	});
});
