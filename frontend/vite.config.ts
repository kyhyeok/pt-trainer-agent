import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 백엔드 CORS(wrangler.jsonc의 ALLOWED_ORIGIN)가 http://localhost:5173만 허용하므로 주소와 포트를 고정한다.
// 다른 포트로 바뀌어 뜨면 요청이 모두 CORS로 막히므로, 포트가 사용 중이면 다른 포트로 넘어가지 않고 실패하게 한다.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: { host: 'localhost', port: 5173, strictPort: true },
	preview: { host: 'localhost', port: 5173, strictPort: true },
});
