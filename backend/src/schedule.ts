// 일정 계산 로직. 일정이 비어 있는지는 모델이 아니라 이 코드가 판정한다.
// 날짜는 'YYYY-MM-DD', 시각은 'HH:mm' 문자열이고 모두 트레이너 현지 시간(KST) 기준이다.
// 일정은 자정 전에 끝나야 하며, 근무 시간 종료도 '24:00'은 쓰지 않는다(최대 '23:59').
// 외부 의존성이 없는 순수 함수만 두어 `node --test`로 바로 검증할 수 있게 한다.
//
// 실패를 알리는 방식은 두 가지로 나눈다.
// - 입력이나 상태가 잘못됨(형식 오류, 없는 일정, 이미 처리된 일정): 예외를 던진다.
// - 요청은 올바르지만 지금은 안 됨(겹침, 근무 시간 밖 등): { ok: false } 또는 available: false로 사유와 대안을 돌려준다.

export type AppointmentKind = 'pt' | 'personal';

/**
 * booked: 예약됨(시간을 차지함)
 * attended / no_show: 출석·노쇼로 기록됨(회차 차감 완료)
 * late_cancel: 24시간 이내 취소로 기록됨(시간은 비워 줌)
 */
export type AppointmentStatus = 'booked' | 'attended' | 'no_show' | 'late_cancel';

export interface Appointment {
	id: string;
	kind: AppointmentKind;
	/** PT 회원 id. 개인 일정이면 없다 */
	memberId?: string;
	/** PT면 회원 이름, 개인 일정이면 사유 */
	title: string;
	date: string;
	start: string;
	end: string;
	status: AppointmentStatus;
}

export interface TimeRange {
	start: string;
	end: string;
}

/** 요일(0=일요일 ~ 6=토요일)별 근무 시간대. 키가 없거나 빈 배열이면 휴무일이다. */
export type WorkingHours = Partial<Record<number, TimeRange[]>>;

export interface Slot {
	date: string;
	start: string;
	end: string;
}

/** 지난 시간 판정에 쓰는 현재 시각(KST) */
export interface Now {
	date: string;
	time: string;
}

export interface AvailabilityQuery {
	date: string;
	start: string;
	durationMinutes: number;
	/** 일정을 옮길 때 자기 자신과의 충돌은 무시한다 */
	ignoreId?: string;
	/** 개인 일정은 근무 시간 밖에도 잡을 수 있다 */
	kind?: AppointmentKind;
	/** 대안에서 뺄 슬롯. 일정을 옮길 때 지금 자리를 다시 제안하지 않도록 쓴다 */
	excludeSlot?: { date: string; start: string };
}

export interface AvailabilityContext {
	appointments: Appointment[];
	workingHours: WorkingHours;
	now?: Now;
	maxAlternatives?: number;
	/** 대안을 찾을 마지막 날짜(포함). 회차권 만료일처럼 그 뒤로는 제안하면 안 될 때 쓴다 */
	latestDate?: string;
}

export interface AvailabilityResult {
	available: boolean;
	requested: Slot;
	/** 사람이 읽을 수 있는 불가 사유 */
	reasons: string[];
	conflicts: Appointment[];
	/** 불가할 때만 채운다. 같은 날은 요청 시각에 가까운 순, 다음 날부터는 날짜순이다 */
	alternatives: Slot[];
}

/** 국내 PT 1회 수업은 보통 50분이다(업계 표준 여부는 미확인이라 설정값으로 둔다) */
export const DEFAULT_SESSION_MINUTES = 50;

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SLOT_STEP_MINUTES = 30;
const ALTERNATIVE_SEARCH_DAYS = 7;
const MINUTES_PER_DAY = 24 * 60;
/** 연도 범위를 제한해 날짜 더하기가 5자리 연도(+010000)를 만들며 깨지는 일을 막는다 */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const MAX_DATE = `${MAX_YEAR}-12-31`;

function parseDate(date: string): [number, number, number] {
	const match = DATE_PATTERN.exec(date);
	if (!match) throw new Error(`날짜 형식이 잘못되었습니다: ${date} (YYYY-MM-DD)`);
	const y = Number(match[1]);
	const m = Number(match[2]);
	const d = Number(match[3]);
	if (y < MIN_YEAR || y > MAX_YEAR) {
		throw new Error(`지원하는 날짜 범위(${MIN_YEAR}~${MAX_YEAR}년)를 벗어났습니다: ${date}`);
	}
	const parsed = new Date(Date.UTC(y, m - 1, d));
	if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
		throw new Error(`존재하지 않는 날짜입니다: ${date}`);
	}
	return [y, m, d];
}

export function assertValidDate(date: string): void {
	parseDate(date);
}

export function toMinutes(time: string): number {
	const match = TIME_PATTERN.exec(time);
	if (!match) throw new Error(`시각 형식이 잘못되었습니다: ${time} (HH:mm)`);
	return Number(match[1]) * 60 + Number(match[2]);
}

export function fromMinutes(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 날짜·시각을 하나의 분 단위 숫자로 바꾼다. 두 시점의 앞뒤 비교와 시간 차 계산에 쓴다 */
export function toEpochMinutes(date: string, time: string): number {
	const [y, m, d] = parseDate(date);
	return Date.UTC(y, m - 1, d) / 60_000 + toMinutes(time);
}

export function weekdayOf(date: string): number {
	const [y, m, d] = parseDate(date);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayLabel(date: string): string {
	return WEEKDAY_LABELS[weekdayOf(date)];
}

export function addDays(date: string, days: number): string {
	const [y, m, d] = parseDate(date);
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 끝과 시작이 맞닿는 연속 일정(10:00-10:50, 10:50-11:40)은 겹치지 않는 것으로 본다 */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
	return aStart < bEnd && bStart < aEnd;
}

function isPast(date: string, startMinutes: number, now?: Now): boolean {
	if (!now) return false;
	const [y, m, d] = parseDate(date);
	return Date.UTC(y, m - 1, d) / 60_000 + startMinutes < toEpochMinutes(now.date, now.time);
}

interface MinuteRange {
	start: number;
	end: number;
}

/**
 * 그 날의 근무 시간대를 시간순으로 정렬하고, 겹치거나 맞닿은 시간대는 하나로 합친다.
 * 이렇게 하면 겹친 설정에서 같은 슬롯이 두 번 나오지 않고, 07-12/12-22처럼 이어진 근무의 경계를 걸치는 수업도 잡을 수 있다.
 */
function workingRangesOn(workingHours: WorkingHours, date: string): MinuteRange[] {
	const ranges = (workingHours[weekdayOf(date)] ?? []).map((r) => {
		const range = { start: toMinutes(r.start), end: toMinutes(r.end) };
		if (range.end <= range.start) throw new Error(`근무 시간 설정이 잘못되었습니다: ${r.start}-${r.end}`);
		return range;
	});
	ranges.sort((a, b) => a.start - b.start);

	const merged: MinuteRange[] = [];
	for (const range of ranges) {
		const last = merged.at(-1);
		if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

function describeHours(ranges: MinuteRange[]): string {
	if (ranges.length === 0) return '휴무일';
	return ranges.map((r) => `${fromMinutes(r.start)}-${fromMinutes(r.end)}`).join(', ');
}

/** 시간을 차지하는 것은 예약 상태(booked)인 일정뿐이다 */
function findConflicts(appointments: Appointment[], date: string, start: number, end: number, ignoreId?: string) {
	return appointments.filter(
		(a) =>
			a.status === 'booked' &&
			a.date === date &&
			a.id !== ignoreId &&
			overlaps(start, end, toMinutes(a.start), toMinutes(a.end)),
	);
}

/** 근무 시간 안에서 잡을 수 있는 빈 슬롯을 30분 간격으로 모두 찾는다 */
export function findFreeSlots(
	ctx: AvailabilityContext,
	date: string,
	durationMinutes: number,
	ignoreId?: string,
): Slot[] {
	const slots: Slot[] = [];
	for (const range of workingRangesOn(ctx.workingHours, date)) {
		for (let start = range.start; start + durationMinutes <= range.end; start += SLOT_STEP_MINUTES) {
			const end = start + durationMinutes;
			if (isPast(date, start, ctx.now)) continue;
			if (findConflicts(ctx.appointments, date, start, end, ignoreId).length > 0) continue;
			slots.push({ date, start: fromMinutes(start), end: fromMinutes(end) });
		}
	}
	return slots;
}

export function checkAvailability(ctx: AvailabilityContext, query: AvailabilityQuery): AvailabilityResult {
	assertValidDate(query.date);
	if (!Number.isInteger(query.durationMinutes) || query.durationMinutes <= 0) {
		throw new Error(`수업 시간(분)은 양의 정수여야 합니다: ${query.durationMinutes}`);
	}

	const start = toMinutes(query.start);
	const end = start + query.durationMinutes;
	const requested: Slot = {
		date: query.date,
		start: query.start,
		end: end < MINUTES_PER_DAY ? fromMinutes(end) : '24:00+',
	};
	const reasons: string[] = [];

	// 24:00에 끝나는 일정도 막는다. '24:00'은 시각 형식으로 다시 읽을 수 없어 이후 판정이 깨지기 때문이다
	if (end >= MINUTES_PER_DAY) reasons.push('일정은 자정(24:00) 전에 끝나야 합니다');
	if (isPast(query.date, start, ctx.now)) reasons.push('이미 지난 시간입니다');

	if (query.kind !== 'personal') {
		const ranges = workingRangesOn(ctx.workingHours, query.date);
		const insideWorkingHours = ranges.some((r) => start >= r.start && end <= r.end);
		if (!insideWorkingHours) {
			reasons.push(`근무 시간 밖입니다 (${weekdayLabel(query.date)}요일: ${describeHours(ranges)})`);
		}
	}

	const conflicts = findConflicts(ctx.appointments, query.date, start, end, query.ignoreId);
	if (conflicts.length > 0) {
		reasons.push(`기존 일정과 겹칩니다: ${conflicts.map((c) => `${c.start}-${c.end} ${c.title}`).join(', ')}`);
	}

	const available = reasons.length === 0;
	return {
		available,
		requested,
		reasons,
		conflicts,
		alternatives: available ? [] : suggestAlternatives(ctx, query, start),
	};
}

function suggestAlternatives(ctx: AvailabilityContext, query: AvailabilityQuery, requestedStart: number): Slot[] {
	const max = Math.max(0, ctx.maxAlternatives ?? 3);
	// 지난 날짜(예: 모델이 연도를 잘못 넣은 경우)를 요청하면 오늘부터 찾는다
	const baseDate = ctx.now && query.date < ctx.now.date ? ctx.now.date : query.date;
	const withinLimit = (date: string) => date <= MAX_DATE && (!ctx.latestDate || date <= ctx.latestDate);
	const excluded = query.excludeSlot;
	const candidates = (date: string) =>
		findFreeSlots(ctx, date, query.durationMinutes, query.ignoreId).filter(
			(s) => !(excluded && s.date === excluded.date && s.start === excluded.start),
		);
	// 같은 날은 원래 원하던 시각과 가까운 순서로 제안한다. 정렬은 안정 정렬이라 거리가 같으면 이른 시각이 먼저다
	const sameDay = withinLimit(baseDate)
		? candidates(baseDate).sort(
				(a, b) => Math.abs(toMinutes(a.start) - requestedStart) - Math.abs(toMinutes(b.start) - requestedStart),
			)
		: [];
	const result = sameDay.slice(0, max);

	for (let offset = 1; offset <= ALTERNATIVE_SEARCH_DAYS && result.length < max; offset++) {
		const date = addDays(baseDate, offset);
		if (!withinLimit(date)) break;
		result.push(...candidates(date).slice(0, max - result.length));
	}
	return result;
}

/** 기간 안의 일정을 날짜·시각 순으로 돌려준다. memberId를 주면 그 회원의 PT만 남긴다 */
export function listAppointments(
	appointments: Appointment[],
	filter: { from: string; to: string; memberId?: string },
): Appointment[] {
	assertValidDate(filter.from);
	assertValidDate(filter.to);
	return appointments
		.filter((a) => a.date >= filter.from && a.date <= filter.to)
		// 빈 문자열도 '그 id로 거르기'로 본다. 거짓 값 검사로 쓰면 ''일 때 모든 회원 일정이 나간다
		.filter((a) => filter.memberId === undefined || a.memberId === filter.memberId)
		.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

export type MutationResult =
	| { ok: true; appointment: Appointment; next: Appointment[] }
	| { ok: false; availability: AvailabilityResult };

export function addAppointment(
	ctx: AvailabilityContext,
	input: {
		id: string;
		kind: AppointmentKind;
		title: string;
		memberId?: string;
		date: string;
		start: string;
		durationMinutes: number;
	},
): MutationResult {
	if (ctx.appointments.some((a) => a.id === input.id)) {
		throw new Error(`이미 있는 일정 id입니다: ${input.id}`);
	}
	if (input.kind === 'pt' && !input.memberId) {
		throw new Error('PT 일정에는 회원 id(memberId)가 필요합니다');
	}
	const availability = checkAvailability(ctx, {
		date: input.date,
		start: input.start,
		durationMinutes: input.durationMinutes,
		kind: input.kind,
	});
	if (!availability.available) return { ok: false, availability };

	const appointment: Appointment = {
		id: input.id,
		kind: input.kind,
		title: input.title,
		...(input.memberId ? { memberId: input.memberId } : {}),
		date: input.date,
		start: input.start,
		end: availability.requested.end,
		status: 'booked',
	};
	return { ok: true, appointment, next: [...ctx.appointments, appointment] };
}

/** 수업 길이는 그대로 두고 날짜·시작 시각만 옮긴다. 예약 상태인 일정만 옮길 수 있다 */
export function moveAppointment(
	ctx: AvailabilityContext,
	input: { id: string; date: string; start: string },
): MutationResult {
	const current = ctx.appointments.find((a) => a.id === input.id);
	if (!current) throw new Error(`일정을 찾을 수 없습니다: ${input.id}`);
	if (current.status !== 'booked') throw new Error(`이미 처리된 일정은 옮길 수 없습니다: ${input.id} (${current.status})`);
	// 시작했거나 끝난 수업을 옮기면 노쇼 차감을 피해 갈 수 있으므로 막는다
	if (ctx.now && toEpochMinutes(current.date, current.start) <= toEpochMinutes(ctx.now.date, ctx.now.time)) {
		throw new Error(
			`이미 시작한 일정은 옮길 수 없습니다 (${current.date} ${current.start}). PT라면 출석 또는 노쇼로 기록하세요 (record_attendance)`,
		);
	}

	const durationMinutes = toMinutes(current.end) - toMinutes(current.start);
	const availability = checkAvailability(ctx, {
		date: input.date,
		start: input.start,
		durationMinutes,
		ignoreId: current.id,
		kind: current.kind,
		excludeSlot: { date: current.date, start: current.start },
	});
	if (!availability.available) return { ok: false, availability };

	const appointment: Appointment = { ...current, date: input.date, start: input.start, end: availability.requested.end };
	return {
		ok: true,
		appointment,
		next: ctx.appointments.map((a) => (a.id === current.id ? appointment : a)),
	};
}
