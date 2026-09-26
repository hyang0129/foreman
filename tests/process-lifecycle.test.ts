import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnOwnedProcess } from '../server/owned-process.ts';
import { ProcessTree, processTable, type ProcessEntry } from '../server/process-tree.ts';

// Supervisors inherit this env: keep their compiled helper cache (#104) in a temp dir.
const helperCache = mkdtempSync(join(tmpdir(), 'foreman-lifecycle-helper-'));
process.env.FOREMAN_PROCESS_HELPER_DIR = helperCache;
test.after(() => rmSync(helperCache, { recursive: true, force: true }));
const fixture = fileURLToPath(new URL('./fixtures/process-provider.mjs', import.meta.url));
// Polls a process-table condition that has no event to wait on (a process exiting or being reaped
// outside this test's control). No budget of its own: it ends when the test's timeout aborts `signal`.
async function until<T>(check: () => T | false, signal: AbortSignal) {
  for (;;) {
    const value = check(); if (value) return value;
    if (signal.aborted) throw new Error('process-table condition not reached before the test timed out');
    await delay(50);
  }
}
function row(pid: number, ppid: number, pgid: number, started = 'one'): ProcessEntry { return {pid,ppid,pgid,started,stat:'S'}; }
test('ownership follows detached descendants and retains groups after leaders exit, but rejects reused PIDs', () => {
  const tree = new ProcessTree(100);
  assert.deepEqual(tree.sample([row(100,1,100),row(101,100,101),row(102,101,101),row(200,1,200)]).map((r) => r.pid), [100,101,102]);
  assert.deepEqual(tree.sample([row(102,1,101),row(103,1,101),row(200,1,200)]).map((r) => r.pid), [102,103]);
  assert.deepEqual(tree.sample([row(102,1,102,'reused'),row(200,1,200)]), []);
});
for (const action of ['close', 'provider-crash', 'provider-kill', 'owner-kill'] as const) {
  test(`owned process ${action} removes the detached shell and its child from ps`, {timeout:15000}, async (t) => {
    // Keep an unrelated sentinel alive to catch overbroad process-group kills.
    const sentinel = spawn('sleep', ['120'], {detached:true,stdio:'ignore'});
    let child: ReturnType<typeof spawnOwnedProcess> | ReturnType<typeof spawn>;
    if (action === 'owner-kill') {
      child = spawn(process.execPath, ['--experimental-strip-types','--input-type=module','-e',
        `import {spawnOwnedProcess} from ${JSON.stringify(new URL('../server/owned-process.ts',import.meta.url).href)};
         const child = spawnOwnedProcess(process.execPath, [${JSON.stringify(fixture)}]); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);`],
        {detached:true,stdio:['pipe','pipe','pipe']});
    } else child = spawnOwnedProcess(process.execPath, [fixture]);
    let output = '', stderr = ''; child.stdout!.on('data',(chunk) => { output += chunk; });
    child.stderr!.on('data',(chunk) => { stderr += chunk; });
    const exited = once(child,'exit');
    // Wait for the provider's own report, not a fixed poll budget: launching the supervisor, its
    // process helper and the provider has no upper bound on a loaded machine (#182, #184). An
    // early exit of the owned process fails the test with its stderr instead of hanging.
    const reported = new Promise<{provider:number;shell:number;sleep:number}>((resolve, reject) => {
      child.stdout!.on('data', () => { if (output.includes('\n')) resolve(JSON.parse(output.trim())); });
      void exited.then(([code, signal]) => reject(new Error(`owned process exited (${signal ?? code}) before the provider reported: ${stderr}`)));
    });
    let pids: {provider:number;shell:number;sleep:number} | undefined;
    try {
      pids = await reported;
      const started = processTable().filter((r) => Object.values(pids!).includes(r.pid));
      assert.equal(started.length,3); assert.equal(started.find((r) => r.pid === pids!.shell)?.pgid,pids!.shell);
      // Exercise already-running commands; the live suite covers actual Codex startup timing.
      await delay(150);
      if (action === 'provider-crash') child.stdin!.write('crash\n');
      else if (action === 'provider-kill') process.kill(pids!.provider,'SIGKILL');
      else child.kill(action === 'owner-kill' ? 'SIGKILL' : 'SIGTERM');
      await exited;
      // The supervisor's exit means cleanup has finished (server/owned-process.ts): nothing it owned
      // may still run. owner-kill's exit is the owner's, so its supervisor is still cleaning up.
      if (action !== 'owner-kill') assert.deepEqual(processTable().filter((r) => Object.values(pids!).includes(r.pid) && !r.stat.startsWith('Z')), []);
      await until(() => !processTable().some((r) => Object.values(pids!).includes(r.pid)), t.signal);
      assert.ok(processTable().some((r) => r.pid === sentinel.pid));
    } finally {
      child.kill('SIGTERM'); sentinel.kill('SIGKILL');
      if (pids) for (const pid of [pids.provider,pids.shell]) { try { process.kill(-pid,'SIGKILL'); } catch {} }
    }
  });
}

test('macOS immediate provider death cannot hide a newly detached child between samples', {skip:process.platform !== 'darwin',timeout:15000}, async (t) => {
  // No readiness delay: the provider dies synchronously after spawn. This leaked
  // in every trial with ps-only ancestry; the original parent identity is needed.
  for (let attempt=0;attempt<5;attempt++) {
    const child = spawnOwnedProcess(process.execPath,['-e', `
      const worker = require('child_process').spawn('/bin/sleep',['120'],{detached:true,stdio:'ignore'});
      require('fs').writeSync(1,String(worker.pid)+'\\n');
      process.kill(process.pid,'SIGKILL');`]);
    let output = ''; child.stdout.on('data',(chunk) => { output += chunk; }); child.stderr.resume();
    await once(child,'exit');
    const pid = Number(output.trim()); assert.ok(pid > 1);
    try { await until(() => !processTable().some((row) => row.pid === pid), t.signal); }
    finally { try { process.kill(-pid,'SIGKILL'); } catch {} }
  }
});
