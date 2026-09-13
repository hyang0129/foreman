import { DurableObject } from 'cloudflare:workers';
import { verifyUser, validHostToken } from './auth.ts';
import { allowedRequest, MAX_BODY, MAX_RESPONSE, MAX_RESPONSE_FRAME, type RelayResponse } from '../shared/relay.ts';

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({ auth: { required: true, firebase: JSON.parse(env.FIREBASE_CONFIG) } });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set('x-content-type-options', 'nosniff');
      response.headers.set('referrer-policy', 'same-origin');
      response.headers.set('content-security-policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
      return response;
    }
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? '';
    if (url.pathname === '/api/host/connect') {
      if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 400);
      if (!await validHostToken(token, env.HOST_TOKEN)) return json({ error: 'Unauthorized host' }, 401);
    } else {
      if (!token) return json({ error: 'Sign in with Google' }, 401);
      try { await verifyUser(token, env.FIREBASE_PROJECT_ID, env.ALLOWED_EMAIL); }
      catch { return json({ error: 'Sign in with the allowed Google account' }, 403); }
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'Origin not allowed' }, 403);
      if (!allowedRequest(request.method, url.pathname + url.search)) return json({ error: 'Unknown API route' }, 404);
    }
    // This MVP has one explicitly allowlisted owner and one Mac.
    return env.RELAY.get(env.RELAY.idFromName(env.ALLOWED_EMAIL)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

type Pending = { socket: WebSocket; resolve: (response: Response) => void; timer: ReturnType<typeof setTimeout> };
type Attachment = { host: string; lastSeen: number };

export class HostRelay extends DurableObject<Env> {
  private pending = new Map<string, Pending>();
  private hostSocket() {
    return this.ctx.getWebSockets('host').find((socket) => {
      const state = socket.deserializeAttachment() as Attachment;
      return socket.readyState === 1 && state && Date.now() - state.lastSeen < 65_000;
    });
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/host/connect') {
      // Defense in depth: bindings are private, but authentication is checked here too.
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (!await validHostToken(token, this.env.HOST_TOKEN)) return json({ error: 'Unauthorized host' }, 401);
      for (const previous of this.ctx.getWebSockets('host')) { this.failPending(previous); previous.close(1000, 'Host reconnected'); }
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server!, ['host']);
      server!.serializeAttachment({ host: 'Mac', lastSeen: Date.now() } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    const socket = this.hostSocket();
    if (url.pathname === '/api/host') return json({ online: Boolean(socket), host: socket?.deserializeAttachment()?.host ?? 'Mac' });
    if (!socket) return json({ error: 'Your Mac is offline. Open Foreman on the Mac and reconnect.' }, 503);
    if (this.pending.size >= 64) return json({ error: 'Host is busy; try again shortly' }, 429);
    if (!allowedRequest(request.method, url.pathname + url.search)) return json({ error: 'Unknown API route' }, 404);
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'Request too large' }, 413);
    let body = '';
    if (request.body) {
      const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > MAX_BODY) { await reader.cancel(); return json({ error: 'Request too large' }, 413); }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      body = new TextDecoder().decode(bytes);
    }
    const id = crypto.randomUUID();
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(json({ error: 'Host response timed out; delivery is uncertain. Refresh to check the receipt before retrying.' }, 504));
      }, 45_000);
      this.pending.set(id, { socket, resolve, timer });
      try { socket.send(JSON.stringify({ type: 'request', id, method: request.method, path: url.pathname + url.search, body })); }
      catch { clearTimeout(timer); this.pending.delete(id); resolve(json({ error: 'Host disconnected; refresh before retrying' }, 503)); }
    });
  }
  webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > MAX_RESPONSE_FRAME) { socket.close(1009, 'Invalid frame'); this.failPending(socket); return; }
    let message: any;
    try { message = JSON.parse(raw); } catch { socket.close(1003, 'Invalid JSON'); this.failPending(socket); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(1003, 'Invalid message'); this.failPending(socket); return; }
    if (message.type === 'ping' || message.type === 'hello') {
      const previous = socket.deserializeAttachment() as Attachment;
      socket.serializeAttachment({ host: typeof message.host === 'string' ? message.host.slice(0, 100) : previous.host, lastSeen: Date.now() });
      socket.send(JSON.stringify({ type: 'pong' })); return;
    }
    if (message.type !== 'response') return;
    const reply = message as RelayResponse;
    const pending = this.pending.get(reply.id);
    if (!pending || pending.socket !== socket) return;
    this.pending.delete(reply.id); clearTimeout(pending.timer);
    if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 || typeof reply.body !== 'string' || new TextEncoder().encode(reply.body).byteLength > MAX_RESPONSE) {
      pending.resolve(json({ error: 'Invalid host response' }, 502)); return;
    }
    pending.resolve(new Response([204, 205, 304].includes(reply.status) ? null : reply.body, { status: reply.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }));
  }
  private failPending(socket: WebSocket) {
    for (const [id, item] of this.pending) if (item.socket === socket) {
      clearTimeout(item.timer); this.pending.delete(id);
      item.resolve(json({ error: 'Host disconnected; delivery may be uncertain. Refresh before retrying.' }, 503));
    }
  }
  webSocketClose(socket: WebSocket) { this.failPending(socket); socket.close(); }
  webSocketError(socket: WebSocket) { this.failPending(socket); socket.close(1011, 'Connection failed'); }
}
