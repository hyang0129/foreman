// Lead registry, handoffs and developer settings in the relay Durable Object (#157 CL-02, #167; the
// storage half of #158), exercised through the real Worker and HostRelay with real WebSocket pairs.
// Most tests connect two protocol-2 machines: "machine-a" (the PM host, by bootstrap) and
// "machine-b" (a standby), because lead_rpc is accepted from any identified machine.
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { MAX_SETTINGS_BODY, type HostRelay } from '../worker.ts';
import { allowedRequest } from '../../shared/relay.ts';
import { utf8Length } from '../../shared/notify.ts';
import {
  DEFAULT_BYPASS_GRANTS, MAX_HANDOFFS_KEPT, MAX_LEAD_FRAME, MAX_LEAD_RESULT_FRAME, MAX_LEAD_ROWS,
  parseDevSettingsView, parseLeadListEntry, parseLeadOpResult, parseLeadRpcResult,
  type LeadOp, type LeadsResponse, type SettingsResponse,
} from '../../shared/roles.ts';

const ORIGIN = 'https://foreman.test';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

// ---- identity (real bearer verification against a locally generated JWKS) -------------------
let signingKey: CryptoKey, jwks: unknown;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: 'leads-test', alg: 'RS256', use: 'sig' }] };
});
async function idToken(email: string = env.ALLOWED_EMAIL) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, email_verified: true, firebase: { sign_in_provider: 'google.com' }, auth_time: now - 20 })
    .setProtectedHeader({ alg: 'RS256', kid: 'leads-test' }).setIssuer(`https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`)
    .setAudience(env.FIREBASE_PROJECT_ID).setSubject('owner-uid').setIssuedAt(now - 10).setExpirationTime(now + 3600).sign(signingKey);
}

// ---- outbound fetches: the JWKS only -----------------------------------------------------------
let otherFetches: string[] = [];
const sockets: WebSocket[] = [];
beforeEach(() => {
  otherFetches = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === JWKS_URL) return Response.json(jwks);
    otherFetches.push(new URL(request.url).hostname);
    return new Response(null, { status: 599 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) { try { socket.close(1000, 'Test complete'); } catch {} }
  expect(otherFetches).toEqual([]);
});

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 10) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---- hosts ---------------------------------------------------------------------------------
function relay() { return env.RELAY.get(env.RELAY.idFromName(crypto.randomUUID())); }
type Stub = ReturnType<typeof relay>;
const ownerRelay = () => env.RELAY.get(env.RELAY.idFromName(env.ALLOWED_EMAIL));

type Host = { socket: WebSocket; frames: any[]; machine_id: string; name: string; closed: Promise<void> };

async function open(stub: Stub) {
  const response = await stub.fetch(`${ORIGIN}/api/host/connect`, { headers: { upgrade: 'websocket', authorization: `Bearer ${env.HOST_TOKEN}` } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept(); sockets.push(socket);
  const frames: any[] = [];
  socket.addEventListener('message', (event) => { frames.push(JSON.parse(String(event.data))); });
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
  return { socket, frames, closed };
}
const pongs = (host: { frames: any[] }) => host.frames.filter((frame) => frame.type === 'pong').length;
async function machine(stub: Stub, name: string, machine_id = crypto.randomUUID()): Promise<Host> {
  const host = { ...await open(stub), machine_id, name };
  host.socket.send(JSON.stringify({ type: 'hello', protocol: 2, machine_id, host: name, platform: 'darwin', pm_open_turns: [] }));
  await until(() => pongs(host) > 0, `${name} hello pong`);
  return host;
}
async function legacy(stub: Stub, name = 'Legacy host') {
  const host = { ...await open(stub), machine_id: '', name };
  host.socket.send(JSON.stringify({ type: 'hello', host: name }));
  await until(() => pongs(host) > 0, 'legacy hello pong');
  return host;
}
async function flush(host: { socket: WebSocket; frames: any[] }) {
  const before = pongs(host);
  host.socket.send(JSON.stringify({ type: 'ping' }));
  await until(() => pongs(host) > before, 'ping pong');
}
async function pair(stub: Stub = relay()) {
  const a = await machine(stub, 'machine-a');
  const b = await machine(stub, 'machine-b');
  return { stub, a, b };
}
async function disconnect(stub: Stub, host: Host) {
  host.socket.close(1000, 'Network lost');
  await until(async () => ((await (await stub.fetch(`${ORIGIN}/api/pm/host`)).json()) as any).machines.find((m: any) => m.machine_id === host.machine_id)?.online === false, `${host.name} offline`);
}

/** Sends one lead_rpc (as a string, so the raw text is exactly what the test chose) and returns its result frame. */
async function sendRaw(host: { socket: WebSocket; frames: any[] }, id: string, text: string) {
  host.socket.send(text);
  await until(() => host.frames.some((frame) => frame.type === 'lead_rpc_result' && frame.id === id), `lead_rpc ${id} result`);
  const result = host.frames.find((frame) => frame.type === 'lead_rpc_result' && frame.id === id);
  expect(parseLeadRpcResult(result).ok, JSON.stringify(result).slice(0, 300)).toBe(true);
  return result;
}
async function rpc(host: { socket: WebSocket; frames: any[] }, op: string, args: unknown) {
  const id = crypto.randomUUID();
  return sendRaw(host, id, JSON.stringify({ type: 'lead_rpc', id, op, args }));
}
async function ok(host: { socket: WebSocket; frames: any[] }, op: LeadOp, args: unknown) {
  const result = await rpc(host, op, args);
  expect(result, JSON.stringify(result).slice(0, 300)).toMatchObject({ ok: true });
  expect(parseLeadOpResult(op, result.result).ok).toBe(true);
  return result.result;
}

// ---- DO access -----------------------------------------------------------------------------
const sql = <T extends Record<string, SqlStorageValue>>(stub: Stub, query: string, ...bindings: unknown[]) =>
  runInDurableObject(stub, (_instance: HostRelay, ctx) => ctx.storage.sql.exec<T>(query, ...bindings).toArray());

// ---- records -------------------------------------------------------------------------------
const leadKey = () => `fm:${crypto.randomUUID()}`;
function record(host: Host, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    v: 1, lead: leadKey(), machine_id: host.machine_id, machine_name: host.name, name: 'lead-triage', project: 'foreman', workstream: 'triage',
    goal: 'Triage the open bugs', model: 'opus[1m]', effort: 'medium', permission_mode: 'bypass', bypass_grant: 'standing:coordinator/*',
    policy_reason: 'standing_grant', launched_by: 'coordinator', state: 'working', alive: true, created_at: now, updated_at: now,
    pending_approvals: 0, workers: [], ...overrides,
  };
}
function handoff(lead: string, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    v: 1, lead, seq, at: new Date(Date.now() + seq).toISOString(), kind: 'checkpoint', project: 'foreman', workstream: 'triage',
    goal: 'Triage the open bugs', status: 'in_progress', summary: `checkpoint ${seq}`, decisions: [], open_questions: [], next_steps: [],
    links: [], workers: [], ...overrides,
  };
}

// =============================================================================================

describe('lead_rpc: who may use it', () => {
  it('is accepted from a standby machine (not epoch-fenced like pm_rpc) and every machine reads every row', async () => {
    const { a, b } = await pair();
    // B is the standby: pm_rpc from it is refused, lead_rpc is not.
    const pm = crypto.randomUUID();
    b.socket.send(JSON.stringify({ type: 'pm_rpc', id: pm, epoch: 1, op: 'memory.get', args: {} }));
    await until(() => b.frames.some((f) => f.type === 'pm_rpc_result' && f.id === pm), 'pm_rpc result');
    expect(b.frames.find((f) => f.type === 'pm_rpc_result' && f.id === pm)).toMatchObject({ ok: false, code: 'not_active' });
    const row = record(b);
    expect(await ok(b, 'lead.upsert', { record: row })).toEqual({});
    expect(await ok(b, 'lead.handoff', { handoff: handoff(row.lead, 1) })).toEqual({ stored: true });
    // The PM host (A) reads B's Lead, with B online.
    const list = await ok(a, 'lead.list', {});
    expect(list.leads).toHaveLength(1);
    expect(list.leads[0]).toMatchObject({ lead: row.lead, machine_id: b.machine_id, machine_online: true, ended: false, reported_at: expect.any(Number) });
    const got = await ok(a, 'lead.get', { lead: row.lead, handoffs: 5 });
    expect(got.lead.lead).toBe(row.lead);
    expect(got.handoffs.map((h: any) => h.seq)).toEqual([1]);
  });

  it('refuses a legacy socket and a socket that never said hello with forbidden, and stores nothing', async () => {
    const stub = relay();
    const old = await legacy(stub);
    const fake = { ...old, machine_id: crypto.randomUUID(), name: 'fake' } as Host;
    expect(await rpc(old, 'lead.upsert', { record: record(fake) })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rpc(old, 'settings.get', {})).toMatchObject({ ok: false, code: 'forbidden' });
    const silent = await open(stub);
    expect(await rpc(silent, 'lead.list', {})).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await sql(stub, 'SELECT * FROM leads')).toEqual([]);
  });

  it('a lead_rpc frame refreshes its socket\'s heartbeat like pm_rpc', async () => {
    const stub = relay(), a = await machine(stub, 'machine-a');
    await runInDurableObject(stub, (_i: HostRelay, ctx) => {
      for (const socket of ctx.getWebSockets('host')) socket.serializeAttachment({ ...socket.deserializeAttachment(), lastSeen: Date.now() - 120_000 });
    });
    expect(((await (await stub.fetch(`${ORIGIN}/api/host`)).json()) as any).online).toBe(false);
    await ok(a, 'lead.list', {});
    expect(((await (await stub.fetch(`${ORIGIN}/api/host`)).json()) as any).online).toBe(true);
  });

  it('malformed frames: a valid id gets invalid; no valid id gets no answer; unknown ops are refused', async () => {
    const { a } = await pair();
    expect(await rpc(a, 'lead.upsert', { record: { lead: 'nope' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await rpc(a, 'lead.list', { extra: 1 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await rpc(a, 'lead.delete', {})).toMatchObject({ ok: false, code: 'invalid' });
    a.socket.send(JSON.stringify({ type: 'lead_rpc', id: '', op: 'lead.list', args: {} }));
    await flush(a);
    expect(a.frames.filter((f) => f.type === 'lead_rpc_result' && f.id === '')).toEqual([]);
    expect(a.socket.readyState).toBe(1);
  });
});

describe('ownership: a machine writes only its own rows', () => {
  it('refuses records naming another machine, overwriting another machine\'s row, and handoffs on it', async () => {
    const { stub, a, b } = await pair();
    const bRow = record(b);
    await ok(b, 'lead.upsert', { record: bRow });
    // A claims a record for B's machine.
    expect(await rpc(a, 'lead.upsert', { record: record(b) })).toMatchObject({ ok: false, code: 'forbidden' });
    // A tries to take over B's row by naming itself.
    expect(await rpc(a, 'lead.upsert', { record: { ...record(a), lead: bRow.lead } })).toMatchObject({ ok: false, code: 'forbidden' });
    // A appends a handoff to B's Lead.
    expect(await rpc(a, 'lead.handoff', { handoff: handoff(bRow.lead, 1) })).toMatchObject({ ok: false, code: 'forbidden' });
    // A sync with one foreign record is refused whole: A's own record in the same frame is not stored.
    const mine = record(a);
    expect(await rpc(a, 'lead.sync', { records: [mine, { ...record(a), lead: bRow.lead }] })).toMatchObject({ ok: false, code: 'forbidden' });
    const rows = await sql<{ lead: string; machine_id: string }>(stub, 'SELECT lead, machine_id FROM leads');
    expect(rows).toEqual([{ lead: bRow.lead, machine_id: b.machine_id }]);
    expect(JSON.parse((await sql<{ record: string }>(stub, 'SELECT record FROM leads'))[0]!.record).machine_name).toBe('machine-b');
    expect(await sql(stub, 'SELECT * FROM lead_handoffs')).toEqual([]);
    // B may update its own row; A's own rows sync fine.
    await ok(b, 'lead.upsert', { record: { ...bRow, state: 'idle' } });
    expect(await ok(a, 'lead.sync', { records: [mine] })).toEqual({});
    expect((await sql(stub, 'SELECT lead FROM leads')).length).toBe(2);
  });

  it('a handoff needs its Lead row first (not_found)', async () => {
    const { a } = await pair();
    expect(await rpc(a, 'lead.handoff', { handoff: handoff(leadKey(), 1) })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await rpc(a, 'lead.get', { lead: leadKey() })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('what is stored', () => {
  it('stores the validated v1 view: unknown fields (a cwd) dropped, end_reason redacted and bounded, ended computed', async () => {
    const { stub, a } = await pair();
    const secret = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
    const row = record(a, { v: 3, cwd: '/Users/someone/code/foreman', state: 'ended', alive: false, end_reason: `provider failed: ${secret}` });
    await ok(a, 'lead.upsert', { record: row });
    const [stored] = await sql<{ record: string; machine_id: string; ended: number; reported_at: number }>(stub, 'SELECT record, machine_id, ended, reported_at FROM leads');
    expect(stored!.record).not.toContain('/Users/someone');
    expect(stored!.record).not.toContain('dXNlcjpwYXNzd29yZA');
    const parsed = JSON.parse(stored!.record);
    expect(parsed.v).toBe(1);
    expect(parsed).not.toHaveProperty('cwd');
    expect(parsed.end_reason).toMatch(/^provider failed: /);
    expect(parsed.end_reason.length).toBeLessThanOrEqual(300);
    expect(stored!.ended).toBe(1);
    expect(stored!.machine_id).toBe(a.machine_id);
    // Superseded counts as ended; working does not.
    await ok(a, 'lead.upsert', { record: record(a, { superseded_by: leadKey() }) });
    await ok(a, 'lead.upsert', { record: record(a) });
    expect((await sql<{ ended: number }>(stub, 'SELECT ended FROM leads ORDER BY ended')).map((r) => r.ended)).toEqual([0, 1, 1]);
    // A handoff is stored as its parsed view too.
    await ok(a, 'lead.handoff', { handoff: { ...handoff(row.lead, 7), v: 2, extra: 'dropped' } });
    const [h] = await sql<{ body: string; at: number; seq: number }>(stub, 'SELECT body, at, seq FROM lead_handoffs');
    expect(JSON.parse(h!.body)).not.toHaveProperty('extra');
    expect(JSON.parse(h!.body).v).toBe(1);
    expect(h!.seq).toBe(7);
    expect(h!.at).toBe(Date.parse(JSON.parse(h!.body).at));
  });

  it('a stored row that no longer validates is skipped on read, never served', async () => {
    const { stub, a } = await pair();
    const good = record(a), bad = record(a);
    await ok(a, 'lead.sync', { records: [good, bad] });
    await sql(stub, 'UPDATE leads SET record = ? WHERE lead = ?', '{"not":"a record"}', bad.lead);
    expect((await ok(a, 'lead.list', {})).leads.map((l: any) => l.lead)).toEqual([good.lead]);
    expect(await rpc(a, 'lead.get', { lead: bad.lead })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('handoffs: dedup and retention', () => {
  it('deduplicates by (lead, seq) with stored: false, and returns handoffs newest first', async () => {
    const { a } = await pair();
    const row = record(a);
    await ok(a, 'lead.upsert', { record: row });
    expect(await ok(a, 'lead.handoff', { handoff: handoff(row.lead, 1) })).toEqual({ stored: true });
    expect(await ok(a, 'lead.handoff', { handoff: handoff(row.lead, 1, { summary: 'a replay with other text' }) })).toEqual({ stored: false });
    expect(await ok(a, 'lead.handoff', { handoff: handoff(row.lead, 2) })).toEqual({ stored: true });
    const got = await ok(a, 'lead.get', { lead: row.lead, handoffs: 5 });
    expect(got.handoffs.map((h: any) => [h.seq, h.summary])).toEqual([[2, 'checkpoint 2'], [1, 'checkpoint 1']]);
    expect((await ok(a, 'lead.get', { lead: row.lead })).handoffs).toEqual([]);
  });

  it(`keeps the newest ${MAX_HANDOFFS_KEPT} handoffs per Lead; a replay older than all of them is not stored`, async () => {
    const { stub, a } = await pair();
    const row = record(a), other = record(a);
    await ok(a, 'lead.sync', { records: [row, other] });
    for (let seq = 0; seq < 25; seq++) await ok(a, 'lead.handoff', { handoff: handoff(row.lead, seq) });
    await ok(a, 'lead.handoff', { handoff: handoff(other.lead, 0) });
    const seqs = (await sql<{ seq: number }>(stub, 'SELECT seq FROM lead_handoffs WHERE lead = ? ORDER BY seq', row.lead)).map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: MAX_HANDOFFS_KEPT }, (_, i) => i + 5));
    // seq 2 was dropped: its replay is not stored again (it would be pruned at once).
    expect(await ok(a, 'lead.handoff', { handoff: handoff(row.lead, 2) })).toEqual({ stored: false });
    expect((await sql(stub, 'SELECT seq FROM lead_handoffs WHERE lead = ?', row.lead)).length).toBe(MAX_HANDOFFS_KEPT);
    // Another Lead's handoffs are untouched.
    expect((await sql(stub, 'SELECT seq FROM lead_handoffs WHERE lead = ?', other.lead)).length).toBe(1);
  });
});

describe(`registry retention: at most ${MAX_LEAD_ROWS} Lead rows`, () => {
  async function fill(a: Host, count: number, ended: (i: number) => boolean) {
    const leads: string[] = [];
    for (let start = 0; start < count; start += 50) {
      const records = Array.from({ length: Math.min(50, count - start) }, (_, j) => {
        const i = start + j;
        return record(a, ended(i) ? { state: 'ended', alive: false } : {});
      });
      leads.push(...records.map((r) => r.lead));
      await ok(a, 'lead.sync', { records });
    }
    return leads;
  }

  it('prunes the oldest ended rows (and their handoffs) to admit a new row', async () => {
    const { stub, a } = await pair();
    const leads = await fill(a, MAX_LEAD_ROWS, (i) => i < 3);
    await ok(a, 'lead.handoff', { handoff: handoff(leads[0]!, 1) });
    // Make the ended rows' ages distinct: leads[1] is the oldest.
    await sql(stub, 'UPDATE leads SET reported_at = 1000 WHERE lead = ?', leads[1]);
    await sql(stub, 'UPDATE leads SET reported_at = 2000 WHERE lead = ?', leads[0]);
    const fresh = record(a);
    await ok(a, 'lead.upsert', { record: fresh });
    const remaining = new Set((await sql<{ lead: string }>(stub, 'SELECT lead FROM leads')).map((r) => r.lead));
    expect(remaining.size).toBe(MAX_LEAD_ROWS);
    expect(remaining.has(fresh.lead)).toBe(true);
    expect(remaining.has(leads[1]!)).toBe(false);
    expect(remaining.has(leads[0]!)).toBe(true);
    // Two more: leads[0] (now the oldest ended) goes, with its handoff.
    await ok(a, 'lead.sync', { records: [record(a), record(a)] });
    const after = new Set((await sql<{ lead: string }>(stub, 'SELECT lead FROM leads')).map((r) => r.lead));
    expect(after.size).toBe(MAX_LEAD_ROWS);
    expect(after.has(leads[0]!)).toBe(false);
    expect(after.has(leads[2]!)).toBe(false);
    expect(await sql(stub, 'SELECT * FROM lead_handoffs WHERE lead = ?', leads[0])).toEqual([]);
  });

  it('refuses new rows with too_large when no ended row can be pruned; updates still work', async () => {
    const { stub, a } = await pair();
    const leads = await fill(a, MAX_LEAD_ROWS, () => false);
    expect(await rpc(a, 'lead.upsert', { record: record(a) })).toMatchObject({ ok: false, code: 'too_large' });
    expect(await rpc(a, 'lead.sync', { records: [record(a, { lead: leads[0] }), record(a)] })).toMatchObject({ ok: false, code: 'too_large' });
    expect((await sql(stub, 'SELECT lead FROM leads')).length).toBe(MAX_LEAD_ROWS);
    await ok(a, 'lead.upsert', { record: record(a, { lead: leads[0], state: 'idle' }) });
    expect(JSON.parse((await sql<{ record: string }>(stub, 'SELECT record FROM leads WHERE lead = ?', leads[0]))[0]!.record).state).toBe('idle');
  });
});

describe('lead.list', () => {
  it('orders non-ended first then newest, hides ended by default, honors limit, and computes machine_online at read time', async () => {
    const { stub, a, b } = await pair();
    const endedA = record(a, { state: 'ended', alive: false });
    const oldA = record(a), newB = record(b);
    await ok(a, 'lead.sync', { records: [endedA, oldA] });
    await ok(b, 'lead.upsert', { record: newB });
    await sql(stub, 'UPDATE leads SET reported_at = 1000 WHERE lead = ?', oldA.lead);
    await sql(stub, 'UPDATE leads SET reported_at = 5000 WHERE lead = ?', endedA.lead);
    expect((await ok(a, 'lead.list', {})).leads.map((l: any) => l.lead)).toEqual([newB.lead, oldA.lead]);
    const all = (await ok(a, 'lead.list', { include_ended: true })).leads;
    expect(all.map((l: any) => [l.lead, l.ended])).toEqual([[newB.lead, false], [oldA.lead, false], [endedA.lead, true]]);
    expect(all[1].reported_at).toBe(1000);
    expect((await ok(a, 'lead.list', { include_ended: true, limit: 1 })).leads.map((l: any) => l.lead)).toEqual([newB.lead]);
    expect((await ok(a, 'lead.get', { lead: newB.lead })).lead.machine_online).toBe(true);
    await disconnect(stub, b);
    expect((await ok(a, 'lead.get', { lead: newB.lead })).lead).toMatchObject({ machine_online: false, reported_at: expect.any(Number) });
    expect((await ok(a, 'lead.list', {})).leads.map((l: any) => [l.lead, l.machine_online])).toEqual([[newB.lead, false], [oldA.lead, true]]);
  });

  it(`is trimmed so its lead_rpc_result frame fits ${MAX_LEAD_RESULT_FRAME} bytes, cutting the oldest ended rows`, async () => {
    const { stub, a } = await pair();
    // ~8 KiB records: 200 of them are ~1.6 MiB, well over the result bound.
    const workers = Array.from({ length: 20 }, (_, i) => ({ session_key: `fm:w${i}`, name: `worker-${i}-${'w'.repeat(300)}`.slice(0, 200), state: 'working', permission_mode: 'bypass', needs_attention: false }));
    const big = (ended: boolean) => record(a, { goal: 'g'.repeat(1000), workers, ...(ended ? { state: 'ended', alive: false } : {}) });
    expect(utf8Length(JSON.stringify(big(false)))).toBeGreaterThan(5000);
    const all: { lead: string; ended: boolean }[] = [];
    for (let n = 0; n < MAX_LEAD_ROWS;) {
      const records: any[] = [];
      while (n < MAX_LEAD_ROWS && utf8Length(JSON.stringify({ type: 'lead_rpc', id: 'x'.repeat(36), op: 'lead.sync', args: { records: [...records, big(n % 2 === 0)] } })) <= MAX_LEAD_FRAME) {
        records.push(big(n % 2 === 0)); n++;
      }
      await ok(a, 'lead.sync', { records });
      all.push(...records.map((r) => ({ lead: r.lead, ended: r.state === 'ended' })));
    }
    // Make reported_at strictly increasing in insertion order so "oldest" is well defined.
    for (const [i, row] of all.entries()) await sql(stub, 'UPDATE leads SET reported_at = ? WHERE lead = ?', 1_000 + i, row.lead);
    const id = crypto.randomUUID();
    const frame = await sendRaw(a, id, JSON.stringify({ type: 'lead_rpc', id, op: 'lead.list', args: { include_ended: true } }));
    expect(frame.ok).toBe(true);
    expect(utf8Length(JSON.stringify(frame))).toBeLessThanOrEqual(MAX_LEAD_RESULT_FRAME);
    const got: any[] = frame.result.leads;
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(MAX_LEAD_ROWS);
    // Every non-ended row is there, newest first; what was cut is the oldest ended rows.
    const liveNewestFirst = all.filter((r) => !r.ended).map((r) => r.lead).reverse();
    const endedNewestFirst = all.filter((r) => r.ended).map((r) => r.lead).reverse();
    expect(got.map((l) => l.lead)).toEqual([...liveNewestFirst, ...endedNewestFirst.slice(0, got.length - liveNewestFirst.length)]);
    // /api/leads (all rows) is bounded the same way.
    const http = await (await ownerView(stub)).json() as LeadsResponse;
    expect(http.leads.map((l) => l.lead)).toEqual(got.map((l) => l.lead));
  });
});
// /api/leads is answered by the DO; the Worker's auth in front of it is covered below.
const ownerView = (stub: Stub) => stub.fetch(`${ORIGIN}/api/leads`);

describe('oversized lead_rpc frames', () => {
  it(`refuses a frame over ${MAX_LEAD_FRAME} bytes with too_large on its raw length, in any key order, and stores nothing`, async () => {
    const { stub, a } = await pair();
    const row = record(a);
    await ok(a, 'lead.upsert', { record: row });
    // The raw text is padded with whitespace: the parsed-and-reserialized frame would be small.
    const id1 = crypto.randomUUID();
    const padded = `{"type":"lead_rpc","id":"${id1}","op":"lead.upsert","args":${JSON.stringify({ record: { ...row, state: 'idle' } })}${' '.repeat(MAX_LEAD_FRAME)}}`;
    expect(utf8Length(JSON.stringify(JSON.parse(padded)))).toBeLessThan(MAX_LEAD_FRAME);
    expect(await sendRaw(a, id1, padded)).toMatchObject({ ok: false, code: 'too_large' });
    // Another key order (id before type) is refused too, after parsing but before validating args.
    const id2 = crypto.randomUUID();
    const reordered = `{"id":"${id2}","type":"lead_rpc","op":"lead.upsert","args":${JSON.stringify({ record: { ...row, state: 'idle' } })}${' '.repeat(MAX_LEAD_FRAME)}}`;
    expect(await sendRaw(a, id2, reordered)).toMatchObject({ ok: false, code: 'too_large' });
    expect(JSON.parse((await sql<{ record: string }>(stub, 'SELECT record FROM leads'))[0]!.record).state).toBe('working');
    expect(a.socket.readyState).toBe(1);
  });

  it('answers an oversized lead_rpc without parsing it: an unparseable body gets too_large, not a closed socket', async () => {
    const { a } = await pair();
    const id = crypto.randomUUID();
    // Not JSON at all past the header: JSON.parse would throw and close the socket (1003).
    const text = `{"type":"lead_rpc","id":"${id}",${'x'.repeat(MAX_LEAD_FRAME)}`;
    expect(await sendRaw(a, id, text)).toMatchObject({ ok: false, code: 'too_large' });
    await flush(a);
    expect(a.socket.readyState).toBe(1);
    // A frame at the bound that is not a lead_rpc is untouched by this check (a relay response here).
    const other = `{"type":"response","id":"none","status":200,"body":"${'y'.repeat(MAX_LEAD_FRAME)}"}`;
    a.socket.send(other);
    await flush(a);
    expect(a.socket.readyState).toBe(1);
  });
});

describe('developer settings are never written by a host', () => {
  it('settings.get returns the defaults when never written: grant on for coordinator and lead, ask off', async () => {
    const { a } = await pair();
    const view = await ok(a, 'settings.get', {});
    expect(parseDevSettingsView(view).ok).toBe(true);
    expect(view).toEqual({ settings: { roles: {}, bypass_grants: DEFAULT_BYPASS_GRANTS, bypass_ask: false }, versions: { roles: 0, bypass_grants: 0, bypass_ask: 0 }, updated_at: null });
  });

  it('no lead_rpc op writes settings: write-shaped ops and settings.get with arguments are refused', async () => {
    const { stub, a, b } = await pair();
    const grants = [{ role: 'coordinator', project: '*', allow: false }];
    for (const op of ['settings.put', 'settings.set', 'settings.write', 'settings.update', 'dev_settings.set', 'grants.set']) {
      expect(await rpc(a, op, { key: 'bypass_grants', value: grants })).toMatchObject({ ok: false, code: 'invalid' });
      expect(await rpc(b, op, { key: 'bypass_ask', value: true })).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(await rpc(a, 'settings.get', { key: 'bypass_grants', value: grants })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await rpc(a, 'settings.get', { bypass_grants: grants })).toMatchObject({ ok: false, code: 'invalid' });
    // A Lead record or handoff smuggling settings fields stores none of them in dev_settings.
    await ok(a, 'lead.upsert', { record: record(a, { bypass_grants: grants, bypass_ask: true }) });
    expect(await sql(stub, 'SELECT * FROM dev_settings')).toEqual([]);
    expect((await ok(b, 'settings.get', {})).settings.bypass_grants).toEqual(DEFAULT_BYPASS_GRANTS);
  });

  it('a corrupt stored value falls back to lower privilege', async () => {
    const { stub, a } = await pair();
    await sql(stub, "INSERT INTO dev_settings (key, value, version, updated_at) VALUES ('bypass_grants', 'not json', 3, 10), ('bypass_ask', '\"yes\"', 1, 20), ('future_key', '1', 1, 30)");
    const view = await ok(a, 'settings.get', {});
    expect(view.settings).toMatchObject({ bypass_grants: [], bypass_ask: true });
    expect(view.versions).toEqual({ roles: 0, bypass_grants: 3, bypass_ask: 1 });
    expect(view.updated_at).toBe(20);
  });
});

// ---- Worker-terminated routes ------------------------------------------------------------------

describe('/api/leads and /api/settings through the Worker', () => {
  const api = async (method: string, path: string, { token, origin, body }: { token?: string | null; origin?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const bearer = token === undefined ? await idToken() : token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (origin) headers.origin = origin;
    return exports.default.fetch(`${ORIGIN}${path}`, { method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body ?? {})) : undefined });
  };
  const resetOwner = () => runInDurableObject(ownerRelay(), (_instance: HostRelay, ctx) => {
    ctx.storage.sql.exec('DELETE FROM leads; DELETE FROM lead_handoffs; DELETE FROM dev_settings; DELETE FROM machines; DELETE FROM pm_assignment;');
  });
  beforeEach(resetOwner);
  afterEach(resetOwner);

  it('are Worker/DO-terminated: never on the relay allowlist', () => {
    for (const [method, path] of [['GET', '/api/leads'], ['GET', '/api/settings'], ['POST', '/api/settings']]) expect(allowedRequest(method!, path!)).toBe(false);
  });

  it('auth: 401 without a bearer, 403 for another account or an invalid token, 403 cross-origin; the host token is no user credential', async () => {
    for (const [method, path] of [['GET', '/api/leads'], ['GET', '/api/settings'], ['POST', '/api/settings']] as const) {
      const body = { key: 'bypass_ask', value: true };
      expect((await api(method, path, { token: null, body })).status).toBe(401);
      expect((await api(method, path, { token: 'invalid', body })).status).toBe(403);
      expect((await api(method, path, { token: await idToken('intruder@example.com'), body })).status).toBe(403);
      expect((await api(method, path, { origin: 'https://attacker.invalid', body })).status).toBe(403);
      expect((await exports.default.fetch(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${env.HOST_TOKEN}` }, body: method === 'POST' ? JSON.stringify(body) : undefined })).status).toBe(403);
    }
    // None of the refused POSTs wrote anything.
    expect(await sql(ownerRelay(), 'SELECT * FROM dev_settings')).toEqual([]);
    // Other methods and query strings are unknown routes.
    expect((await api('POST', '/api/leads')).status).toBe(404);
    expect((await api('GET', '/api/leads?include_ended=1')).status).toBe(404);
    expect((await api('PUT', '/api/settings')).status).toBe(404);
    expect((await api('GET', '/api/settings?x=1')).status).toBe(404);
  });

  it('GET /api/leads works with no host connected: machine_online and reported_at', async () => {
    const empty = await api('GET', '/api/leads');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ leads: [], mode: 'relay' });
    const stub = ownerRelay();
    const a = await machine(stub, 'machine-a');
    const live = record(a), done = record(a, { state: 'ended', alive: false, end_reason: 'superseded' });
    await ok(a, 'lead.sync', { records: [done, live] });
    const online = await (await api('GET', '/api/leads', { origin: ORIGIN })).json() as LeadsResponse;
    expect(online.mode).toBe('relay');
    expect(online.leads.map((l) => [l.lead, l.machine_online, l.ended])).toEqual([[live.lead, true, false], [done.lead, true, true]]);
    for (const entry of online.leads) expect(parseLeadListEntry(entry).ok).toBe(true);
    const reportedAt = online.leads[0]!.reported_at;
    expect(reportedAt).toBeGreaterThan(Date.now() - 60_000);
    await disconnect(stub, a);
    const offline = await api('GET', '/api/leads');
    expect(offline.status).toBe(200);
    const view = await offline.json() as LeadsResponse;
    expect(view.leads.map((l) => [l.lead, l.machine_online])).toEqual([[live.lead, false], [done.lead, false]]);
    expect(view.leads[0]!.reported_at).toBe(reportedAt);
  });

  it('GET /api/settings: defaults when never written, writable, with no host connected', async () => {
    const response = await api('GET', '/api/settings');
    expect(response.status).toBe(200);
    const view = await response.json() as SettingsResponse;
    expect(view).toEqual({ settings: { roles: {}, bypass_grants: DEFAULT_BYPASS_GRANTS, bypass_ask: false }, versions: { roles: 0, bypass_grants: 0, bypass_ask: 0 }, updated_at: null, writable: true });
  });

  it('POST /api/settings validates, bumps the version, enforces optimistic concurrency (409), and hosts read the result', async () => {
    const grants = [{ role: 'coordinator', project: '*', allow: true }, { role: 'lead', project: 'foreman', allow: false }];
    const first = await api('POST', '/api/settings', { origin: ORIGIN, body: { key: 'bypass_grants', value: grants, version: 0 } });
    expect(first.status).toBe(200);
    const view = await first.json() as SettingsResponse;
    expect(view).toMatchObject({ settings: { bypass_grants: grants, bypass_ask: false, roles: {} }, versions: { bypass_grants: 1, bypass_ask: 0, roles: 0 }, writable: true });
    expect(view.updated_at).toEqual(expect.any(Number));
    // Stale version: 409, nothing written.
    const stale = await api('POST', '/api/settings', { body: { key: 'bypass_grants', value: [], version: 0 } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: expect.any(String), version: 1 });
    // Without a version the write is unconditional.
    expect((await api('POST', '/api/settings', { body: { key: 'bypass_ask', value: true } })).status).toBe(200);
    const roles = await api('POST', '/api/settings', { body: { key: 'roles', value: { lead: { model: 'opus[1m]', effort: 'high' } }, version: 0 } });
    expect(roles.status).toBe(200);
    expect(((await roles.json()) as SettingsResponse).versions).toEqual({ roles: 1, bypass_grants: 1, bypass_ask: 1 });
    // Invalid bodies: 400 and nothing written.
    for (const body of [{ key: 'bypass_grants', value: [{ role: 'worker', project: '*', allow: true }] }, { key: 'nope', value: 1 }, { key: 'bypass_ask', value: 'yes' },
      { key: 'bypass_ask', value: true, extra: 1 }, { key: 'bypass_ask', value: true, version: -1 }, { key: 'roles', value: { coordinator: { model: 'x' } } }, '[1]', 'not json']) {
      expect((await api('POST', '/api/settings', { body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api('POST', '/api/settings', { body: { key: 'bypass_ask', value: true, pad: 'x'.repeat(MAX_SETTINGS_BODY) } })).status).toBe(413);
    // A host (a standby, even) reads exactly what the developer wrote.
    const stub = ownerRelay();
    await machine(stub, 'machine-a');
    const b = await machine(stub, 'machine-b');
    const hostView = await ok(b, 'settings.get', {});
    expect(hostView.settings).toEqual({ roles: { lead: { model: 'opus[1m]', effort: 'high' } }, bypass_grants: grants, bypass_ask: true });
    expect(hostView.versions).toEqual({ roles: 1, bypass_grants: 1, bypass_ask: 1 });
    const get = await (await api('GET', '/api/settings')).json() as SettingsResponse;
    expect({ ...get, writable: undefined }).toEqual({ ...hostView, writable: undefined });
  });

  it('/api/launch* is 404 from the Worker, even for the signed-in owner with a host connected', async () => {
    const a = await machine(ownerRelay(), 'machine-a');
    for (const [method, path] of [['GET', '/api/launch'], ['GET', '/api/launch?id=1'], ['POST', '/api/launch'], ['POST', '/api/launch/propose'], ['POST', '/api/launch/cancel'], ['POST', '/api/launch/execute']] as const) {
      expect((await api(method, path, { origin: ORIGIN })).status, `${method} ${path}`).toBe(404);
    }
    await flush(a);
    expect(a.frames.filter((f) => f.type === 'request')).toEqual([]);
  });
});
