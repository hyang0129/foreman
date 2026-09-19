// Both ends enforce the same narrow tunnel contract. No arbitrary URL or headers.
export const MAX_BODY = 128 * 1024;
export const MAX_RESPONSE = 4 * 1024 * 1024;
// JSON bodies are serialized a second time inside the WebSocket envelope.
export const MAX_REQUEST_FRAME = MAX_BODY * 6 + 32_768;
export const MAX_RESPONSE_FRAME = MAX_RESPONSE * 6 + 65_536;
const routes: Record<string, readonly string[]> = {
  GET: ['/api/projects', '/api/models', '/api/health', '/api/host', '/api/sessions', '/api/session', '/api/session/tail', '/api/pm/history', '/api/memory'],
  POST: ['/api/projects/resolve', '/api/projects/register', '/api/projects/update', '/api/projects/remove', '/api/pm/model', '/api/sessions', '/api/session/message', '/api/session/interrupt', '/api/session/approval', '/api/pm/message', '/api/pm/interrupt'],
};
export function allowedRequest(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'POST') return false;
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('#') || path.length > 4096) return false;
  const url = new URL(path, 'http://relay.invalid');
  return url.origin === 'http://relay.invalid' && Boolean(routes[method]?.includes(url.pathname));
}
export interface RelayRequest { type: 'request'; id: string; method: string; path: string; body?: string }
export interface RelayResponse { type: 'response'; id: string; status: number; body: string }
