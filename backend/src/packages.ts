// 회차권(PT 10회권 등)과 출석·취소 규칙. 차감 여부는 모델이 아니라 이 코드가 계산한다.
// 규칙은 국내 PT 관리 서비스와 센터 안내문을 참고했다.
// - 출석·노쇼를 기록할 때 1회를 차감한다.
// - 수업 24시간 전까지 취소하면 차감하지 않고, 그 뒤 취소는 '당일 취소'로 남기며 차감 여부는 트레이너가 정한다.
//
// 상태에 대한 전제
// - 일정 id는 유일하다(addAppointment가 중복을 막는다). 중복이 있으면 처음 찾은 일정만 처리한다.
// - PT 일정의 회원이 members에 없으면 데이터 오류로 보고 예외를 던진다(차감 없는 경로라도 처리하지 않는다).

import {
	type Appointment,
	type AvailabilityContext,
	type MutationResult,
	type Now,
	type Slot,
	type WorkingHours,
	addAppointment,
	assertValidDate,
	moveAppointment,
	toEpochMinutes,
} from './schedule.ts';

export interface SessionPackage {
	/** 구매한 총 횟수 (예: 10회권이면 10) */
	total: number;
	/** 차감된 횟수 */
	used: number;
	/** 이 날짜까지 수업을 잡을 수 있다 (YYYY-MM-DD, 포함) */
	expiresOn: string;
}

export interface Member {
	id: string;
	name: string;
	/** 운동 목표 (식단 피드백에 반영) */
	goal: string;
	/** 알레르기, 부상 등 트레이너 메모 */
	notes: string;
	package: SessionPackage;
}

/** 이 시간 전까지 취소하면 차감하지 않는다 */
export const DEFAULT_CANCEL_NOTICE_HOURS = 24;

/**
 * 저장된 회차권 숫자를 검증한다. 상태는 JSON으로 저장·복원되므로 타입 선언만 믿지 않는다.
 * total이 비어 NaN이 되면 모든 비교가 거짓이 되어 무제한 예약이 되는 것을 막는다.
 */
export function assertValidPackage(pkg: SessionPackage): void {
	const { total, used } = pkg;
	if (!Number.isInteger(total) || total < 0 || !Number.isInteger(used) || used < 0 || used > total) {
		throw new Error(`회차권 숫자가 잘못되었습니다: 총 ${String(total)}회, 사용 ${String(used)}회 (0 이상 정수, 사용 ≤ 총)`);
	}
	assertValidDate(pkg.expiresOn);
}

export function remainingSessions(pkg: SessionPackage): number {
	assertValidPackage(pkg);
	return pkg.total - pkg.used;
}

/** 아직 출석·노쇼·취소로 처리되지 않은 이 회원의 PT 예약 수. 처리되면 모두 차감 후보가 된다 */
export function pendingBookedCount(appointments: Appointment[], memberId: string, ignoreId?: string): number {
	return appointments.filter(
		(a) => a.kind === 'pt' && a.memberId === memberId && a.status === 'booked' && a.id !== ignoreId,
	).length;
}

export interface BookableResult {
	ok: boolean;
	reasons: string[];
	remaining: number;
	pendingBooked: number;
	/** 지금 더 잡을 수 있는 수업 수 */
	bookable: number;
}

/** 회차권 기준으로 이 날짜에 PT를 더 잡을 수 있는지 본다. 일정 이동이면 옮길 예약은 ignoreId로 빼고 센다 */
export function checkBookable(
	member: Member,
	appointments: Appointment[],
	date: string,
	ignoreId?: string,
): BookableResult {
	assertValidDate(date);
	const remaining = remainingSessions(member.package);
	const pendingBooked = pendingBookedCount(appointments, member.id, ignoreId);
	const bookable = Math.max(0, remaining - pendingBooked);
	const reasons: string[] = [];

	if (remaining === 0) {
		reasons.push(`${member.name} 회원의 잔여 횟수가 없습니다 (${member.package.used}/${member.package.total}회 사용)`);
	} else if (bookable === 0) {
		reasons.push(
			`${member.name} 회원은 잔여 ${remaining}회를 이미 모두 예약했습니다 (예약 ${pendingBooked}건). ` +
				'새로 잡으려면 기존 예약을 옮기거나 취소하거나, 회차권을 추가해야 합니다',
		);
	}
	if (date > member.package.expiresOn) {
		reasons.push(`회차권 만료일(${member.package.expiresOn}) 이후 날짜입니다. 만료일 이전 날짜를 고르거나 회차권 연장이 필요합니다`);
	}
	return { ok: reasons.length === 0, reasons, remaining, pendingBooked, bookable };
}

export interface CancellationPolicy {
	/** 수업 시작까지 남은 분. 0 이하면 이미 시작했다 */
	minutesBefore: number;
	/** 사람이 읽을 용도의 남은 시간. 소수점 첫째 자리까지 내림해 23.97시간이 24로 보이지 않게 한다 */
	hoursBefore: number;
	/** 기준 시간보다 늦은 취소인가 */
	lateCancel: boolean;
	noticeHours: number;
}

export function cancellationPolicy(
	appointment: Appointment,
	now: Now,
	noticeHours = DEFAULT_CANCEL_NOTICE_HOURS,
): CancellationPolicy {
	// 0·음수·NaN이면 늦은 취소가 절대 성립하지 않고, null은 기본값을 건너뛰므로 직접 검사한다
	if (typeof noticeHours !== 'number' || !Number.isFinite(noticeHours) || noticeHours <= 0) {
		throw new Error(`취소 기준 시간은 0보다 큰 숫자여야 합니다: ${String(noticeHours)}`);
	}
	const minutesBefore = toEpochMinutes(appointment.date, appointment.start) - toEpochMinutes(now.date, now.time);
	return {
		minutesBefore,
		hoursBefore: Math.floor(minutesBefore / 6) / 10,
		lateCancel: minutesBefore < noticeHours * 60,
		noticeHours,
	};
}

export interface SessionState {
	appointments: Appointment[];
	members: Member[];
}

function findBooked(state: SessionState, appointmentId: string): Appointment {
	const appointment = state.appointments.find((a) => a.id === appointmentId);
	if (!appointment) throw new Error(`일정을 찾을 수 없습니다: ${appointmentId}`);
	if (appointment.status !== 'booked') {
		throw new Error(`이미 처리된 일정입니다: ${appointmentId} (${appointment.status})`);
	}
	return appointment;
}

function findMember(state: SessionState, memberId: string | undefined): Member {
	const member = state.members.find((m) => m.id === memberId);
	if (!member) throw new Error(`회원을 찾을 수 없습니다: ${memberId}`);
	return member;
}

function deductOne(members: Member[], member: Member): Member[] {
	if (remainingSessions(member.package) === 0) {
		throw new Error(`${member.name} 회원의 잔여 횟수가 없어 차감할 수 없습니다`);
	}
	return members.map((m) => (m.id === member.id ? { ...m, package: { ...m.package, used: m.package.used + 1 } } : m));
}

function replaceAppointment(appointments: Appointment[], updated: Appointment): Appointment[] {
	return appointments.map((a) => (a.id === updated.id ? updated : a));
}

export interface CancelResult extends SessionState {
	/** 'removed'면 일정에서 지웠고, 'late_cancel'이면 당일 취소로 기록을 남겼다 */
	outcome: 'removed' | 'late_cancel';
	charged: boolean;
	policy?: CancellationPolicy;
}

/**
 * 일정을 취소한다.
 * - 개인 일정, 기준 시간 전 PT 취소: 일정을 지우고 차감하지 않는다.
 * - 기준 시간 이후 PT 취소: '당일 취소'로 기록을 남기고, chargeSession이 true일 때만 1회 차감한다.
 */
export function cancelSession(
	state: SessionState,
	appointmentId: string,
	now: Now,
	options: { chargeSession: boolean; noticeHours?: number },
): CancelResult {
	// 문자열 "false"처럼 참으로 평가되는 값이 차감으로 이어지지 않도록 불리언만 받는다
	if (typeof options.chargeSession !== 'boolean') {
		throw new Error(`chargeSession은 true 또는 false여야 합니다: ${JSON.stringify(options.chargeSession)}`);
	}
	const appointment = findBooked(state, appointmentId);
	const remove = () => state.appointments.filter((a) => a.id !== appointmentId);

	if (appointment.kind === 'personal') {
		return { appointments: remove(), members: state.members, outcome: 'removed', charged: false };
	}

	const policy = cancellationPolicy(appointment, now, options.noticeHours);
	if (policy.minutesBefore <= 0) {
		throw new Error(
			`이미 시작한 수업은 취소할 수 없습니다 (${appointment.date} ${appointment.start}). 출석 또는 노쇼로 기록하세요 (propose_attendance)`,
		);
	}
	if (!policy.lateCancel) {
		return { appointments: remove(), members: state.members, outcome: 'removed', charged: false, policy };
	}

	const member = findMember(state, appointment.memberId);
	// 차감하지 않는 경로라도 회원 데이터가 깨져 있으면 다른 경로와 같이 데이터 오류로 알린다
	assertValidPackage(member.package);
	if (options.chargeSession && remainingSessions(member.package) === 0) {
		throw new Error(
			`${member.name} 회원은 잔여 횟수가 없어 차감할 수 없습니다. 차감 없이 당일 취소로만 기록하려면 chargeSession: false로 다시 요청하세요`,
		);
	}
	return {
		appointments: replaceAppointment(state.appointments, { ...appointment, status: 'late_cancel' }),
		members: options.chargeSession ? deductOne(state.members, member) : state.members,
		outcome: 'late_cancel',
		charged: options.chargeSession,
		policy,
	};
}

export interface AttendanceResult extends SessionState {
	appointment: Appointment;
	member: Member;
}

/** 시작 시각이 지난 PT 예약을 출석 또는 노쇼로 기록하고 1회 차감한다 */
export function recordAttendance(
	state: SessionState,
	appointmentId: string,
	status: 'attended' | 'no_show',
	now: Now,
): AttendanceResult {
	// 'booked'를 넘기면 차감만 되고 상태가 그대로 남아 같은 수업을 계속 차감할 수 있으므로 값을 검사한다
	if (status !== 'attended' && status !== 'no_show') {
		throw new Error(`출석 상태는 attended 또는 no_show여야 합니다: ${JSON.stringify(status)}`);
	}
	const appointment = findBooked(state, appointmentId);
	if (appointment.kind !== 'pt') throw new Error(`PT 수업만 출석을 기록할 수 있습니다: ${appointmentId}`);
	if (toEpochMinutes(appointment.date, appointment.start) > toEpochMinutes(now.date, now.time)) {
		throw new Error(`아직 시작하지 않은 수업입니다: ${appointment.date} ${appointment.start}`);
	}

	const member = findMember(state, appointment.memberId);
	const members = deductOne(state.members, member);
	const updated: Appointment = { ...appointment, status };
	return {
		appointments: replaceAppointment(state.appointments, updated),
		members,
		appointment: updated,
		member: findMember({ appointments: [], members }, member.id),
	};
}

export interface BookingContext {
	workingHours: WorkingHours;
	/** 변경 작업은 지난 시간 검사를 빠뜨리지 않도록 현재 시각을 반드시 받는다 */
	now: Now;
	maxAlternatives?: number;
}

export type BookingResult =
	/** warnings: 허용은 되지만 트레이너가 확정 전에 알아야 할 점(예: 24시간 이내 변경) */
	| { ok: true; appointment: Appointment; appointments: Appointment[]; warnings: string[] }
	| { ok: false; reasons: string[]; conflicts: Appointment[]; alternatives: Slot[] };

/** 타입 선언과 달리 런타임에 now가 빠지면 지난 시간 검사가 조용히 꺼지므로 직접 확인한다 */
function assertNow(ctx: BookingContext): void {
	if (!ctx?.now) throw new Error('현재 시각(now)이 필요합니다');
	toEpochMinutes(ctx.now.date, ctx.now.time);
}

function availabilityContext(state: SessionState, ctx: BookingContext, latestDate?: string): AvailabilityContext {
	return {
		appointments: state.appointments,
		workingHours: ctx.workingHours,
		now: ctx.now,
		maxAlternatives: ctx.maxAlternatives,
		latestDate,
	};
}

/** 일정 판정과 회차권 판정을 합친다. 둘 다 통과해야 ok다 */
function combine(result: MutationResult, bookable?: BookableResult, warnings: string[] = []): BookingResult {
	const bookableReasons = bookable?.reasons ?? [];
	if (result.ok && bookableReasons.length === 0) {
		return { ok: true, appointment: result.appointment, appointments: result.next, warnings };
	}
	return {
		ok: false,
		reasons: [...bookableReasons, ...(result.ok ? [] : result.availability.reasons)],
		conflicts: result.ok ? [] : result.availability.conflicts,
		// 남은 횟수가 없으면 다른 시간을 제안해도 잡을 수 없으므로 대안을 내지 않는다
		alternatives: result.ok || bookable?.bookable === 0 ? [] : result.availability.alternatives,
	};
}

/**
 * 새 일정을 잡는다. PT는 회차권(잔여 횟수, 만료일)과 일정을 함께 판정하고, 대안도 만료일 안에서만 낸다.
 * 상태를 바꾸지 않고 다음 상태(appointments)를 돌려준다.
 */
export function bookSession(
	state: SessionState,
	input: {
		id: string;
		kind: 'pt' | 'personal';
		memberId?: string;
		/** 개인 일정의 사유. PT는 회원 이름을 쓴다 */
		title?: string;
		date: string;
		start: string;
		durationMinutes: number;
	},
	ctx: BookingContext,
): BookingResult {
	assertNow(ctx);
	if (input.kind === 'personal') {
		if (!input.title) throw new Error('개인 일정에는 사유(title)가 필요합니다');
		const result = addAppointment(availabilityContext(state, ctx), {
			id: input.id,
			kind: 'personal',
			title: input.title,
			date: input.date,
			start: input.start,
			durationMinutes: input.durationMinutes,
		});
		return combine(result);
	}

	const member = findMember(state, input.memberId);
	const bookable = checkBookable(member, state.appointments, input.date);
	const result = addAppointment(availabilityContext(state, ctx, member.package.expiresOn), {
		id: input.id,
		kind: 'pt',
		memberId: member.id,
		title: member.name,
		date: input.date,
		start: input.start,
		durationMinutes: input.durationMinutes,
	});
	return combine(result, bookable);
}

/**
 * 예약된 일정을 옮긴다. PT는 새 날짜가 회차권 만료일 안인지도 본다(옮길 예약 자신은 횟수에서 뺀다).
 * 시작했거나 끝난 일정은 옮길 수 없다(노쇼 차감 회피 방지).
 * 24시간 이내 PT 이동은 막지 않되 warnings로 알린다. 센터마다 늦은 변경을 차감할지가 달라 트레이너가 확정 전에 판단한다.
 */
export function rescheduleSession(
	state: SessionState,
	input: { id: string; date: string; start: string },
	ctx: BookingContext,
): BookingResult {
	assertNow(ctx);
	const current = state.appointments.find((a) => a.id === input.id);
	if (!current) throw new Error(`일정을 찾을 수 없습니다: ${input.id}`);

	if (current.kind === 'personal') {
		return combine(moveAppointment(availabilityContext(state, ctx), input));
	}
	const member = findMember(state, current.memberId);
	const bookable = checkBookable(member, state.appointments, input.date, current.id);
	const result = moveAppointment(availabilityContext(state, ctx, member.package.expiresOn), input);

	const warnings: string[] = [];
	const policy = cancellationPolicy(current, ctx.now);
	if (policy.lateCancel) {
		warnings.push(
			`수업 ${policy.hoursBefore}시간 전 변경입니다. ${policy.noticeHours}시간 이내 변경이라 센터 규정에 따라 차감 대상일 수 있습니다`,
		);
	}
	return combine(result, bookable, warnings);
}
