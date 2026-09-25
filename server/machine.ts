// Machine identity (epic #26, contract A): one stable `machine_id` per FOREMAN_HOME, stored in
// `<FOREMAN_HOME>/machine.json` as `{ machine_id, name }` with mode 0600. A second FOREMAN_HOME on
// the same computer is therefore a second machine. `name` defaults to the short hostname (HOST);
// `FOREMAN_MACHINE_NAME` overrides it (and the override is persisted, keeping the machine_id).

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FOREMAN_HOME, HOST } from './paths.ts';
import { isMachineName, MAX_MACHINE_NAME, parseMachineIdentity, type MachineIdentity } from '../shared/pm-state.ts';

export type { MachineIdentity };

export const MACHINE_FILE_NAME = 'machine.json';
const FALLBACK_NAME = 'foreman-host';

export function machineFilePath(home: string = FOREMAN_HOME): string {
  return join(home, MACHINE_FILE_NAME);
}

/** A valid display name derived from the hostname: control characters removed, at most 80 chars. */
export function defaultMachineName(host: string = HOST): string {
  const cleaned = String(host ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_MACHINE_NAME).trim();
  return isMachineName(cleaned) ? cleaned : FALLBACK_NAME;
}

/** The name this process should use: `FOREMAN_MACHINE_NAME` when set (must be valid), else the hostname. */
export function configuredMachineName(env: NodeJS.ProcessEnv = process.env, host: string = HOST): string {
  const override = env.FOREMAN_MACHINE_NAME;
  if (override !== undefined && override !== '') {
    const name = override.trim();
    if (!isMachineName(name)) throw new Error(`FOREMAN_MACHINE_NAME must be 1-${MAX_MACHINE_NAME} printable characters`);
    return name;
  }
  return defaultMachineName(host);
}

function writeIdentity(path: string, identity: MachineIdentity): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(identity) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Reads `<home>/machine.json`, creating it on first use. The machine_id is never regenerated for an
 * existing file: a malformed or non-regular file is an error rather than a silent new identity
 * (which would register this home as a different machine). A file with looser permissions is
 * tightened to 0600. An explicit `FOREMAN_MACHINE_NAME` that differs from the stored name is
 * persisted; without it the stored name is kept.
 */
export function loadMachineIdentity(options: { home?: string; env?: NodeJS.ProcessEnv; host?: string } = {}): MachineIdentity {
  const home = options.home ?? FOREMAN_HOME;
  const env = options.env ?? process.env;
  const path = machineFilePath(home);
  const name = configuredMachineName(env, options.host ?? HOST);
  const explicit = env.FOREMAN_MACHINE_NAME !== undefined && env.FOREMAN_MACHINE_NAME !== '';
  mkdirSync(home, { recursive: true });
  if (!existsSync(path)) {
    const identity: MachineIdentity = { machine_id: randomUUID(), name };
    writeIdentity(path, identity);
    return identity;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('machine.json must be a regular file');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('machine.json must be owned by this user');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Invalid machine.json'); }
  const parsed = parseMachineIdentity(raw);
  if (!parsed.ok) throw new Error(`Invalid machine.json: ${parsed.error}`);
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o600);
  if (explicit && parsed.value.name !== name) {
    const identity = { machine_id: parsed.value.machine_id, name };
    writeIdentity(path, identity);
    return identity;
  }
  return parsed.value;
}
