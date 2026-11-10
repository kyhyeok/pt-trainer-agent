// 첨부 이미지 검사. 에이전트(Flue)에 넘기기 전에 app.ts에서 막는다.
// 실측한 문제 두 가지를 막기 위해서다.
// 1. base64가 잘못되면(data URL 접두사, URL-safe 문자) Flue가 500을 내고, 그 뒤 같은 대화의 메시지가 처리되지 않고 멈춘다.
// 2. 모델이 읽지 못하는 이미지(텍스트 바이트, HEIC 등)가 대화 기록에 남으면, 이후 사진을 보낼 때마다 그 이미지가 다시 전송돼 계속 실패한다.

export const MAX_IMAGES = 4;
/** base64 글자 수 상한(약 5MB). Flue 상한(14 MiB)보다 작게 잡아 사진 처리 시간이 지나치게 길어지지 않게 한다 */
export const MAX_IMAGE_BASE64_CHARS = 7_000_000;

/** 형식별 파일 앞부분 바이트(매직 바이트). offset 위치부터 bytes와 같아야 한다 */
const SIGNATURES: Record<string, { offset: number; bytes: number[] }[]> = {
	'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
	'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
	'image/webp': [
		{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF'
		{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // 'WEBP'
	],
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type AttachmentCheck = { ok: true } | { ok: false; reason: string };

function fail(reason: string): AttachmentCheck {
	return { ok: false, reason };
}

/** base64 앞부분만 디코딩해 첫 바이트들을 얻는다(24글자 = 18바이트) */
function headBytes(data: string): number[] {
	const head = atob(data.slice(0, 24));
	return Array.from(head, (ch) => ch.charCodeAt(0));
}

/** base64 끝부분만 디코딩해 마지막 count바이트를 얻는다. 전체 길이가 4의 배수라 끝에서 4글자 단위로 자르면 경계가 맞는다 */
function tailBytes(data: string, count: number): number[] {
	const chars = Math.ceil((count + 2) / 3) * 4;
	const tail = atob(data.slice(-chars));
	return Array.from(tail, (ch) => ch.charCodeAt(0)).slice(-count);
}

function byteLength(data: string): number {
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
	return (data.length / 4) * 3 - padding;
}

const PNG_IEND = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

/**
 * 파일 끝이 형식에 맞는지 본다. 머리 바이트만 맞추고 뒤가 잘리거나 쓰레기인 파일을 거른다(적대적 리뷰에서 재현).
 * 중간이 깨진 파일까지 잡으려면 실제 디코딩이 필요하므로, 화면(프런트엔드)에서 사진을 JPEG로 다시 만들어 보내는 것으로 보완한다.
 */
function hasValidEnding(mimeType: string, data: string, head: number[]): boolean {
	if (mimeType === 'image/jpeg') {
		const [a, b] = tailBytes(data, 2);
		return a === 0xff && b === 0xd9; // EOI
	}
	if (mimeType === 'image/png') {
		const tail = tailBytes(data, PNG_IEND.length);
		return PNG_IEND.every((byte, i) => tail[i] === byte);
	}
	// WebP: RIFF 크기(4~7바이트, 리틀 엔디언) + 8 = 파일 전체 길이
	const riffSize = (head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24)) >>> 0;
	return riffSize + 8 === byteLength(data);
}

export function validateAttachments(attachments: unknown): AttachmentCheck {
	if (attachments === undefined) return { ok: true };
	if (!Array.isArray(attachments)) return fail('attachments는 배열이어야 합니다');
	if (attachments.length > MAX_IMAGES) return fail(`사진은 한 번에 ${MAX_IMAGES}장까지 보낼 수 있습니다`);

	for (const [index, item] of attachments.entries()) {
		const label = `${index + 1}번째 첨부`;
		if (!item || typeof item !== 'object') return fail(`${label}의 형식이 잘못되었습니다`);
		const { type, mimeType, data } = item as { type?: unknown; mimeType?: unknown; data?: unknown };
		if (type !== 'image') return fail(`${label}: 이미지만 첨부할 수 있습니다`);
		if (typeof mimeType !== 'string' || !(mimeType in SIGNATURES)) {
			return fail(`${label}: JPEG, PNG, WebP 사진만 받을 수 있습니다(받은 형식: ${String(mimeType)}). 아이폰 HEIC 사진은 JPEG로 바꿔 보내 주세요`);
		}
		if (typeof data !== 'string' || data.length < 24) return fail(`${label}: 이미지 데이터가 비어 있거나 너무 짧습니다`);
		if (data.length > MAX_IMAGE_BASE64_CHARS) return fail(`${label}: 사진이 너무 큽니다(약 5MB 이하로 줄여 주세요)`);
		if (data.length % 4 !== 0 || !BASE64.test(data)) {
			return fail(`${label}: 표준 base64 문자열이어야 합니다(data URL 접두사 없이)`);
		}
		const bytes = headBytes(data);
		const matches = SIGNATURES[mimeType].every((sig) => sig.bytes.every((b, i) => bytes[sig.offset + i] === b));
		if (!matches) return fail(`${label}: 파일 내용이 ${mimeType} 형식이 아닙니다`);
		if (!hasValidEnding(mimeType, data, bytes)) {
			return fail(`${label}: 사진 파일이 손상되었거나 잘렸습니다. 사진을 다시 저장해 보내 주세요`);
		}
	}
	return { ok: true };
}
