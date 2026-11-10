// 일정 변경 제안과 확정.
// 에이전트는 변경을 직접 쓰지 않는다. 제안할 때 1단계 판정 함수로 결과를 미리 계산해 확정 카드에 보여 주고,
// 트레이너가 확정하면 그 시점의 최신 상태와 시각으로 다시 계산해 결과가 같을 때만 반영한다.
// (예: 제안할 때는 24시간 전이라 차감 없는 취소였는데, 확정이 늦어져 당일 취소가 되면 반영하지 않고 다시 묻는다)

import { TRAINER_CONFIG, withWeekday } from './config.ts';
import {
	type BookingContext,
	type BookingResult,
	type SessionState,
	bookSession,
	cancelSession,
	checkBookable,
	recordAttendance,
	rescheduleSession,
} from './packages.ts';
import type { Now, Slot } from './schedule.ts';

export type ChangeRequest =
	| { action: 'book_pt'; appointmentId: string; memberId: string; date: string; start: string }
	| { action: 'block_time'; appointmentId: string; title: string; date: string; start: string; durationMinutes: number }
	| { action: 'reschedule'; appointmentId: string; date: string; start: string }
	| { action: 'cancel'; appointmentId: string; chargeSession: boolean }
	| { action: 'attendance'; appointmentId: string; status: 'attended' | 'no_show' };

export interface ChangePreview {
	/** 확정 카드에 보여 줄 한 줄 요약 */
	summary: string;
	/** 허용은 되지만 트레이너가 알아야 할 점 */
	warnings: string[];
	/** 확정할 때 다시 계산한 결과와 비교하는 값. 결과의 핵심(무엇이, 언제, 차감 여부)만 담는다 */
	fingerprint: string;
}

export type PlanResult =
	| { ok: true; next: SessionState; preview: ChangePreview }
	| { ok: false; reasons: string[]; alternatives: Slot[] };

/** 확정을 기다리는 변경. 키는 제안한 도구 호출 id(approvalId)다 */
export interface PendingChange {
	change: ChangeRequest;
	preview: ChangePreview;
	requestedAt: string;
}

/** 확정 대기 제안의 보관 기간. 이보다 오래된 제안은 확정해도 반영하지 않는다 */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** 제안 시각을 읽을 수 없거나 보관 기간이 지났으면 만료다(정확히 보관 기간이 된 순간까지는 유효) */
export function isPendingExpired(pending: PendingChange, nowMs: number, ttlMs = PENDING_TTL_MS): boolean {
	const requested = Date.parse(pending.requestedAt);
	return !Number.isFinite(requested) || nowMs - requested > ttlMs;
}

function bookingContext(now: Now): BookingContext {
	return { workingHours: TRAINER_CONFIG.workingHours, now };
}

function rejected(result: Extract<BookingResult, { ok: false }>): PlanResult {
	return { ok: false, reasons: result.reasons, alternatives: result.alternatives };
}

function findAppointment(state: SessionState, id: string) {
	const appointment = state.appointments.find((a) => a.id === id);
	if (!appointment) throw new Error(`일정을 찾을 수 없습니다: ${id}`);
	return appointment;
}

/**
 * 변경 하나를 지금 상태와 시각에서 계산한다. 상태는 바꾸지 않고 다음 상태(next)를 돌려준다.
 * 입력·상태가 잘못되면 예외를 던지고, 지금은 안 되는 요청이면 ok: false로 사유와 대안을 돌려준다.
 */
export function planChange(state: SessionState, change: ChangeRequest, now: Now): PlanResult {
	const ctx = bookingContext(now);

	switch (change.action) {
		case 'book_pt': {
			const result = bookSession(
				state,
				{
					id: change.appointmentId,
					kind: 'pt',
					memberId: change.memberId,
					date: change.date,
					start: change.start,
					durationMinutes: TRAINER_CONFIG.sessionMinutes,
				},
				ctx,
			);
			if (!result.ok) return rejected(result);
			const a = result.appointment;
			const member = state.members.find((m) => m.id === a.memberId);
			const left = member ? checkBookable(member, result.appointments, a.date).bookable : 0;
			return {
				ok: true,
				next: { appointments: result.appointments, members: state.members },
				preview: {
					summary: `${a.title} 회원 PT 예약: ${withWeekday(a.date)} ${a.start}-${a.end} (예약 후 더 잡을 수 있는 횟수 ${left}회)`,
					warnings: result.warnings,
					fingerprint: JSON.stringify(['book_pt', a.id, a.memberId, a.date, a.start, a.end]),
				},
			};
		}

		case 'block_time': {
			const { min, max } = TRAINER_CONFIG.personalBlockMinutes;
			if (!Number.isInteger(change.durationMinutes) || change.durationMinutes < min || change.durationMinutes > max) {
				throw new Error(`개인 일정 길이는 ${min}~${max}분 사이 정수여야 합니다: ${change.durationMinutes}`);
			}
			const result = bookSession(
				state,
				{
					id: change.appointmentId,
					kind: 'personal',
					title: change.title,
					date: change.date,
					start: change.start,
					durationMinutes: change.durationMinutes,
				},
				ctx,
			);
			if (!result.ok) return rejected(result);
			const a = result.appointment;
			return {
				ok: true,
				next: { appointments: result.appointments, members: state.members },
				preview: {
					summary: `개인 일정 추가: ${a.title} ${withWeekday(a.date)} ${a.start}-${a.end}`,
					warnings: result.warnings,
					fingerprint: JSON.stringify(['block_time', a.id, a.title, a.date, a.start, a.end]),
				},
			};
		}

		case 'reschedule': {
			const before = findAppointment(state, change.appointmentId);
			const result = rescheduleSession(state, { id: change.appointmentId, date: change.date, start: change.start }, ctx);
			if (!result.ok) return rejected(result);
			const a = result.appointment;
			return {
				ok: true,
				next: { appointments: result.appointments, members: state.members },
				preview: {
					summary: `${a.title} 일정 변경: ${withWeekday(before.date)} ${before.start} → ${withWeekday(a.date)} ${a.start}-${a.end}`,
					warnings: result.warnings,
					// 24시간 이내 여부가 바뀌면(경고 유무) 다시 확정받는다
					fingerprint: JSON.stringify(['reschedule', a.id, before.date, before.start, a.date, a.start, a.end, result.warnings.length > 0]),
				},
			};
		}

		case 'cancel': {
			const before = findAppointment(state, change.appointmentId);
			const result = cancelSession(state, change.appointmentId, now, {
				chargeSession: change.chargeSession,
				noticeHours: TRAINER_CONFIG.cancelNoticeHours,
			});
			const when = `${withWeekday(before.date)} ${before.start}`;
			const summary =
				result.outcome === 'removed'
					? `${before.title} ${when} 취소 (차감 없음)`
					: `${before.title} ${when} 당일 취소로 기록 (${result.charged ? '1회 차감' : '차감 없음'})`;
			const warnings = result.policy?.lateCancel
				? [`수업 ${result.policy.hoursBefore}시간 전 취소입니다 (${result.policy.noticeHours}시간 이내)`]
				: [];
			return {
				ok: true,
				next: { appointments: result.appointments, members: result.members },
				preview: {
					summary,
					warnings,
					// 원래 날짜·시각을 넣어, 카드가 떠 있는 동안 수업이 옮겨지면 다시 확정받는다
					fingerprint: JSON.stringify(['cancel', before.id, before.date, before.start, result.outcome, result.charged]),
				},
			};
		}

		case 'attendance': {
			const result = recordAttendance(state, change.appointmentId, change.status, now);
			const a = result.appointment;
			const remaining = result.member.package.total - result.member.package.used;
			return {
				ok: true,
				next: { appointments: result.appointments, members: result.members },
				preview: {
					summary: `${a.title} ${withWeekday(a.date)} ${a.start} ${change.status === 'attended' ? '출석' : '노쇼'} 기록 (1회 차감, 잔여 ${remaining}회)`,
					warnings: [],
					fingerprint: JSON.stringify(['attendance', a.id, a.date, a.start, change.status]),
				},
			};
		}

		default: {
			const unknown: never = change;
			throw new Error(`알 수 없는 변경입니다: ${JSON.stringify(unknown)}`);
		}
	}
}

export type ApplyOutcome =
	| { kind: 'applied'; next: SessionState; preview: ChangePreview }
	| { kind: 'changed'; reason: string; preview?: ChangePreview; alternatives?: Slot[] };

/**
 * 트레이너가 확정한 변경을 최신 상태로 다시 계산한다.
 * 제안할 때와 결과(fingerprint)가 같을 때만 applied를 돌려주고, 아니면 반영하지 않을 이유를 돌려준다.
 */
export function confirmChange(state: SessionState, pending: PendingChange, now: Now): ApplyOutcome {
	let plan: PlanResult;
	try {
		plan = planChange(state, pending.change, now);
	} catch (error) {
		return { kind: 'changed', reason: error instanceof Error ? error.message : String(error) };
	}
	if (!plan.ok) {
		return { kind: 'changed', reason: plan.reasons.join(' / '), alternatives: plan.alternatives };
	}
	if (plan.preview.fingerprint !== pending.preview.fingerprint) {
		return {
			kind: 'changed',
			reason: `제안 이후 상황이 바뀌었습니다. 지금 확정하면 결과가 달라집니다: ${plan.preview.summary}`,
			preview: plan.preview,
		};
	}
	return { kind: 'applied', next: plan.next, preview: plan.preview };
}
