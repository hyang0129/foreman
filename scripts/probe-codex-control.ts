// Explicit, bounded live probe: a private app-server, two independent clients, one test thread.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { CodexControl } from '../server/codex-control.ts';

if (!process.argv.includes('--live')) throw new Error('Pass --live to run three tiny model turns using your existing Codex login.');
const dir = mkdtempSync(join(tmpdir(), 'foreman-codex-proof-'));
const socket = join(dir, 'server.sock');
const bin = process.env.FOREMAN_CODEX_BIN ?? 'codex';
const server = spawn(bin, ['app-server', '--listen', `unix://${socket}`], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostic = '';
let spawnError: Error | undefined;
server.on('error', (error) => { spawnError = error; });
server.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
const external = new CodexControl({ bin, socket, timeoutMs:20_000 });
let foreman = new CodexControl({ bin, socket, timeoutMs:20_000 });
const report: Record<string, unknown> = { provider: 'codex', transport: 'private Unix socket', realTerminalTest: false };
let threadId: string | undefined;
const finished: { id: string; status: string }[] = [];
function observe(client: CodexControl) {
  client.on('request', (request) => {
    // Probe prompts never need tools. Any tool approval is denied, not granted.
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) client.respond(request.id, { decision:'decline' });
  });
  client.on('notification', (event) => {
    if (event.method === 'turn/completed') finished.push({ id:event.params.turn.id, status:event.params.turn.status });
  });
}
async function until(check: () => boolean, label: string, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (spawnError) throw spawnError;
    if (Date.now() > end) throw new Error(`${label} timed out`);
    if (server.exitCode !== null) throw new Error(`Private server exited: ${diagnostic}`);
    await delay(100);
  }
}
try {
  await until(() => existsSync(socket), 'server startup', 10_000);
  await external.connect(); observe(external);
  const thread = await external.start(dir); threadId = thread.id;
  report.externalClientCreatedThread = true;
  await external.send(threadId, 'Do not use tools or delegate. Reply with exactly FOREMAN_SEED_OK.');
  await until(() => finished.length >= 1, 'initial external turn');
  assert.equal(finished[0].status, 'completed');
  await foreman.connect(); await foreman.attach(threadId);
  report.attachedToLiveThread = true;
  // Queue while idle: installed app-server automatically starts a queued submission.
  await foreman.queue(threadId, 'Do not use tools or delegate. Reply with exactly FOREMAN_EXTERNAL_QUEUE_OK.');
  await until(() => finished.length >= 2, 'external queued message');
  assert.equal(finished[1].status, 'completed');
  report.externalQueuedTurnCompleted = true;
  const history = await foreman.history(threadId);
  assert.match(JSON.stringify(history), /FOREMAN_EXTERNAL_QUEUE_OK/);
  report.historyReadable = true;
  foreman.close();
  foreman = new CodexControl({ bin, socket, timeoutMs:20_000 });
  await foreman.connect(); await foreman.attach(threadId);
  report.reconnectedWithoutNewThread = true;
  await foreman.send(threadId, 'Do not use tools or delegate. Reply with exactly FOREMAN_RECONNECT_OK.');
  await until(() => finished.length >= 3, 'reconnected turn');
  assert.equal(finished[2].status, 'completed');
  assert.match(JSON.stringify(await foreman.history(threadId)), /FOREMAN_RECONNECT_OK/);
  report.reconnectedTurnCompleted = true;
  report.completedTurns = new Set(finished.map((turn) => turn.id)).size;
  report.permissionPromptLiveTest = false;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('Private probe server diagnostics:', diagnostic);
  throw error;
} finally {
  // Archive only the thread created here. User sessions and default daemon are untouched.
  if (threadId) await external.request('thread/archive', { threadId }).catch(() => {});
  external.close(); foreman.close(); server.kill('SIGTERM');
  await delay(250);
  if (server.exitCode === null) server.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
