import { homedir, hostname } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { assertTestHome } from "./home-guard.mjs";
import { resolveClaudeBin } from "./claude-bin.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FOREMAN_HOME = process.env.FOREMAN_HOME || join(homedir(), ".foreman");
// Story #121: under `node --test`, refuse the default or the real ~/.foreman (~/.foreman-dev) at
// import, before any server module can write there. Tests pin FOREMAN_HOME to a mkdtemp dir.
assertTestHome(FOREMAN_HOME, { explicit: Boolean(process.env.FOREMAN_HOME) });
export const SESSIONS_DIR = join(FOREMAN_HOME, "sessions");
export const MEMORY_DIR = join(FOREMAN_HOME, "memory");
export const PM_DIR = join(FOREMAN_HOME, "pm");
export const LOCAL_API_TOKEN_NAME = "local-api-token";
export const LOCAL_API_TOKEN_FILE = join(FOREMAN_HOME, LOCAL_API_TOKEN_NAME);
// Epic #26: this FOREMAN_HOME's machine identity, and the local-only PM state store.
export const MACHINE_FILE = join(FOREMAN_HOME, "machine.json");
export const PM_LOCAL_STATE_FILE = join(PM_DIR, "state.json");
// Epic #157: Project Lead handoff logs (`<uuid>.jsonl`) and the DO outbox (`outbox.json`); dir 0700, files 0600.
export const LEADS_DIR = join(FOREMAN_HOME, "leads");
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CLAUDE_REGISTRY_DIR = join(CLAUDE_CONFIG_DIR, "sessions");
// #155: FOREMAN_CLAUDE_BIN, else the installed `claude` on this process's PATH (the service's explicit
// PATH under launchd), else the binary bundled with the Agent SDK. See claude-bin.ts.
export const BUNDLED_CLAUDE_BIN = join(REPO_ROOT, "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`, "claude");
export const CLAUDE_BIN_CHOICE = resolveClaudeBin({ bundled: BUNDLED_CLAUDE_BIN });
export const CLAUDE_BIN = CLAUDE_BIN_CHOICE.path;
export const WARP_SPAWN = process.env.FOREMAN_WARP_SPAWN || join(homedir(), ".claude", "warp-playbook", "bin", "warp-spawn");
export const HOST = hostname().split(".")[0];
export const PORT = Number(process.env.FOREMAN_PORT || 4177);

export function ensureDirs() {
  for (const d of [FOREMAN_HOME, SESSIONS_DIR, MEMORY_DIR, PM_DIR]) mkdirSync(d, { recursive: true });
}
