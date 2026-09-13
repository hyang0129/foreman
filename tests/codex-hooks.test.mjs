import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { EVENTS, recordEvent, reduceEvent, safeTranscript } from "../hooks/codex-hook.mjs";
import { install } from "../scripts/install-codex-hooks.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "foreman-hooks-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, codexHome: join(root, "codex ' $(no-command)"), foremanHome: join(root, "foreman") };
}
const input = (event, fields = {}) => ({ session_id: "thr_example-123", hook_event_name: event, ...fields });

test("Codex lifecycle, permissions, compaction, interruption and late-event guards", () => {
  let state = reduceEvent({}, input("SessionStart", { source: "startup" }));
  assert.equal(state.provider, "codex");
  state = reduceEvent(state, input("UserPromptSubmit", { turn_id: "turn1" }));
  state = reduceEvent(state, input("PermissionRequest", { turn_id: "turn1", tool_name: "Bash" }));
  assert.equal(state.state, "needs_input");
  assert.equal(state.reason, "permission");
  state = reduceEvent(state, input("SubagentStart", { turn_id: "turn1", agent_id: "child" }));
  assert.equal(state.state, "needs_input");
  state = reduceEvent(state, input("SubagentStart", { turn_id: "turn1", agent_id: "child" }));
  assert.equal(state.active_subagents, 1);
  state = reduceEvent(state, input("PostToolUse", { turn_id: "turn1" }));
  assert.equal(state.state, "working");
  state = reduceEvent(state, input("SessionStart", { source: "compact" }));
  assert.equal(state.state, "working");
  state = reduceEvent(state, input("Stop", { turn_id: "turn1", last_assistant_message: "done" }));
  assert.equal(state.last_message, "done");
  state = reduceEvent(state, input("SubagentStop", { turn_id: "turn1", agent_id: "child" }));
  assert.equal(state.active_subagents, 0);
  assert.equal(state.state, "turn_finished");
  assert.equal(reduceEvent(state, input("PostToolUse", { turn_id: "turn1" })), null);
  state = reduceEvent(state, input("UserPromptSubmit", { turn_id: "turn2" }));
  assert.equal(state.state, "working");
  assert.equal(reduceEvent(state, input("Stop", { turn_id: "turn1" })), null);
  state = reduceEvent(state, input("Interrupt", { turn_id: "turn2" }));
  assert.equal(state.reason, "interrupted");
  state = reduceEvent(state, input("SessionEnd", { reason: "other" }));
  assert.equal(state.state, "ended");
  assert.equal(reduceEvent(state, input("PreToolUse")), null);
  state = reduceEvent(state, input("SessionStart", { source: "resume" }));
  assert.equal(state.ended_at, null);
  assert.equal(state.state, "idle");
});

test("simultaneous subagent hooks serialize writes and never lose counters", async (t) => {
  const dirs = await fixture(t);
  await recordEvent(input("SessionStart"), dirs);
  await Promise.all(Array.from({ length: 24 }, (_, i) => recordEvent(input("SubagentStart", { agent_id: `child-${i}` }), dirs)));
  const file = join(dirs.foremanHome, "sessions/codex-thr_example-123.json");
  let state = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(state.active_subagents, 24);
  assert.equal(state.event_sequence, 25);
  await Promise.all(Array.from({ length: 24 }, (_, i) => recordEvent(input("SubagentStop", { agent_id: `child-${i}` }), dirs)));
  state = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(state.active_subagents, 0);
  assert.equal(state.event_sequence, 49);
  assert.deepEqual(await fs.readdir(join(dirs.foremanHome, "sessions")), ["codex-thr_example-123.json"]);
});

test("rejects traversal and outside or symlink-escaped transcripts without reading contents", async (t) => {
  const dirs = await fixture(t);
  assert.equal(await recordEvent(input("Stop", { session_id: "../../escape" }), dirs), false);
  assert.equal(await recordEvent(input("Notification"), dirs), false);
  const sessionDir = join(dirs.codexHome, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const transcript = join(sessionDir, "rollout.jsonl");
  const outside = join(dirs.root, "private.jsonl");
  await fs.writeFile(transcript, "not parsed");
  await fs.writeFile(outside, "must not be read");
  await fs.symlink(outside, join(sessionDir, "escape.jsonl"));
  assert.equal(await safeTranscript(outside, dirs.codexHome), null);
  assert.equal(await safeTranscript(join(sessionDir, "escape.jsonl"), dirs.codexHome), null);
  assert.equal(await safeTranscript(transcript, dirs.codexHome), await fs.realpath(transcript));
  await recordEvent(input("SessionStart", { transcript_path: transcript }), dirs);
  await recordEvent(input("Stop", { transcript_path: outside }), dirs);
  const file = join(dirs.foremanHome, "sessions/codex-thr_example-123.json");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).transcript_path, null);
  await fs.unlink(file);
  await fs.symlink(outside, file);
  await assert.rejects(recordEvent(input("SessionStart"), dirs));
  assert.equal(await fs.readFile(outside, "utf8"), "must not be read");
});

test("installer preserves unrelated settings and handlers, backups and idempotence", async (t) => {
  const dirs = await fixture(t);
  await fs.mkdir(dirs.codexHome, { recursive: true });
  const file = join(dirs.codexHome, "hooks.json");
  const other = { type: "command", command: "echo unrelated" };
  const original = { description: "Existing config", hooks: { Stop: [{ matcher: "keep", hooks: [other] }] } };
  await fs.writeFile(file, JSON.stringify(original));
  const first = await install(dirs);
  assert.equal(first.changed, true);
  assert.equal(await fs.readFile(first.backup, "utf8"), JSON.stringify(original));
  assert.equal((await install(dirs)).changed, false);
  let config = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(config.hooks.Stop[0], original.hooks.Stop[0]);
  assert.equal(config.description, original.description);
  assert.deepEqual(Object.keys(config.hooks).sort(), [...EVENTS].sort());
  const command = config.hooks.SessionStart[0].hooks[0].command;
  assert.equal(config.hooks.SessionStart[0].hooks[0].async, undefined);
  // Exercise shell escaping against paths containing apostrophes and command substitution.
  const result = await run("/bin/sh", ["-c", command], JSON.stringify(input("SessionStart")));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "{}\n");
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(await fs.readFile(join(dirs.foremanHome, "sessions/codex-thr_example-123.json"), "utf8")).provider, "codex");
  // A third party may add a handler to our matcher group; uninstall must keep it.
  config.hooks.Stop[1].hooks.push({ type: "command", command: "echo added" });
  await fs.writeFile(file, JSON.stringify(config));
  assert.equal((await install({ ...dirs, uninstall: true })).changed, true);
  config = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(config.hooks.Stop.length, 2);
  assert.equal(config.hooks.Stop[1].hooks[0].command, "echo added");
  assert.equal((await install({ ...dirs, uninstall: true })).changed, false);
  assert.equal((await fs.readdir(dirs.codexHome)).some((name) => name.includes("trust")), false);
});

test("malformed config stays intact; uninstall with no config does not create one", async (t) => {
  const dirs = await fixture(t);
  assert.equal((await install({ ...dirs, uninstall: true })).changed, false);
  const file = join(dirs.codexHome, "hooks.json");
  await fs.writeFile(file, "{broken");
  await assert.rejects(install(dirs));
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
});

test("CLI fails open with neutral JSON and never echoes invalid sensitive input", async () => {
  const result = await run(process.execPath, [resolve("hooks/codex-hook.mjs")], "invalid-secret-input");
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.ok(!result.stderr.includes("invalid-secret-input"));
});

function run(command, args, body) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(body);
  });
}
