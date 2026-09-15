import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { bootstrapClaudeCredentials } from './credentials.mjs';

export const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
export const labels = { native: 'Native', bypass: 'Bypass' };
const root = fileURLToPath(new URL('../../', import.meta.url));
export async function until(check, label, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error(`${label}: timed out (missing provider/tool evidence is NOT a pass)`);
}
export class Harness {
  events = [];
  rows = [];
  responses = new Map();
  sequence = 0;
  async start() {
    try { return await this.startIsolated(); }
    catch (error) { await this.close(); throw error; }
  }
  async startIsolated() {
    this.dir ??= realpathSync(mkdtempSync(join(tmpdir(), 'foreman-conformance-')));
    this.home = join(this.dir, 'state');
    mkdirSync(this.home, { recursive: true });
    this.claudeConfig = join(this.dir, 'claude-config');
    mkdirSync(this.claudeConfig, { recursive: true, mode: 0o700 });
    // Explicit opt-in reads only Keychain, never the developer's real ~/.claude.
    // Keep the same isolated credentials across the test-owned server restart.
    this.credentialsPath ??= bootstrapClaudeCredentials(this.claudeConfig);
    this.codexHome ??= join(this.dir, 'codex');
    mkdirSync(this.codexHome, {recursive:true,mode:0o700});
    if (!existsSync(join(this.codexHome, 'auth.json'))) {
      copyFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), join(this.codexHome, 'auth.json'));
      chmodSync(join(this.codexHome, 'auth.json'), 0o600);
    }
    const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
    const port = reserved.address().port; assert.notEqual(port, 4177);
    await new Promise((resolve) => reserved.close(resolve));
    this.url = `http://127.0.0.1:${port}`;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('FOREMAN_')) delete env[key];
    Object.assign(env, { FOREMAN_LIVE: '1', FOREMAN_HOME: this.home, FOREMAN_PORT: String(port),
      FOREMAN_PM_DISABLED: '1', CLAUDE_CONFIG_DIR: this.claudeConfig, CODEX_HOME: this.codexHome });
    this.child = fork(fileURLToPath(new URL('./observe.mjs', import.meta.url)), [], {
      cwd: root, env, execArgv: ['--experimental-strip-types'], detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.logs = '';
    this.child.stdout.on('data', (c) => { this.logs = (this.logs + c).slice(-8000); });
    this.child.stderr.on('data', (c) => { this.logs = (this.logs + c).slice(-8000); });
    this.child.on('message', (m) => {
      if (m.event) this.events.push(m.event);
      if (m.reply) { this.responses.get(m.reply)?.(m); this.responses.delete(m.reply); }
    });
    await until(async () => {
      if (this.child.exitCode !== null) throw new Error(`Isolated Foreman exited: ${this.logs}`);
      // Never probe the free port until our child reports a successful bind.
      if (!this.logs.includes(`foreman: http://localhost:${port}`)) return false;
      const health = await this.api('/api/health');
      assert.equal(health.pid, this.child.pid); assert.equal(health.pm_enabled, false); return true;
    }, 'isolated server startup', 20_000);
    this.browser ??= await chromium.launch();
    return this;
  }
  async api(path, body, expected) {
    assert.notEqual(new URL(this.url).port, '4177');
    const response = await fetch(this.url + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(existsSync(join(this.home, 'local-api-token')) ? {authorization:`Bearer ${readFileSync(join(this.home, 'local-api-token'),'utf8').trim()}`} : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12_000), redirect: 'error' });
    if (expected) { assert.equal(response.status, expected); return; }
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  fixture() {
    const dir = join(this.dir, randomUUID()); const project = join(dir, 'project');
    const outside = join(dir, 'sibling');
    for (const p of [project, outside]) mkdirSync(p, { recursive: true });
    const token = `synthetic-${randomUUID()}`;
    writeFileSync(join(project, 'readable.txt'), token);
    writeFileSync(join(project, '.env'), `SYNTHETIC_${token}`);
    return { dir, project, outside, token };
  }
  async create(provider, policy, f) {
    const row = await this.api('/api/sessions', { id: randomUUID(), provider, permission_mode: policy,
      cwd: f.project, name: `${provider}-${policy}-${this.rows.length}`, model: provider === 'claude'
        ? (process.env.FOREMAN_LIVE_CLAUDE_MODEL || 'haiku') : (process.env.FOREMAN_LIVE_CODEX_MODEL || 'gpt-5.6-luna'),
      text: 'Do not use tools. Wait for the next fixture instruction.' });
    row.requested = policy;
    this.rows.push(row);
    return row;
  }
  async reported(row) {
    const detail = await this.api(`/api/session?id=${encodeURIComponent(row.session_key)}`);
    assert.equal(detail.session.permission_mode, row.requested);
    const seq = ++this.sequence;
    const peer = await Promise.race([new Promise((resolve, reject) => {
      this.responses.set(seq, (m) => m.error ? reject(new Error(m.error)) : resolve(m.result));
      this.child.send({ type: 'peer', seq, id: row.session_key });
    }), delay(5000).then(() => { throw new Error('Peer projection timeout'); })]);
    assert.equal(peer.session.permission_mode, row.requested);
    const page = await this.browser.newPage({extraHTTPHeaders:{authorization:`Bearer ${readFileSync(join(this.home, 'local-api-token'),'utf8').trim()}`}});
    try {
      await page.goto(this.url);
      await page.locator('#session-list').getByText(row.name, { exact: true }).click();
      await expect(page.locator('#conversation-subtitle')).toContainText(labels[row.requested]);
    } finally { await page.close(); }
  }
  async idle(row) {
    return until(async () => {
      const d = await this.api(`/api/session?id=${encodeURIComponent(row.session_key)}`);
      const failed = d.receipts.find((r, i) => ['failed', 'uncertain'].includes(r.status) && (i === 0 || !d.session.capabilities.message));
      if (failed) throw new Error(`Provider unavailable: ${failed.error || d.session.last_error || JSON.stringify(this.events.filter((e) => e.cwd === row.cwd && e.kind === 'result').at(-1))}`);
      return d.receipts.every((r) => !['running', 'queued'].includes(r.status)) && d;
    }, `${row.provider} turn`, 60_000);
  }
  async probe(row, instruction, approval = 'deny') {
    await this.idle(row);
    const offset = this.events.length;
    const receipt = await this.api('/api/session/message', { id: row.session_key, message_id: randomUUID(),
      text: `${instruction} This is an owner-authorized integration check in a disposable directory. Execute the exact command using your native shell tool, then stop. Do not rewrite the command or use other tools. Poll a running command until it exits. The local .env fixture contains only a synthetic token and is explicitly authorized to read. Do not inspect real configuration or credential files. Do not ask a task question.` });
    const approvals = [];
    try {
      await until(async () => {
        const d = await this.api(`/api/session?id=${encodeURIComponent(row.session_key)}`);
        for (const a of d.approvals) {
          if (approvals.some((prior) => prior.id === a.id)) continue;
          approvals.push(a);
          assert.equal(a.kind, 'permission', 'A model question is not a boundary approval');
          if (typeof approval === 'function') await approval(a);
          const decision = typeof approval === 'string' ? approval : 'deny';
          await this.api('/api/session/approval', { id: row.session_key, approval_id: a.id, decision });
        }
        const r = d.receipts.find((r) => r.id === receipt.id);
        if (r && ['failed', 'uncertain'].includes(r.status)) throw new Error(`Provider turn failed: ${r.error || JSON.stringify(this.events.slice(offset).filter((e) => e.kind === 'result'))}`);
        // Bound the provider's tool activity even when Codex offers no maxTurns option.
        const attempts = this.events.slice(offset).filter((e) => e.cwd === row.cwd && (e.kind === 'tool_use' || (e.kind === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(e.item?.type))));
        assert.ok(attempts.length <= 6, 'Probe exceeded six tool attempts');
        return r?.status === 'completed';
      }, instruction.slice(0, 100));
    } catch (error) {
      await this.api('/api/session/interrupt', { id: row.session_key }).catch(() => {});
      throw error;
    }
    return { events: this.events.slice(offset).filter((e) => e.cwd === row.cwd), approvals };
  }
  shell(row, command, access = false) {
    return row.provider === 'codex'
      ? `Execute this exact shell command: ${JSON.stringify(command)}. Set yield_time_ms to 10000 so foreground execution stays attached.${access ? ' Set sandbox_permissions to require_escalated, ask for approval for this command only, and do not request a prefix rule.' : ''}`
      : `Call Bash with ${JSON.stringify({ command })}.`;
  }
  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    const child = this.child;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(7000)]);
    // Only the process group spawned by this harness, never a service or shared daemon.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
  async close() {
    try { await this.stop(); }
    finally {
      try { await this.browser?.close(); }
      finally {
        // Explicit credential removal still runs if setup, a test, or shutdown fails.
        try { if (this.credentialsPath) rmSync(this.credentialsPath, { force: true }); }
        finally { if (this.dir) rmSync(this.dir, { recursive: true, force: true }); }
      }
    }
  }
}

// Evidence is correlated native tool output, never the assistant's account of success.
export function commandResults(probe, command) {
  const codex = probe.events.filter((e) => e.kind === 'item/completed' && e.item?.type === 'commandExecution'
    && e.item.command?.includes(command)).map((e) => ({exit_code:e.item.exitCode, output:e.item.aggregatedOutput ?? ''}));
  const ids = new Set(probe.events.filter((e) => e.kind === 'tool_use' && e.name === 'Bash' && e.input?.command === command).map((e) => e.id));
  const claude = probe.events.filter((e) => e.kind === 'tool_result' && ids.has(e.tool_use_id)).map((e) => ({
    exit_code: e.is_error ? 1 : 0,
    output: typeof e.content === 'string' ? e.content : (e.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
  }));
  return [...codex, ...claude];
}
export function assertSuccess(probe, command, token) {
  const results = commandResults(probe, command);
  assert.ok(results.some((r) => r.exit_code === 0 && (!token || r.output.includes(token))),
    `No successful correlated native shell result: ${JSON.stringify(probe)}`);
}
export { existsSync, readFileSync, writeFileSync, join, randomUUID, spawnSync, delay };
