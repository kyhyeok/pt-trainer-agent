'use agent';
import { useModel } from '@flue/runtime';

// Every exported capitalized function in a 'use agent' module is an agent,
// and the function's name is its durable identity. The return value is the
// agent's system prompt.
export function Hello() {
	// Cloudflare's built-in models need no API key — uncomment the AI binding
	// in wrangler.jsonc, then swap in e.g.
	// useModel('cloudflare/@cf/moonshotai/kimi-k2.6') to go keyless.
	useModel('anthropic/claude-haiku-4-5');
	return 'You are a helpful assistant. Keep replies short.';
}
