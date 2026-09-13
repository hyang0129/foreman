import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { FOREMAN_HOME, HOST } from './paths.ts';
import { allowedRequest, MAX_BODY, MAX_RESPONSE, MAX_REQUEST_FRAME, type RelayRequest } from '../shared/relay.ts';

export interface BridgeConfig { url: string; token: string }
export function readBridgeConfig(): BridgeConfig | null {
  if (Boolean(process.env.FOREMAN_RELAY_URL) !== Boolean(process.env.FOREMAN_HOST_TOKEN)) throw new Error('Set both FOREMAN_RELAY_URL and FOREMAN_HOST_TOKEN');
  if (process.env.FOREMAN_RELAY_URL && process.env.FOREMAN_HOST_TOKEN) return { url: process.env.FOREMAN_RELAY_URL, token: process.env.FOREMAN_HOST_TOKEN };
  const path = join(FOREMAN_HOME, 'cloud.json');
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('cloud.json must be an owned regular file with mode 0600');
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Invalid cloud.json'); }
  if (!config || typeof config.url !== 'string' || typeof config.token !== 'string') throw new Error('Invalid cloud.json');
  return config;
}

export class HostBridge {
  private socket?: WebSocket;
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private stopped = false;
  private started = false;
  private attempts = 0;
  private lastPong = 0;
  private inFlight = 0;
  private port: number;
  private config: BridgeConfig;
  private socketFactory: (url: URL, options: WebSocket.ClientOptions) => WebSocket;
  constructor(port: number, config: BridgeConfig, options: { socketFactory?: (url: URL, options: WebSocket.ClientOptions) => WebSocket } = {}) {
    this.port = port; this.config = config;
    this.socketFactory = options.socketFactory ?? ((url, options) => new WebSocket(url, options));
    const url = new URL(config.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Relay URL must be an HTTPS origin');
    if (typeof config.token !== 'string' || config.token.length < 32 || config.token.length > 512 || /\s/.test(config.token)) throw new Error('Invalid host token');
  }
  start() { if (!this.started && !this.stopped) { this.started = true; this.connect(); } return this; }
  private connect() {
    if (this.stopped) return;
    const url = new URL('/api/host/connect', this.config.url); url.protocol = 'wss:';
    const socket = this.socket = this.socketFactory(url, { headers: { authorization: `Bearer ${this.config.token}` }, maxPayload: MAX_REQUEST_FRAME, handshakeTimeout: 15_000 });
    socket.on('open', () => {
      this.attempts = 0; this.lastPong = Date.now();
      console.log('foreman: cloud relay connected');
      socket.send(JSON.stringify({ type: 'hello', host: HOST }));
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 60_000) { socket.terminate(); return; }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
    });
    socket.on('message', (raw, binary) => {
      if (binary) { socket.close(1003, 'Text required'); return; }
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1003, 'Invalid JSON'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(1003, 'Invalid message'); return; }
      if (message.type === 'pong') { this.lastPong = Date.now(); return; }
      if (message.type === 'request') void this.handle(message, socket).catch(() => socket.close(1011, 'Relay failed'));
    });
    socket.on('error', () => { /* close schedules reconnect; never log credentials/handshake headers */ });
    socket.on('close', () => {
      clearInterval(this.heartbeat);
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)) + Math.random() * 1000;
      this.reconnect = setTimeout(() => this.connect(), delay);
    });
  }
  private async handle(message: RelayRequest, socket: WebSocket) {
    const reply = (status: number, body: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'response', id: message.id, status, body }));
    };
    if (typeof message.id !== 'string' || message.id.length > 100) { socket.close(1003, 'Invalid request'); return; }
    if (!allowedRequest(message.method, message.path) || (message.body !== undefined && typeof message.body !== 'string') ||
        Buffer.byteLength(message.body ?? '') > MAX_BODY) { reply(400, JSON.stringify({ error: 'Invalid relay request' })); return; }
    if (this.inFlight >= 64) { reply(429, JSON.stringify({ error: 'Host is busy' })); return; }
    this.inFlight++;
    try {
      const origin = `http://127.0.0.1:${this.port}`;
      const response = await fetch(origin + message.path, {
        method: message.method,
        headers: { 'content-type': 'application/json', origin },
        ...(message.method === 'POST' ? { body: message.body || '{}' } : {}),
        redirect: 'error', signal: AbortSignal.timeout(40_000),
      });
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error('Response too large'); }
        chunks.push(value);
      }
      reply(response.status, Buffer.concat(chunks).toString('utf8'));
    } catch { reply(502, JSON.stringify({ error: 'Local host request failed; refresh to check whether work was accepted before retrying.' })); }
    finally { this.inFlight--; }
  }
  close() { this.stopped = true; clearTimeout(this.reconnect); clearInterval(this.heartbeat); this.socket?.close(1000, 'Host stopping'); }
}

export function startHostBridge(port: number): { close(): void } {
  try { const config = readBridgeConfig(); return config ? new HostBridge(port, config).start() : { close() {} }; }
  catch (error) { console.error('foreman: cloud bridge configuration error:', (error as Error).message); return { close() {} }; }
}
