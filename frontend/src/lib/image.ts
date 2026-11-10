// 첨부 사진을 브라우저에서 JPEG로 다시 만든다.
// 서버(attachments.ts)는 사진의 머리·꼬리 바이트만 검사하므로 중간이 깨진 파일은 통과한다.
// 브라우저가 실제로 디코딩해 새 JPEG로 그려 보내면, 모델에는 항상 읽을 수 있는 사진만 간다.
// 덤으로 긴 변을 1600px로 줄여 전송 크기와 처리 시간을 줄이고, 사진 속 위치 정보(EXIF)도 떨어져 나간다.

export const MAX_IMAGES = 4;
export const MAX_EDGE = 1600;
/** 서버 상한(backend/src/attachments.ts의 MAX_IMAGE_BASE64_CHARS)과 같다 */
export const MAX_BASE64_CHARS = 7_000_000;
/** 원본 파일 크기 상한. 이보다 크면 디코딩 전에 거절한다 */
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
/** 픽셀 수 상한(약 5천만 화소). 작은 파일에 거대한 해상도를 넣은 사진으로 탭이 멈추는 것을 막는다 */
export const MAX_SOURCE_PIXELS = 50_000_000;

export interface PreparedImage {
	/** data URL 접두사 없는 표준 base64 */
	data: string;
	mimeType: 'image/jpeg';
	filename: string;
	width: number;
	height: number;
}

/** 긴 변이 maxEdge를 넘지 않게 비율을 유지해 줄인 크기. 작으면 그대로 둔다 */
export function fitWithin(width: number, height: number, maxEdge: number = MAX_EDGE): { width: number; height: number } {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new Error('사진 크기를 읽을 수 없습니다');
	}
	const scale = Math.min(1, maxEdge / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** 바이트 배열을 표준 base64로 바꾼다. 큰 배열에서 인자 개수 한도를 넘지 않게 나눠서 처리한다 */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** 서버로 보낼 파일 이름. 원래 이름(경로는 뗌)에서 글자·숫자·-·_만 남겨 40글자까지 쓰고 .jpg를 붙인다 */
export function safeFilename(original: string, index: number): string {
	const cleaned = original
		.replace(/^[\s\S]*[/\\]/, '') // 줄바꿈이 섞여도 마지막 경로 구분자 뒤만 남긴다
		.replace(/\.[^.]*$/, '')
		.replace(/[^\p{L}\p{N}_-]+/gu, '-')
		.replace(/^-+|-+$/g, '');
	// 글자(코드 포인트) 단위로 자른다. UTF-16 단위로 자르면 이모지 같은 서러게이트 쌍이 갈라진다
	const stem = Array.from(cleaned).slice(0, 40).join('');
	return `${stem || `photo-${index + 1}`}.jpg`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.decoding = 'async';
		img.onload = () => resolve(img);
		img.onerror = () =>
			reject(new Error('사진을 읽을 수 없습니다. 손상됐거나, 해상도가 너무 크거나, 이 브라우저가 지원하지 않는 형식입니다(아이폰 HEIC는 JPEG로 바꿔 주세요)'));
		img.src = url;
	});
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		const failed = () => reject(new Error('사진을 JPEG로 바꾸지 못했습니다'));
		try {
			canvas.toBlob((blob) => (blob ? resolve(blob) : failed()), 'image/jpeg', quality);
		} catch {
			// 브라우저 보안 오류(SecurityError 등)의 영어 원문 대신 안내 문구를 보여 준다
			failed();
		}
	});
}

/** 사진 파일 하나를 읽어 긴 변 1600px 이하의 JPEG(base64)로 다시 만든다 */
export async function reencodeToJpeg(file: File, index: number): Promise<PreparedImage> {
	if (file.size === 0) throw new Error('빈 파일입니다');
	if (file.size > MAX_SOURCE_BYTES) throw new Error('사진 파일이 너무 큽니다(30MB 이하)');
	if (file.type && !file.type.startsWith('image/')) throw new Error('사진 파일만 첨부할 수 있습니다');
	// SVG는 사진이 아니라 그림 문서다. 캔버스로 옮기면 브라우저가 내보내기를 막는다
	if (file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name)) throw new Error('SVG 그림은 보낼 수 없습니다. 사진(JPEG·PNG·WebP)을 보내 주세요');

	const objectUrl = URL.createObjectURL(file);
	try {
		const img = await loadImage(objectUrl);
		// naturalWidth/Height는 EXIF 회전이 반영된 크기다(최신 브라우저의 image-orientation 기본값)
		const sourceWidth = img.naturalWidth;
		const sourceHeight = img.naturalHeight;
		if (sourceWidth * sourceHeight > MAX_SOURCE_PIXELS) throw new Error('사진 해상도가 너무 큽니다');
		const { width, height } = fitWithin(sourceWidth, sourceHeight);
		await img.decode().catch(() => {
			throw new Error('사진을 디코딩하지 못했습니다. 손상된 파일일 수 있습니다');
		});

		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('이 브라우저에서는 사진을 처리할 수 없습니다');
		// 투명한 PNG가 JPEG에서 검게 나오지 않도록 흰 바탕을 깐다
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, width, height);
		context.drawImage(img, 0, 0, width, height);

		let blob = await canvasToJpeg(canvas, 0.85);
		let data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
		if (data.length > MAX_BASE64_CHARS) {
			blob = await canvasToJpeg(canvas, 0.6);
			data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
		}
		if (data.length > MAX_BASE64_CHARS) throw new Error('사진이 너무 큽니다');
		return { data, mimeType: 'image/jpeg', filename: safeFilename(file.name, index), width, height };
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}
