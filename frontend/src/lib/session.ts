// 접속 정보(토큰, 대화 id)를 브라우저 탭 세션에만 둔다. 탭을 닫으면 사라진다.
// 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서도 화면이 동작하도록 실패는 무시한다.

const TOKEN_KEY = 'pt-trainer.token';
const CONVERSATION_KEY = 'pt-trainer.conversation';

function read(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value === null) sessionStorage.removeItem(key);
		else sessionStorage.setItem(key, value);
	} catch {
		// 저장하지 못하면 이 탭에서 새로 고칠 때 다시 입력하면 된다
	}
}

export const session = {
	token: () => read(TOKEN_KEY),
	conversationId: () => read(CONVERSATION_KEY),
	save(token: string, conversationId: string) {
		write(TOKEN_KEY, token);
		write(CONVERSATION_KEY, conversationId);
	},
	saveConversation(conversationId: string) {
		write(CONVERSATION_KEY, conversationId);
	},
	clearToken() {
		write(TOKEN_KEY, null);
	},
};
