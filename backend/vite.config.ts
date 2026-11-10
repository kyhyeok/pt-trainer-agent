import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
	server: {
		// 프런트엔드(5173)와 겹치지 않도록 백엔드는 8787을 쓴다
		port: 8787,
		strictPort: true,
		// Vite 기본 CORS를 끄고 app.ts의 Hono CORS만 쓰게 해, 로컬에서도 배포와 같은 동작을 확인한다
		cors: false,
		// 개발 서버가 인증 없이 파일을 내주지 않도록 비밀값·도구 상태 파일을 막는다(Vite 기본 목록에 추가)
		fs: {
			deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.dev.vars*', '**/.omc/**', '**/.wrangler/**'],
		},
	},
});
