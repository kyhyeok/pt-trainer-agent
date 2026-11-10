// 첨부 이미지 검사 테스트. 실행: npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_IMAGES, MAX_IMAGE_BASE64_CHARS, validateAttachments } from './attachments.ts';

const body = new Array(32).fill(0x11);
const b64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString('base64');
// 머리(매직 바이트)와 꼬리(끝 표시)가 모두 맞는 최소 파일
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, ...body, 0xff, 0xd9];
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...body, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const webpBytes = (declared: number) => {
	const total = 12 + body.length;
	const size = declared ?? total - 8;
	return [0x52, 0x49, 0x46, 0x46, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff, 0x57, 0x45, 0x42, 0x50, ...body];
};
const JPEG = b64(JPEG_BYTES);
const PNG = b64(PNG_BYTES);
const WEBP = b64(webpBytes(12 + body.length - 8));
const image = (mimeType: string, data: string) => ({ type: 'image', mimeType, data, filename: 'meal' });

describe('validateAttachments', () => {
	test('첨부가 없으면 통과한다', () => {
		assert.equal(validateAttachments(undefined).ok, true);
	});

	test('JPEG·PNG·WebP는 형식과 내용이 맞으면 통과한다', () => {
		assert.equal(validateAttachments([image('image/jpeg', JPEG), image('image/png', PNG), image('image/webp', WEBP)]).ok, true);
	});

	test('data URL 접두사나 URL-safe base64는 막는다 (Flue가 500을 내고 대화가 멈추는 입력)', () => {
		assert.equal(validateAttachments([image('image/jpeg', `data:image/jpeg;base64,${JPEG}`)]).ok, false);
		assert.equal(validateAttachments([image('image/jpeg', JPEG.replaceAll('+', '-').replaceAll('/', '_') + '-_')]).ok, false);
		assert.equal(validateAttachments([image('image/jpeg', JPEG.slice(0, -1))]).ok, false, 'base64 길이가 4의 배수가 아님');
	});

	test('내용이 선언한 형식과 다르면 막는다 (모델이 읽지 못해 대화의 사진 기능이 망가지는 입력)', () => {
		assert.equal(validateAttachments([image('image/jpeg', Buffer.from('hello, this is not an image').toString('base64'))]).ok, false);
		assert.equal(validateAttachments([image('image/jpeg', PNG)]).ok, false);
		assert.equal(validateAttachments([image('image/png', JPEG)]).ok, false);
	});

	test('머리 바이트만 맞고 끝이 잘리거나 뒤가 쓰레기인 파일은 막는다 (적대적 리뷰 재현: 검사 통과 후 대화의 사진 기능이 망가짐)', () => {
		const fakeJpeg = b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, ...Array.from(Buffer.from('this is not really an image body...'))]);
		assert.equal(validateAttachments([image('image/jpeg', fakeJpeg)]).ok, false);
		assert.equal(validateAttachments([image('image/png', b64(PNG_BYTES.slice(0, -4)))]).ok, false, 'IEND가 잘린 PNG');
		assert.equal(validateAttachments([image('image/webp', b64(webpBytes(999)))]).ok, false, 'RIFF 크기와 실제 길이가 다른 WebP');
	});

	test('base64 패딩이 있어도 끝 검사가 정확하다', () => {
		for (const extra of [0, 1, 2]) {
			const bytes = [0xff, 0xd8, 0xff, 0xe0, ...body, ...new Array(extra).fill(0x22), 0xff, 0xd9];
			assert.equal(validateAttachments([image('image/jpeg', b64(bytes))]).ok, true, `추가 ${extra}바이트`);
		}
	});

	test('지원하지 않는 형식(HEIC 등)과 이미지가 아닌 첨부는 막는다', () => {
		const heic = validateAttachments([image('image/heic', JPEG)]);
		assert.equal(heic.ok, false);
		if (!heic.ok) assert.match(heic.reason, /JPEG|PNG|WebP/);
		assert.equal(validateAttachments([{ type: 'document', mimeType: 'application/pdf', data: JPEG }]).ok, false);
	});

	test('개수와 크기 상한을 넘으면 막는다', () => {
		assert.equal(validateAttachments(Array.from({ length: MAX_IMAGES + 1 }, () => image('image/jpeg', JPEG))).ok, false);
		const huge = JPEG + 'A'.repeat(MAX_IMAGE_BASE64_CHARS - JPEG.length + 4);
		assert.equal(validateAttachments([image('image/jpeg', huge)]).ok, false);
	});

	test('배열이 아니거나 모양이 잘못된 첨부는 막는다', () => {
		assert.equal(validateAttachments('nope').ok, false);
		assert.equal(validateAttachments([null]).ok, false);
		assert.equal(validateAttachments([{ type: 'image', mimeType: 'image/jpeg' }]).ok, false);
	});
});
