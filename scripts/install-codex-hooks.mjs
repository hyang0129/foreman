#!/usr/bin/env node
// Installs observers only. Codex's /hooks review remains the trust authority.
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EVENTS } from "../hooks/codex-hook.mjs";
import { assertTestHome, realCodexHomes } from "../server/home-guard.mjs";

const marker = "--foreman-codex-hook=v1";
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const hookPath = resolve(dirname(fileURLToPath(import.meta.url)), "../hooks/codex-hook.mjs");

export async function install(options = {}) {
  let { uninstall = false, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), foremanHome = process.env.FOREMAN_HOME || join(homedir(), ".foreman") } = options;
  // Story #121: under node --test, never edit the real ~/.codex/hooks.json or pin the real ~/.foreman.
  assertTestHome(codexHome, { explicit: Boolean(options.codexHome || process.env.CODEX_HOME), variable: "CODEX_HOME", homes: realCodexHomes() });
  assertTestHome(foremanHome, { explicit: Boolean(options.foremanHome || process.env.FOREMAN_HOME) });
  codexHome = resolve(codexHome); foremanHome = resolve(foremanHome);
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const file = join(codexHome, "hooks.json");
  const lock = `${file}.foreman-install.lock`;
  await fs.mkdir(lock, { mode: 0o700 });
  let tmp;
  try {
    const info = await fs.lstat(file).catch((e) => { if (e.code !== "ENOENT") throw e; return null; });
    if (info && !info.isFile()) throw new Error("Refusing to replace a non-regular hooks.json");
    const original = info ? await fs.readFile(file, "utf8") : null;
    const config = original === null ? {} : JSON.parse(original);
    if (!isObject(config) || (config.hooks !== undefined && !isObject(config.hooks))) throw new Error("Invalid hooks.json object");
    const hooks = config.hooks ?? {};
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) throw new Error(`Invalid hook groups for ${event}`);
      hooks[event] = groups.flatMap((group) => {
        if (!isObject(group) || !Array.isArray(group.hooks)) throw new Error(`Invalid hook group for ${event}`);
        const remaining = group.hooks.filter((handler) => !(typeof handler.command === "string" && handler.command.endsWith(` ${marker}`)));
        return remaining.length ? [{ ...group, hooks: remaining }] : [];
      });
      if (!hooks[event].length) delete hooks[event];
    }
    if (!uninstall) {
      const command = `FOREMAN_HOME=${quote(foremanHome)} CODEX_HOME=${quote(codexHome)} ${quote(process.execPath)} ${quote(hookPath)} ${marker}`;
      for (const event of EVENTS) {
        // Synchronous observer completion preserves lifecycle ordering; no async callbacks.
        hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command, timeout: 3 }] }];
      }
    }
    if (Object.keys(hooks).length) config.hooks = hooks; else delete config.hooks;
    const output = `${JSON.stringify(config, null, 2)}\n`;
    if (original !== null && JSON.stringify(JSON.parse(original)) === JSON.stringify(config)) return { changed: false, file, backup: null };
    if (uninstall && original === null) return { changed: false, file, backup: null };
    const backup = original === null ? null : `${file}.bak-foreman-${Date.now()}-${randomUUID()}`;
    if (backup) await fs.writeFile(backup, original, { flag: "wx", mode: 0o600 });
    tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, output, { flag: "wx", mode: info ? info.mode & 0o777 : 0o600 });
    const current = await fs.readFile(file, "utf8").catch((e) => { if (e.code !== "ENOENT") throw e; return null; });
    if (current !== original) throw new Error("hooks.json changed during installation; retry after its other editor finishes");
    await fs.rename(tmp, file);
    return { changed: true, file, backup };
  } finally {
    if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
    await fs.rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--uninstall")) throw new Error("Usage: node scripts/install-codex-hooks.mjs [--uninstall]");
    const uninstall = process.argv.includes("--uninstall");
    const result = await install({ uninstall });
    console.log(`${result.changed ? (uninstall ? "Removed" : "Installed") : "No change to"} Foreman Codex hooks: ${result.file}`);
    if (result.backup) console.log(`Backup: ${result.backup}`);
    if (!uninstall) console.log("Open Codex /hooks, review and trust these definitions, then start or resume a session. This installer does not change hook trust. Existing sessions may retain their loaded hooks until restarted.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
