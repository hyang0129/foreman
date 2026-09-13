import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeControl } from "../server/claude-control.ts";

function harness() {
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
  const control = new ClaudeControl({ cwd: "/tmp", tools: [] }, factory as any);
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
  assert.deepEqual(await request, { behavior: "allow", updatedInput: { command: "pwd" } });
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
