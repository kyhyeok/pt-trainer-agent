// 일정 변경 제안·확정 테스트. 실행: npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Member, SessionState } from './packages.ts';
import { type ChangeRequest, type PendingChange, confirmChange, isPendingExpired, planChange } from './proposals.ts';
import type { Appointment } from './schedule.ts';

// 2026-11-16(월) 19:00 김민지 PT 1건이 있는 상태
const member: Member = {
	id: 'm1',
	name: '김민지',
	goal: '체중 감량',
	notes: '',
	package: { total: 10, used: 4, expiresOn: '2026-12-31' },
};
const appointment: Appointment = {
	id: 'a1', kind: 'pt', memberId: 'm1', title: '김민지', date: '2026-11-16', start: '19:00', end: '19:50', status: 'booked',
};
const state = (): SessionState => ({ appointments: [structuredClone(appointment)], members: [structuredClone(member)] });
const at = (date: string, time: string) => ({ date, time });

function propose(s: SessionState, change: ChangeRequest, now = at('2026-11-14', '10:00')): PendingChange {
	const plan = planChange(s, change, now);
	assert.equal(plan.ok, true, '제안이 성공해야 하는 테스트다');
	if (!plan.ok) throw new Error('unreachable');
	return { change, preview: plan.preview, requestedAt: '2026-11-14T10:00' };
}

describe('planChange', () => {
	test('PT 예약 제안은 요약과 다음 상태를 만들고 입력 상태는 바꾸지 않는다', () => {
		const s = state();
		const snapshot = structuredClone(s);
		const plan = planChange(s, { action: 'book_pt', appointmentId: 'n1', memberId: 'm1', date: '2026-11-18', start: '19:00' }, at('2026-11-14', '10:00'));
		assert.equal(plan.ok, true);
		if (!plan.ok) return;
		assert.match(plan.preview.summary, /김민지 회원 PT 예약: 2026-11-18\(수\) 19:00-19:50/);
		assert.match(plan.preview.summary, /더 잡을 수 있는 횟수 4회/);
		assert.equal(plan.next.appointments.length, 2);
		assert.deepEqual(s, snapshot);
	});

	test('안 되는 예약은 사유와 대안을 돌려준다', () => {
		const plan = planChange(state(), { action: 'book_pt', appointmentId: 'n1', memberId: 'm1', date: '2026-11-16', start: '19:30' }, at('2026-11-14', '10:00'));
		assert.equal(plan.ok, false);
		if (plan.ok) return;
		assert.match(plan.reasons.join(), /겹칩니다/);
		assert.ok(plan.alternatives.length > 0);
	});

	test('개인 일정 길이는 10~480분 정수만 받는다', () => {
		for (const durationMinutes of [5, 481, 30.5]) {
			assert.throws(
				() => planChange(state(), { action: 'block_time', appointmentId: 'p1', title: '치과', date: '2026-11-17', start: '13:00', durationMinutes }, at('2026-11-14', '10:00')),
				/10~480분/,
			);
		}
	});

	test('24시간 이내 일정 변경은 경고를 붙인다', () => {
		const plan = planChange(state(), { action: 'reschedule', appointmentId: 'a1', date: '2026-11-18', start: '19:00' }, at('2026-11-16', '12:00'));
		assert.equal(plan.ok, true);
		if (!plan.ok) return;
		assert.match(plan.preview.summary, /2026-11-16\(월\) 19:00 → 2026-11-18\(수\) 19:00-19:50/);
		assert.equal(plan.preview.warnings.length, 1);
	});

	test('취소 요약에 차감 여부가 드러난다', () => {
		const early = planChange(state(), { action: 'cancel', appointmentId: 'a1', chargeSession: true }, at('2026-11-14', '10:00'));
		assert.equal(early.ok && early.preview.summary.includes('취소 (차감 없음)'), true);
		const late = planChange(state(), { action: 'cancel', appointmentId: 'a1', chargeSession: true }, at('2026-11-16', '12:00'));
		assert.equal(late.ok && late.preview.summary.includes('당일 취소로 기록 (1회 차감)'), true);
	});
});

describe('isPendingExpired', () => {
	const pending = (requestedAt: string): PendingChange => ({
		change: { action: 'cancel', appointmentId: 'a1', chargeSession: false },
		preview: { summary: '', warnings: [], fingerprint: '' },
		requestedAt,
	});
	const DAY = 24 * 60 * 60 * 1000;

	test('제안한 지 24시간이 지나면 만료다 (정확히 24시간은 아직 유효)', () => {
		const requested = Date.parse('2026-11-10T10:00:00.000Z');
		assert.equal(isPendingExpired(pending('2026-11-10T10:00:00.000Z'), requested + DAY - 1), false);
		assert.equal(isPendingExpired(pending('2026-11-10T10:00:00.000Z'), requested + DAY), false);
		assert.equal(isPendingExpired(pending('2026-11-10T10:00:00.000Z'), requested + DAY + 1), true);
	});

	test('제안 시각을 읽을 수 없으면 만료로 본다', () => {
		assert.equal(isPendingExpired(pending('not-a-date'), Date.now()), true);
	});
});

describe('confirmChange', () => {
	test('제안과 결과가 같으면 반영한다', () => {
		const s = state();
		const pending = propose(s, { action: 'book_pt', appointmentId: 'n1', memberId: 'm1', date: '2026-11-18', start: '19:00' });
		const outcome = confirmChange(s, pending, at('2026-11-14', '11:00'));
		assert.equal(outcome.kind, 'applied');
		if (outcome.kind !== 'applied') return;
		assert.ok(outcome.next.appointments.some((a) => a.id === 'n1'));
	});

	test('제안 뒤 24시간 이내로 넘어가 취소 결과가 바뀌면 반영하지 않는다', () => {
		const s = state();
		const pending = propose(s, { action: 'cancel', appointmentId: 'a1', chargeSession: true }, at('2026-11-14', '10:00'));
		const outcome = confirmChange(s, pending, at('2026-11-16', '12:00'));
		assert.equal(outcome.kind, 'changed');
		if (outcome.kind !== 'changed') return;
		assert.match(outcome.reason, /상황이 바뀌었습니다.*당일 취소/);
	});

	test('제안 뒤 24시간 이내로 넘어간 일정 변경도 다시 확정받는다', () => {
		const s = state();
		const pending = propose(s, { action: 'reschedule', appointmentId: 'a1', date: '2026-11-18', start: '19:00' }, at('2026-11-14', '10:00'));
		assert.equal(confirmChange(s, pending, at('2026-11-16', '12:00')).kind, 'changed');
	});

	test('그 사이 다른 예약이 자리를 차지하면 반영하지 않고 대안을 준다', () => {
		const s = state();
		const pending = propose(s, { action: 'book_pt', appointmentId: 'n1', memberId: 'm1', date: '2026-11-18', start: '19:00' });
		const taken: SessionState = {
			...s,
			appointments: [...s.appointments, { id: 'p9', kind: 'personal', title: '세미나', date: '2026-11-18', start: '18:30', end: '20:00', status: 'booked' }],
		};
		const outcome = confirmChange(taken, pending, at('2026-11-14', '11:00'));
		assert.equal(outcome.kind, 'changed');
		if (outcome.kind !== 'changed') return;
		assert.match(outcome.reason, /겹칩니다/);
		assert.ok((outcome.alternatives ?? []).length > 0);
	});

	test('같은 확정이 두 번 들어와도 두 번 반영하지 않는다', () => {
		const s = state();
		const pending = propose(s, { action: 'book_pt', appointmentId: 'n1', memberId: 'm1', date: '2026-11-18', start: '19:00' });
		const first = confirmChange(s, pending, at('2026-11-14', '11:00'));
		assert.equal(first.kind, 'applied');
		if (first.kind !== 'applied') return;
		const second = confirmChange(first.next, pending, at('2026-11-14', '11:01'));
		assert.equal(second.kind, 'changed');
		if (second.kind !== 'changed') return;
		assert.match(second.reason, /이미 있는 일정 id/);
	});

	test('이미 지워진 일정의 취소를 확정하면 반영하지 않는다', () => {
		const s = state();
		const pending = propose(s, { action: 'cancel', appointmentId: 'a1', chargeSession: false });
		const outcome = confirmChange({ ...s, appointments: [] }, pending, at('2026-11-14', '11:00'));
		assert.equal(outcome.kind, 'changed');
	});

	test('취소 카드가 떠 있는 동안 그 수업이 다른 날로 옮겨지면, 예전 취소 카드는 반영하지 않는다', () => {
		const s = state();
		const staleCancel = propose(s, { action: 'cancel', appointmentId: 'a1', chargeSession: false });
		const move = propose(s, { action: 'reschedule', appointmentId: 'a1', date: '2026-11-17', start: '19:00' });
		const moved = confirmChange(s, move, at('2026-11-14', '10:05'));
		assert.equal(moved.kind, 'applied');
		if (moved.kind !== 'applied') return;
		assert.equal(confirmChange(moved.next, staleCancel, at('2026-11-14', '10:10')).kind, 'changed');
	});

	test('출석 카드가 떠 있는 동안 그 수업이 다른 시각으로 바뀌면 반영하지 않는다', () => {
		const s = state();
		const staleAttendance = propose(s, { action: 'attendance', appointmentId: 'a1', status: 'attended' }, at('2026-11-16', '20:00'));
		const shifted: SessionState = { ...s, appointments: [{ ...appointment, start: '18:00', end: '18:50' }] };
		assert.equal(confirmChange(shifted, staleAttendance, at('2026-11-16', '20:05')).kind, 'changed');
	});

	test('출석 기록을 확정하면 1회 차감된다', () => {
		const s = state();
		const pending = propose(s, { action: 'attendance', appointmentId: 'a1', status: 'attended' }, at('2026-11-16', '20:00'));
		const outcome = confirmChange(s, pending, at('2026-11-16', '20:05'));
		assert.equal(outcome.kind, 'applied');
		if (outcome.kind !== 'applied') return;
		assert.equal(outcome.next.members[0].package.used, 5);
		assert.match(outcome.preview.summary, /출석 기록 \(1회 차감, 잔여 5회\)/);
	});
});
