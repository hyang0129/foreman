import { homedir, hostname } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FOREMAN_HOME = process.env.FOREMAN_HOME || join(homedir(), ".foreman");
export const SESSIONS_DIR = join(FOREMAN_HOME, "sessions");
export const MEMORY_DIR = join(FOREMAN_HOME, "memory");
export const PM_DIR = join(FOREMAN_HOME, "pm");
export const PM_SESSION_FILE = join(PM_DIR, "session");
export const PM_HISTORY_FILE = join(PM_DIR, "history.jsonl");
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CLAUDE_REGISTRY_DIR = join(CLAUDE_CONFIG_DIR, "sessions");
export const CLAUDE_BIN = process.env.FOREMAN_CLAUDE_BIN || "claude";
export const WARP_SPAWN = process.env.FOREMAN_WARP_SPAWN || join(homedir(), ".claude", "warp-playbook", "bin", "warp-spawn");
export const HOST = hostname().split(".")[0];
export const PORT = Number(process.env.FOREMAN_PORT || 4177);

export function ensureDirs() {
  for (const d of [FOREMAN_HOME, SESSIONS_DIR, MEMORY_DIR, PM_DIR]) mkdirSync(d, { recursive: true });
}
