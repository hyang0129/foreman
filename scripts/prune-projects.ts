#!/usr/bin/env node
// #234: drop auto-registered worktrees, temp dirs, $HOME, Foreman state and missing directories
// from FOREMAN_HOME/projects.json. Dry-run by default; `--apply` rewrites the file after a backup.
// Usage: node scripts/prune-projects.ts [--apply]
//
// The running daemon holds the registry in memory and rewrites projects.json on its next save,
// which would undo this edit, so the script refuses while anything listens on FOREMAN_PORT.
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FOREMAN_HOME, PORT } from '../server/paths.ts';
import { ProjectRegistry } from '../server/projects.ts';
import { assertPortAvailable } from './service.mjs';

const args = process.argv.slice(2), apply = args.includes('--apply');
if (args.some((arg) => arg !== '--apply')) { console.error('Usage: node scripts/prune-projects.ts [--apply]'); process.exit(2); }
try { await assertPortAvailable(PORT); } catch {
  console.error(`Foreman appears to be running on 127.0.0.1:${PORT}. Stop it first (launchctl bootout gui/$(id -u)/com.foreman.daemon, or stop npm start), then rerun. Nothing was changed.`);
  process.exit(1);
}
const file = join(FOREMAN_HOME, 'projects.json');
if (!existsSync(file)) { console.log(`No registry at ${file}. Nothing to prune.`); process.exit(0); }
const registry = new ProjectRegistry(FOREMAN_HOME), total = registry.list().length;
const dropped = registry.prune({ dryRun: true });
for (const p of dropped) console.log(`drop  ${p.name}  ${p.path}${p.canonicalPath !== p.path ? ` -> ${p.canonicalPath}` : ''}`);
console.log(`${dropped.length} of ${total} entries in ${file} ${apply ? 'will be' : 'would be'} dropped; ${total - dropped.length} kept.`);
if (!apply) { if (dropped.length) console.log('Dry run. Rerun with --apply to rewrite the registry.'); process.exit(0); }
if (!dropped.length) process.exit(0);
const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(file, backup);
registry.prune();
console.log(`Pruned. Backup: ${backup}`);
