import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeControl } from "../server/claude-control.ts";

function harness(policy?: "read-only" | "workspace" | "trusted" | "full") {
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
  const control = new ClaudeControl({ cwd: "/tmp", tools: [], permission_mode: policy }, factory as any);
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
  assert.match(allowed.updatedInput.command, /sandbox-exec/);
  assert.match(allowed.updatedInput.command, /pwd/);
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

for (const policy of ['read-only', 'workspace', 'trusted', 'full'] as const) {
  test(`Claude ${policy} guards auto-approved tools and never widens its policy`, async () => {
    const h = harness(policy); await tick();
    try {
      assert.equal(h.control.permission_mode, policy);
      assert.equal(h.options().permissionMode, policy === 'full' ? 'bypassPermissions' : policy === 'workspace' ? 'default' : 'dontAsk');
      const hook = h.options().hooks.PreToolUse[0].hooks[0];
      const check = async (tool_name: string, tool_input: any) => (await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input })).hookSpecificOutput;
      assert.equal((await check('Read', { file_path: '/tmp/ordinary.txt' })).permissionDecision, 'allow');
      for (const tool of ['Read', 'Write']) assert.equal((await check(tool, { file_path: '/tmp/.claude/settings.json' })).permissionDecision, 'deny');
      assert.equal((await check('ExitPlanMode', {})).permissionDecision, 'deny');
      const command = await check('Bash', { command: 'pwd' });
      assert.equal(command.permissionDecision, policy === 'workspace' ? 'ask' : 'allow');
      if (policy !== 'workspace') assert.match(command.updatedInput.command, /sandbox-exec/);
      if (policy === 'read-only') assert.equal((await check('Write', { file_path: '/tmp/new.txt' })).permissionDecision, 'deny');
      assert.equal(h.control.pendingApprovals().length, 0);
    } finally { h.control.close(); await h.control.finished; }
  });
}

test('Claude refuses an effective provider mode different from its launch policy', {timeout:1000}, async (t) => {
  const h = harness('workspace'); await tick();
  t.after(() => h.control.close());
  h.emit({type:'system',subtype:'init',session_id:'test',permissionMode:'bypassPermissions'});
  await h.control.finished;
  assert.equal(h.control.state, 'failed');
});

test('approval responses cannot swap guarded Bash input for raw commands', async (t) => {
  const h = harness(); t.after(() => h.control.close()); await tick();
  const pending = h.options().canUseTool('Bash', {command:'pwd'}, {signal:new AbortController().signal,toolUseID:'immutable'});
  assert.throws(() => h.control.respondApproval('immutable','allow',{command:'touch /tmp/swapped'}), /cannot change/);
  assert.equal(h.control.pendingApprovals().length, 1);
  h.control.respondApproval('immutable','allow');
  assert.match((await pending).updatedInput.command, /sandbox-exec/);
});

test('Claude Workspace escape is explicit, described, and effective only after exact approval', {timeout:5000}, async (t) => {
  const {mkdtempSync,mkdirSync,existsSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const {spawnSync} = await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'foreman-claude-grant-')), project=join(dir,'project');mkdirSync(project);
  const h=harness('workspace'); (h.control as any).cwd=project;
  t.after(()=>{h.control.close();rmSync(dir,{recursive:true,force:true});});await tick();
  const target=join(dir,'outside');
  const pending=h.options().canUseTool('Bash',{command:`touch '${target}'`,dangerouslyDisableSandbox:true},{signal:new AbortController().signal,toolUseID:'escape'});
  assert.equal(existsSync(target),false);
  const request=h.control.pendingApprovals()[0];assert.match(request.reason!,/outside-project read\/write/);
  assert.match(String(request.input.guarded_command),/sandbox-exec/);
  h.control.respondApproval('escape','allow');
  const granted=await pending;
  assert.equal(spawnSync('/bin/sh',['-c',granted.updatedInput.command]).status,0);
  assert.equal(existsSync(target),true);
});
