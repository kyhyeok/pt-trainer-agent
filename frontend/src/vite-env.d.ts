/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** 백엔드(에이전트) 주소. 생략하면 http://localhost:8787 */
	readonly VITE_AGENT_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
