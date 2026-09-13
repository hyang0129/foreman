// Native SendMessage proof against a separately launched, disposable headless CLI.
// A real interactive TTY/desktop session is a distinct, untested transport.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { ClaudeControl } from "../server/claude-control.ts";
import { CLAUDE_BIN } from "../server/paths.ts";

if (!process.argv.includes("--live")) {
  console.log("Run with --live to test native messaging between two disposable Claude sessions (model usage applies).");
  process.exit(0);
}
const cwd = await mkdtemp(join(tmpdir(), "foreman-claude-peer-"));
const targetId = randomUUID(), targetName = `foreman-probe-${randomUUID().slice(0, 8)}`, token = randomUUID();
const events = new EventEmitter();
const received: any[] = [];
const target = spawn(CLAUDE_BIN, ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--session-id", targetId, "--name", targetName, "--model", "haiku", "--max-budget-usd", "0.20",
  "--setting-sources", "", "--strict-mcp-config", "--tools", "", "--system-prompt",
  "You are an isolated messaging probe. Reply exactly as requested to each message, including peer messages. Never use tools. Never send a message back."],
{ cwd, stdio: ["pipe", "pipe", "pipe"] });
let buffer = "", stderr = "";
let exited = false;
const targetClosed = new Promise<void>((resolve) => {
  target.on("close", () => { exited = true; events.emit("closed"); resolve(); });
});
target.on("error", (error) => { stderr += String(error); events.emit("closed"); });
target.stderr.on("data", (chunk) => { stderr += chunk; });
target.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try { const message = JSON.parse(line); received.push(message); events.emit("message", message); } catch {}
  }
});
function waitMessage(predicate: (message: any) => boolean, timeout = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Receiver message timeout")); }, timeout);
    const onMessage = (message: any) => { if (predicate(message)) { cleanup(); resolve(message); } };
    const onClose = () => { cleanup(); reject(new Error(`Receiver closed: ${stderr.slice(-400)}`)); };
    const cleanup = () => { clearTimeout(timer); events.off("message", onMessage); events.off("closed", onClose); };
    events.on("message", onMessage); events.on("closed", onClose);
    const found = received.find(predicate); if (found) onMessage(found); else if (exited) onClose();
  });
}
let sender: ClaudeControl | undefined;
const senderMessages: any[] = [];
try {
  target.stdin.write(JSON.stringify({ type: "user", session_id: targetId, parent_tool_use_id: null, message: { role: "user", content: "Reply READY. Then await future messages." } }) + "\n");
  const initialResult = await waitMessage((message) => message.type === "result" && !message.is_error);
  sender = new ClaudeControl({ cwd, model: "haiku", maxBudgetUsd: 0.25, maxTurns: 4, settingSources: [], tools: ["SendMessage"],
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    systemPrompt: "You are an isolated messaging probe. Only use SendMessage to the exact recipient provided by the user, once. Do not list or message any other sessions." });
  sender.on("approval", (request) => {
    sender!.respondApproval(request.id, request.tool === "SendMessage" && request.input.to === targetName ? "allow" : "deny");
  });
  sender.on("message", (message) => senderMessages.push(message));
  sender.send(`Use SendMessage to send to ${targetName} exactly: "Reply only with ${token}". Do not request any idle notification or reply. Then report whether delivery succeeded.`);
  const response = await waitMessage((message) => message.type === "result" && message !== initialResult);
  const tools = senderMessages.filter((message) => message.type === "assistant").flatMap((message) => message.message.content.filter((block: any) => block.type === "tool_use"));
  const sent = tools.some((tool) => tool.name === "SendMessage" && tool.input.to === targetName && JSON.stringify(tool.input).includes(token));
  if (!sent) throw new Error("Sender did not issue the expected targeted SendMessage");
  console.log(JSON.stringify({ transportDelivered: true, receiverFollowedRequest: response.result?.includes(token) ?? false,
    targetId, targetName, targetWasIndependentlySpawned: true, targetStayedRunning: !exited,
    targetMode: "headless stream-json CLI; TTY and desktop still untested", response: response.result,
    sendTools: tools, targetCostUsd: response.total_cost_usd }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, error: String(error), targetId, receiverTypes: received.map((message) => message.type),
    senderResults: senderMessages.filter((message) => ["result", "user"].includes(message.type)), stderr: stderr.slice(-500) }, null, 2));
  process.exitCode = 1;
} finally {
  sender?.close(); await sender?.finished;
  target.kill("SIGTERM");
  const killTimer = setTimeout(() => target.kill("SIGKILL"), 5000);
  await targetClosed; clearTimeout(killTimer);
  await rm(cwd, { recursive: true, force: true });
}
