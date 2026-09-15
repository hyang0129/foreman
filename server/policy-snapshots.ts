import { readdirSync, lstatSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A marker limits sweeping to our own snapshots. EPERM and PID reuse preserve
// a directory conservatively; unknown/legacy directories are never deleted.
export function sweepPolicySnapshots(root = tmpdir()) {
  for (const name of readdirSync(root)) {
    if (!name.startsWith('foreman-policy-')) continue;
    const directory = join(root, name);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) continue;
      const owner = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8'));
      if (owner.kind !== 'foreman-policy-v1' || !Number.isInteger(owner.pid) || owner.pid <= 0) continue;
      try { process.kill(owner.pid, 0); } catch (error: any) {
        if (error.code === 'ESRCH') rmSync(directory, {recursive:true,force:true});
      }
    } catch { /* Unknown directories are not ours to remove. */ }
  }
}
export function policySnapshot(root = tmpdir()) {
  sweepPolicySnapshots(root);
  const directory = mkdtempSync(join(root, 'foreman-policy-'));
  writeFileSync(join(directory, 'owner.json'), JSON.stringify({kind:'foreman-policy-v1',pid:process.pid}), {mode:0o600});
  return directory;
}
