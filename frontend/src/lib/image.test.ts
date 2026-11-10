import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { MAX_EDGE, bytesToBase64, fitWithin, safeFilename } from './image.ts';

test('긴 변을 1600px 이하로 비율을 유지해 줄인다', () => {
	assert.deepEqual(fitWithin(4000, 3000), { width: 1600, height: 1200 });
	assert.deepEqual(fitWithin(3000, 4000), { width: 1200, height: 1600 });
	assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
	assert.deepEqual(fitWithin(1600, 1600), { width: 1600, height: 1600 });
	// 아주 길쭉한 사진도 0px이 되지 않는다
	assert.deepEqual(fitWithin(100_000, 10), { width: 1600, height: 1 });
	assert.equal(MAX_EDGE, 1600);
});

test('크기를 읽을 수 없으면 예외를 낸다', () => {
	for (const [w, h] of [[0, 10], [10, 0], [-1, 5], [Number.NaN, 5], [Number.POSITIVE_INFINITY, 5]]) {
		assert.throws(() => fitWithin(w, h));
	}
});

test('base64 변환은 Node Buffer와 같고, 큰 배열도 처리한다', () => {
	for (const size of [0, 1, 2, 3, 4, 0x8000 - 1, 0x8000, 0x8000 + 1, 300_000]) {
		const bytes = new Uint8Array(randomBytes(size));
		assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `size ${size}`);
	}
});

test('서버로 보낼 파일 이름은 안전한 글자만 남기고 .jpg를 붙인다', () => {
	assert.equal(safeFilename('IMG_0001.HEIC', 0), 'IMG_0001.jpg');
	assert.equal(safeFilename('점심 식단.png', 1), '점심-식단.jpg');
	assert.equal(safeFilename('../../etc/passwd', 0), 'passwd.jpg');
	assert.equal(safeFilename('C:\\Users\\me\\lunch.jpeg', 0), 'lunch.jpg');
	// 경로 구분자 앞에 줄바꿈이 있어도 마지막 구분자 뒤만 남긴다(교차검증 재현)
	assert.equal(safeFilename('a\n/b.png', 0), 'b.jpg');
	assert.equal(safeFilename('a\r\\b.png', 0), 'b.jpg');
	assert.equal(safeFilename('a\u2028/b.png', 0), 'b.jpg');
	assert.equal(safeFilename('<script>.jpg', 2), 'script.jpg');
	assert.equal(safeFilename('.jpg', 2), 'photo-3.jpg');
	assert.equal(safeFilename('', 0), 'photo-1.jpg');
	assert.ok(safeFilename('a'.repeat(200), 0).length <= 44);
	// 40글자로 자를 때 이모지·수학 문자 같은 서러게이트 쌍을 가르지 않는다(재검토 재현)
	const cut = safeFilename(`a${'𝐀'.repeat(30)}.png`, 0);
	assert.ok(cut.isWellFormed(), JSON.stringify(cut));
	assert.equal(cut, `a${'𝐀'.repeat(30)}.jpg`);
	// 이모지는 글자·숫자가 아니라서 지워진다
	assert.equal(safeFilename('😀'.repeat(50), 0), 'photo-1.jpg');
	assert.equal(safeFilename(`${'가'.repeat(39)}𝐀𝐀.png`, 0), `${'가'.repeat(39)}𝐀.jpg`);
});
