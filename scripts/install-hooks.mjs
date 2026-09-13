#!/usr/bin/env node
// Installs (or removes, with --uninstall) the foreman hook entries in ~/.claude/settings.json.
// Idempotent: existing foreman entries are replaced. A timestamped backup is written first.
import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, "..", "hooks", "foreman-hook");
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const settingsPath = join(configDir, "settings.json");
const uninstall = process.argv.includes("--uninstall");
const MARK = "foreman-hook";

if (!existsSync(hookPath)) throw new Error(`hook script missing: ${hookPath}`);
chmodSync(hookPath, 0o755);

const cmd = (event) => `"${hookPath}" ${event}`;
const entry = (event, { matcher, async = true, timeout } = {}) => {
  const h = { type: "command", command: cmd(event) };
  if (async) h.async = true;
  if (timeout) h.timeout = timeout;
  const e = { hooks: [h] };
  if (matcher) e.matcher = matcher;
  return e;
};

// Event name -> entries. SessionEnd runs synchronously (1.5 s budget) so the record lands before exit.
const wanted = {
  SessionStart: [entry("session-start")],
  UserPromptSubmit: [entry("prompt")],
  PreToolUse: [entry("tool")],
  PermissionRequest: [entry("permission")],
  Notification: [entry("notification", { matcher: "permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog" })],
  Stop: [entry("stop")],
  PostToolUseFailure: [entry("tool-failed")],
  SubagentStart: [entry("subagent-start")],
  SubagentStop: [entry("subagent-stop")],
  SessionEnd: [entry("session-end", { async: false, timeout: 5 })],
};

const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
const backup = `${settingsPath}.bak-foreman-${new Date().toISOString().replace(/[:.]/g, "-")}`;
if (existsSync(settingsPath)) copyFileSync(settingsPath, backup);

const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
const isOurs = (e) => (e.hooks || []).some((h) => typeof h.command === "string" && h.command.includes(MARK));

// Strip any existing foreman entries from every event.
for (const ev of Object.keys(hooks)) {
  hooks[ev] = (hooks[ev] || []).filter((e) => !isOurs(e));
  if (hooks[ev].length === 0) delete hooks[ev];
}
if (!uninstall) {
  for (const [ev, entries] of Object.entries(wanted)) {
    hooks[ev] = [...(hooks[ev] || []), ...entries];
  }
}
if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`${uninstall ? "Removed" : "Installed"} foreman hooks in ${settingsPath}`);
console.log(`Backup: ${backup}`);
console.log(`Hook script: ${hookPath}`);
if (!uninstall) console.log("Applies to sessions started from now on; running sessions keep their old hook set.");
