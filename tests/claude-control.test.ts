import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeControl } from "../server/claude-control.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function harness(policy?: "native" | "bypass" | "auto", extra: Record<string, unknown> = {}) {
  let opts: any;
  let input: AsyncIterator<any>;
  let wake: (() => void) | undefined;
  let closed = false;
  const messages: any[] = [];
  const factory = (params: any) => {
    opts = params.options; input = params.prompt[Symbol.asyncIterator]();
    return { async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (messages.length) yield messages.shift();
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    }, close() { closed = true; wake?.(); }, async interrupt() {} };
  };
  const control = new ClaudeControl({ cwd: "/tmp", tools: [], permission_mode: policy, ...extra }, factory as any);
  return { control, options: () => opts, nextInput: () => input.next(), emit(message: any) { messages.push(message); wake?.(); } };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("serializes queued turns and deduplicates receipt ids", async () => {
  const h = harness(); await tick();
  const first = h.control.send("one", "1");
  const second = h.control.send("two", "2");
  assert.equal(h.control.send("one", "1"), first);
  assert.throws(() => h.control.send("changed", "1"), /different text/);
  assert.equal(first.status, "running"); assert.equal(second.status, "queued");
  assert.equal((await h.nextInput()).value.message.content, "one");
  h.emit({ type: "result", is_error: false, result: "done" }); await tick();
  assert.equal(first.status, "completed"); assert.equal(second.status, "running");
  assert.equal((await h.nextInput()).value.message.content, "two");
  h.control.close(); await h.control.finished;
  assert.equal(second.status, "failed");
});

test("approval waits for a matching response and never stores permanent permissions", async () => {
  const h = harness(); await tick(); h.control.send("work");
  const abort = new AbortController();
  const request = h.options().canUseTool("Bash", { command: "pwd" }, { signal: abort.signal, toolUseID: "tool", requestId: "request" });
  const repeated = h.options().canUseTool("Bash", { command: "pwd" }, { signal: abort.signal, toolUseID: "tool", requestId: "request" });
  assert.equal(request, repeated);
  assert.equal(h.control.state, "input-needed");
  assert.equal(h.control.respondApproval("wrong", "allow"), false);
  assert.equal(h.control.pendingApprovals().length, 1);
  assert.equal(h.control.respondApproval("request", "allow"), true);
  const allowed = await request;
  assert.equal(allowed.behavior, "allow");
  assert.deepEqual(allowed.updatedInput, {command: "pwd"});
  assert.equal(h.control.state, "working");
  assert.equal(h.control.respondApproval("request", "allow"), false);
  h.control.close(); await h.control.finished;
});

test("abort and close deny pending approvals and fail queued work", async () => {
  const h = harness(); await tick();
  const abort = new AbortController();
  const request = h.options().canUseTool("Bash", {}, { signal: abort.signal, toolUseID: "one" });
  abort.abort(); assert.equal((await request).behavior, "deny");
  const secondRequest = h.options().canUseTool("Bash", {}, { signal: new AbortController().signal, toolUseID: "two" });
  h.control.close();
  assert.equal((await secondRequest).behavior, "deny");
  assert.equal(h.control.pendingApprovals().length, 0);
  assert.throws(() => h.control.send("after close"), /unavailable/);
  await h.control.finished;
});

test("startup failure fails active and queued receipts", async () => {
  const control = new ClaudeControl({}, (() => { throw new Error("startup failed"); }) as any);
  const first = control.send("one"); const second = control.send("two");
  await control.finished;
  assert.equal(control.state, "failed");
  assert.equal(first.status, "failed"); assert.equal(second.status, "failed");
  assert.match(first.error!, /startup failed/);
});

test("limits message size and pending queue growth", async () => {
  const h = harness(); await tick();
  assert.throws(() => h.control.send("x".repeat(65537)), /64 KiB/);
  assert.throws(() => h.control.send("text", ""), /1–200/);
  h.control.send("active");
  for (let i = 0; i < 100; i++) h.control.send(`queued ${i}`);
  assert.throws(() => h.control.send("overflow"), /queue is full/);
  h.control.close(); await h.control.finished;
});

test("does not acknowledge a result correlated to another prompt", async () => {
  const h = harness(); await tick();
  const receipt = h.control.send("own message");
  const input = (await h.nextInput()).value;
  h.emit({ type: "result", is_error: false, user_message_uuid: "another-send" }); await tick();
  assert.equal(receipt.status, "running");
  h.emit({ type: "result", is_error: false, user_message_uuid: input.uuid }); await tick();
  assert.equal(receipt.status, "completed");
  h.control.close(); await h.control.finished;
});

for (const policy of ['native', 'bypass', 'auto'] as const) {
  test(`Claude ${policy} uses provider permissions without a custom guard`, async () => {
    const h = harness(policy); await tick();
    try {
      assert.equal(h.control.permission_mode, policy);
      assert.equal(h.options().permissionMode, policy === 'bypass' ? 'bypassPermissions' : policy === 'auto' ? 'auto' : 'default');
      assert.equal(h.options().allowDangerouslySkipPermissions, policy === 'bypass');
      assert.deepEqual(h.options().sandbox, policy === 'bypass' ? {enabled:false} : undefined);
      assert.equal(h.options().hooks, undefined);
      assert.equal(h.options().disallowedTools, undefined);
    } finally { h.control.close(); await h.control.finished; }
  });
}

test('Claude refuses an effective provider mode different from its launch policy', {timeout:1000}, async (t) => {
  const h = harness('native'); await tick();
  t.after(() => h.control.close());
  h.emit({type:'system',subtype:'init',session_id:'test',permissionMode:'bypassPermissions'});
  await h.control.finished;
  assert.equal(h.control.state, 'failed');
});

for (const [policy, reported, ok] of [['auto', 'auto', true], ['auto', 'default', false], ['auto', 'bypassPermissions', false], ['bypass', 'auto', false], ['native', 'auto', false]] as const) {
  test(`Claude ${policy} launch ${ok ? 'is verified when' : 'fails when'} init reports ${reported}`, {timeout:1000}, async (t) => {
    const h = harness(policy); await tick();
    t.after(() => h.control.close());
    h.emit({type:'system',subtype:'init',session_id:'verified',permissionMode:reported});
    await tick();
    if (ok) { assert.equal(h.control.state, 'idle'); assert.equal(h.control.sessionId, 'verified'); }
    else { await h.control.finished; assert.equal(h.control.state, 'failed'); assert.equal(h.control.sessionId, null); }
  });
}

test('effort reaches the SDK options unchanged, and is absent when not given', async (t) => {
  const withEffort = harness('auto', { effort: 'medium' }); await tick();
  const without = harness('native'); await tick();
  t.after(() => { withEffort.control.close(); without.control.close(); });
  assert.equal(withEffort.options().effort, 'medium');
  assert.equal('effort' in without.options(), false);
});

test('approval responses cannot replace the pending command', async (t) => {
  const h = harness(); t.after(() => h.control.close()); await tick();
  const pending = h.options().canUseTool('Bash', {command:'pwd'}, {signal:new AbortController().signal,toolUseID:'immutable'});
  assert.throws(() => h.control.respondApproval('immutable','allow',{command:'touch /tmp/swapped'}), /cannot change/);
  assert.equal(h.control.pendingApprovals().length, 1);
  h.control.respondApproval('immutable','allow');
  assert.deepEqual((await pending).updatedInput, {command:'pwd'});
});

test('approval input is a snapshot and interruption cancels it', async (t) => {
  const h = harness(); t.after(() => h.control.close()); await tick();
  const input = {command:'pwd'};
  const pending = h.options().canUseTool('Bash', input, {signal:new AbortController().signal,toolUseID:'snapshot'});
  input.command = 'changed';
  h.control.pendingApprovals()[0].input.command = 'changed again';
  h.control.respondApproval('snapshot', 'allow');
  assert.deepEqual((await pending).updatedInput, {command:'pwd'});
  const next = h.options().canUseTool('Bash', {command:'ls'}, {signal:new AbortController().signal,toolUseID:'cancel'});
  await h.control.interrupt();
  assert.equal((await next).behavior, 'deny');
  assert.equal(h.control.pendingApprovals().length, 0);
  assert.equal(h.control.respondApproval('cancel', 'allow'), false);
});

test('reused approval id cannot change the operation awaiting approval', async (t) => {
  const h = harness(); t.after(() => h.control.close()); await tick();
  const context = {signal:new AbortController().signal,toolUseID:'same'};
  const original = h.options().canUseTool('Bash', {command:'pwd'}, context);
  const changed = await h.options().canUseTool('Bash', {command:'rm file'}, context);
  assert.equal(changed.behavior, 'deny');
  h.control.respondApproval('same', 'allow');
  assert.deepEqual((await original).updatedInput, {command:'pwd'});
});

test('Bypass task questions still require an answer and completed turns cancel pending requests', async (t) => {
  const h = harness('bypass'); t.after(() => h.control.close()); await tick();
  h.control.send('Ask me a question');
  const pending = h.options().canUseTool('AskUserQuestion', {questions:[{question:'Which project?'}]},
    {signal:new AbortController().signal,toolUseID:'question'});
  assert.equal(h.control.pendingApprovals()[0].tool, 'AskUserQuestion');
  h.emit({type:'result',is_error:false}); await tick();
  assert.equal((await pending).behavior,'deny');
  assert.equal(h.control.pendingApprovals().length,0);
  assert.equal(h.control.respondApproval('question','allow',{answers:{'Which project?':'A'}}),false);
});

// Hook routing for the dev preview: a daemon run with FOREMAN_HOME (the dev
// home) must have its sessions' Claude hooks record there, never in production.
// The SDK passes `{ ...process.env }` to Claude when no `env` option is given,
// and Claude passes its environment to hooks, so the launch must not override env.
test("launch leaves the SDK environment unset so sessions and their hooks inherit the daemon's FOREMAN_HOME", async () => {
  const h = harness(); await tick();
  assert.ok(h.options(), "the provider was launched");
  assert.equal(Object.hasOwn(h.options(), "env"), false);
  h.control.close(); await h.control.finished;
  // The SDK's own default is the full process environment. A tripwire on the
  // minified bundle: if an SDK upgrade breaks this match, re-verify the default.
  const sdk = readFileSync(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")), "utf8");
  assert.match(sdk, /env:[A-Za-z_$][\w$]*=\{\.\.\.process\.env\}/);
});
test("the installed Claude hook records into the FOREMAN_HOME it inherits", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "foreman-hook-routing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dev = join(root, "dev"), production = join(root, "production");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: production, FOREMAN_HOME: dev, CLAUDE_CONFIG_DIR: join(root, "claude") };
  const hook = spawnSync(resolve("hooks/foreman-hook"), ["session-start"], { input: JSON.stringify({ session_id: "sid-dev", cwd: "/tmp", source: "startup" }), env, encoding: "utf8" });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(JSON.parse(readFileSync(join(dev, "sessions", "sid-dev.json"), "utf8")).state, "idle");
  assert.equal(existsSync(join(production, ".foreman")), false, "nothing reached the default (production) home");
});
