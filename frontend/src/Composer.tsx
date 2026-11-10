// 입력창: 글, 사진 첨부(파일 선택·붙여 넣기·끌어다 놓기), 보내기.
// 입력 상태를 채팅 화면과 분리해, 글자를 칠 때마다 긴 대화 전체가 다시 그려지지 않게 한다(적대적 리뷰 실측: 150쌍에서 키 입력당 100ms 이상).

import type { DeliveredImageAttachment } from '@flue/react';
import { type ClipboardEvent, type KeyboardEvent, type Ref, type SubmitEvent, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { MAX_IMAGES, type PreparedImage, reencodeToJpeg } from './lib/image.ts';

export interface ComposerHandle {
	/** 예시 문장을 입력창에 넣고 커서를 옮긴다 */
	fill(text: string): void;
}

interface Props {
	ref?: Ref<ComposerHandle>;
	/** 대화 기록을 다 불러와 보낼 수 있는 상태인지 */
	ready: boolean;
	/** 메시지를 보낸다. 접수되지 않으면 예외를 던진다 */
	onSend: (text: string, images: DeliveredImageAttachment[], idempotencyKey: string) => Promise<void>;
	describeError: (error: unknown) => string;
}

interface PendingImage {
	id: string;
	prepared: PreparedImage;
}

export function Composer({ ref, ready, onSend, describeError }: Props) {
	const [input, setInput] = useState('');
	const [images, setImages] = useState<PendingImage[]>([]);
	const [processing, setProcessing] = useState(0);
	/** 사진 처리 오류. 여러 장을 한꺼번에 넣으면 장마다 이유가 다를 수 있어 모두 보여 준다 */
	const [imageErrors, setImageErrors] = useState<string[]>([]);
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const textArea = useRef<HTMLTextAreaElement>(null);

	useImperativeHandle(ref, () => ({
		fill(text: string) {
			setInput(text);
			textArea.current?.focus();
		},
	}));

	// ── 사진: 한 번에 한 장씩, 고른 순서대로 처리한다 ─────────────
	const queue = useRef<Promise<void>>(Promise.resolve());
	/** 처리 중이거나 처리 대기 중인 장수(상태 갱신보다 먼저 동기적으로 센다) */
	const reserved = useRef(0);
	const nameIndex = useRef(0);

	function addFiles(files: File[]) {
		if (files.length === 0) return;
		// 보내는 동안 바뀐 내용은 실패 뒤 되돌릴 때 섞이거나 사라지고, 재전송 키도 달라진다. 그래서 보내는 동안은 잠근다
		if (sending) {
			setImageErrors(['보내는 중에는 사진을 추가할 수 없습니다. 보내기가 끝난 뒤 다시 넣어 주세요']);
			return;
		}
		const room = Math.max(0, MAX_IMAGES - images.length - reserved.current);
		setImageErrors(files.length > room ? [`사진은 한 번에 ${MAX_IMAGES}장까지 보낼 수 있습니다`] : []);
		const accepted = files.slice(0, room);
		if (accepted.length === 0) return;
		reserved.current += accepted.length;
		setProcessing(reserved.current);
		queue.current = queue.current.then(async () => {
			for (const file of accepted) {
				try {
					const prepared = await reencodeToJpeg(file, nameIndex.current++);
					setImages((previous) => (previous.length >= MAX_IMAGES ? previous : [...previous, { id: crypto.randomUUID(), prepared }]));
				} catch (error) {
					setImageErrors((previous) => [...previous, `${file.name || '사진'}: ${describeError(error)}`]);
				} finally {
					reserved.current -= 1;
					setProcessing(reserved.current);
				}
			}
		});
	}

	// 사진을 화면에 끌어다 놓으면 브라우저가 파일을 열며 이 화면을 떠나지 않도록 막고, 첨부로 받는다
	const addFilesRef = useRef(addFiles);
	useEffect(() => {
		addFilesRef.current = addFiles;
	});
	useEffect(() => {
		const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
		const onDragOver = (event: DragEvent) => {
			if (hasFiles(event)) event.preventDefault();
		};
		const onDrop = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			addFilesRef.current(Array.from(event.dataTransfer?.files ?? []));
		};
		window.addEventListener('dragover', onDragOver);
		window.addEventListener('drop', onDrop);
		return () => {
			window.removeEventListener('dragover', onDragOver);
			window.removeEventListener('drop', onDrop);
		};
	}, []);

	function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
		const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
		if (files.length === 0) return;
		// 글도 함께 들어 있으면(웹 페이지에서 복사한 경우 등) 글은 그대로 붙여 넣는다
		if (!event.clipboardData.types.includes('text/plain')) event.preventDefault();
		addFiles(files);
	}

	// ── 보내기 ─────────────────────────────────────────
	const canSend = ready && !sending && processing === 0 && (input.trim() !== '' || images.length > 0);
	/** 연타 방지: 상태 갱신(다음 렌더)보다 먼저 동기적으로 막는다 */
	const sendLock = useRef(false);
	/**
	 * 접수 응답을 못 받은 전송을 같은 내용으로 다시 보낼 때 쓰는 키. 응답만 끊기고 서버는 접수했을 수 있으므로,
	 * 같은 키로 보내야 서버가 한 번만 처리한다. 내용이 바뀌면 새 키를 쓴다(같은 키에 다른 내용은 409).
	 */
	const retry = useRef<{ key: string; signature: string } | null>(null);

	async function send() {
		if (sendLock.current || !canSend) return;
		sendLock.current = true;
		const text = input.trim() || '식단 사진입니다.';
		const attachments: DeliveredImageAttachment[] = images.map(({ prepared }) => ({ type: 'image', data: prepared.data, mimeType: prepared.mimeType, filename: prepared.filename }));
		const signature = JSON.stringify([text, images.map((image) => image.id)]);
		const key = retry.current?.signature === signature ? retry.current.key : `send-${crypto.randomUUID()}`;
		retry.current = { key, signature };
		const savedInput = input;
		const savedImages = images;
		setSending(true);
		setSendError(null);
		setInput('');
		setImages([]);
		try {
			await onSend(text, attachments, key);
			retry.current = null;
			setImageErrors([]);
		} catch (error) {
			// 보내지 못한 글과 사진은 입력창에 되돌려 다시 보낼 수 있게 한다(보내는 동안은 입력창이 잠겨 있어 덮어쓸 것이 없다)
			setSendError(describeError(error));
			setInput(savedInput);
			setImages(savedImages);
		} finally {
			sendLock.current = false;
			setSending(false);
		}
	}

	function onSubmit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		void send();
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		// 한글 조합 중의 Enter는 글자 확정이므로 보내지 않는다(keyCode 229는 조합 중인 키를 뜻하는 브라우저 관례)
		if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		void send();
	}

	// 입력창 높이를 글 길이에 맞춘다(최대 약 8줄)
	useEffect(() => {
		const element = textArea.current;
		if (!element) return;
		element.style.height = 'auto';
		element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
	}, [input]);

	return (
		<form onSubmit={onSubmit} className="border-t border-stone-200 bg-white">
			<div className="mx-auto w-full max-w-3xl space-y-2 px-4 py-3">
				{(images.length > 0 || processing > 0) && (
					<ul className="flex flex-wrap gap-2" aria-label="첨부할 사진">
						{images.map((image) => (
							<li key={image.id} className="relative">
								<img src={`data:image/jpeg;base64,${image.prepared.data}`} alt={image.prepared.filename} className="size-16 rounded-lg border border-stone-200 object-cover" />
								<button
									type="button"
									aria-label={`${image.prepared.filename} 빼기`}
									onClick={() => setImages((previous) => previous.filter((item) => item.id !== image.id))}
									className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-stone-800 text-xs text-white"
								>
									×
								</button>
							</li>
						))}
						{processing > 0 && <li className="flex size-16 items-center justify-center rounded-lg border border-dashed border-stone-300 text-xs text-stone-500">처리 중…</li>}
					</ul>
				)}
				{imageErrors.length > 0 && (
					<ul role="alert" className="space-y-0.5 text-sm break-words text-red-700">
						{imageErrors.map((message, index) => (
							<li key={index}>{message}</li>
						))}
					</ul>
				)}
				{sendError && (
					<p role="alert" className="text-sm break-words text-red-700">
						보내지 못했습니다: {sendError}
					</p>
				)}

				<div className="flex items-end gap-2 rounded-2xl border border-stone-300 bg-white p-2 focus-within:border-emerald-600 focus-within:ring-2 focus-within:ring-emerald-600/15">
					<input
						ref={fileInput}
						type="file"
						accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif"
						multiple
						hidden
						onChange={(event) => {
							const files = Array.from(event.target.files ?? []);
							event.target.value = '';
							addFiles(files);
						}}
					/>
					<button
						type="button"
						onClick={() => fileInput.current?.click()}
						disabled={sending || images.length + processing >= MAX_IMAGES}
						aria-label="사진 첨부"
						title="식단 사진 첨부(최대 4장, 붙여 넣기·끌어다 놓기 가능)"
						className="flex size-10 shrink-0 items-center justify-center rounded-xl text-stone-500 hover:bg-stone-100 disabled:opacity-40"
					>
						<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-5">
							<path d="M4 7h3l2-2h6l2 2h3v12H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
						</svg>
					</button>
					<label htmlFor="message" className="sr-only">
						메시지
					</label>
					<textarea
						id="message"
						ref={textArea}
						rows={1}
						value={input}
						readOnly={sending}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
						placeholder="메시지를 입력하세요"
						className="max-h-[200px] min-h-10 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-6 outline-none placeholder:text-stone-400"
					/>
					<button
						type="submit"
						disabled={!canSend}
						aria-label="보내기"
						className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-700 text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"
					>
						<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="size-5">
							<path d="M12 19V5m0 0-6 6m6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
						</svg>
					</button>
				</div>
				<p className="text-[11px] text-stone-400">Enter 보내기 · Shift+Enter 줄바꿈 · 회원에게 보낼 글은 모두 초안입니다. 검토 후 직접 보내세요.</p>
			</div>
		</form>
	);
}
