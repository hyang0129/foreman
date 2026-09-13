// Explicit opt-in live probe: creates only disposable sessions and denies its test tool request.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ClaudeControl, type ClaudeReceipt } from "../server/claude-control.ts";
import { CLAUDE_BIN } from "../server/paths.ts";

if (!process.argv.includes("--live")) {
  console.log("Run with --live to make bounded Claude model calls in disposable directories (subscription/API usage applies).");
  process.exit(0);
}

const cwd = await mkdtemp(join(tmpdir(), "foreman-claude-probe-"));
const controllers: ClaudeControl[] = [];
const summary: Record<string, unknown> = { cwd, liveAttachment: "not tested; resume is a handoff after the original process exits" };
const options = { cwd, model: process.env.FOREMAN_PROBE_CLAUDE_MODEL || "haiku", maxBudgetUsd: 0.30, maxTurns: 5,
  settingSources: [], pathToClaudeCodeExecutable: CLAUDE_BIN,
  systemPrompt: "You are a session-control integration probe. Follow the user's exact instructions concisely. Never access files or network." } as const;

function waitFor(controller: ClaudeControl, receipt: ClaudeReceipt): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${receipt.id}`)); }, 90000);
    const check = (value: ClaudeReceipt) => {
      if (value.id !== receipt.id || !["completed", "failed"].includes(value.status)) return;
      cleanup();
      if (value.status === "failed") reject(new Error(value.error || JSON.stringify(value.result)));
      else resolve(value.result);
    };
    const cleanup = () => { clearTimeout(timer); controller.off("receipt", check); };
    controller.on("receipt", check); check(receipt);
  });
}

try {
  const control = new ClaudeControl({ ...options, settingSources: [], tools: ["Bash"], settings: { permissions: { ask: ["Bash"] } } });
  controllers.push(control);
  const states: string[] = [];
  control.on("state", (state) => states.push(state));
  let approvalCount = 0;
  control.on("approval", (request) => { approvalCount++; control.respondApproval(request.id, "deny"); });
  const nonce = randomUUID();
  const first = control.send(`Remember the token ${nonce}. Reply only READY.`);
  const second = control.send("What is the token from my previous message? Reply with only that token.");
  const firstResult = await waitFor(control, first);
  const secondResult = await waitFor(control, second);
  if (!secondResult.result?.includes(nonce)) throw new Error("Queued follow-up did not preserve session context");
  const approvalResult = await waitFor(control, control.send("Call Bash with exactly: printf FOREMAN_APPROVAL_PROBE. This is a permission-denial test: if denied, do not retry or use other tools; reply DENIED."));
  if (!approvalCount) throw new Error("No permission request reached the controller");
  summary.managed = { sessionId: control.sessionId, queuedFollowup: "passed", deniedToolApproval: "passed", approvalCount, states,
    costUsd: approvalResult.total_cost_usd, first: firstResult.result, second: secondResult.result };
  control.close(); await control.finished;

  const externalId = randomUUID();
  const handoffToken = randomUUID();
  const external = await new Promise<any>((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ["--print", "--output-format", "json", "--session-id", externalId,
      "--model", options.model, "--max-budget-usd", "0.15", "--setting-sources", "", "--strict-mcp-config", "--tools", "",
      "--system-prompt", options.systemPrompt, `Remember the token ${handoffToken}. Reply READY.`], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, 90000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`External Claude exited ${code}: ${stderr.slice(-500)}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  if (external.is_error) throw new Error(JSON.stringify(external));
  const resumed = new ClaudeControl({ ...options, settingSources: [], tools: [], resume: externalId });
  controllers.push(resumed);
  const resumedResult = await waitFor(resumed, resumed.send("What token did I ask you to remember? Reply with only that token."));
  if (!resumedResult.result?.includes(handoffToken)) throw new Error("Stopped external-session resume did not preserve context");
  summary.externalHandoff = { sessionId: externalId, result: "passed", originalProcessExitedBeforeResume: true,
    costUsd: external.total_cost_usd + resumedResult.total_cost_usd };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ...summary, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  for (const controller of controllers) controller.close();
  await Promise.all(controllers.map((controller) => controller.finished));
  await rm(cwd, { recursive: true, force: true });
}
