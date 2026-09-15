import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {sweepPolicySnapshots,policySnapshot} from '../server/policy-snapshots.ts';

test('startup sweep removes dead owners and preserves live, unknown, and symlinked snapshots', (t) => {
 const root=mkdtempSync(join(tmpdir(),'foreman-snapshot-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const live=policySnapshot(root), dead=policySnapshot(root), unknown=join(root,'foreman-policy-unknown');mkdirSync(unknown);
 const ended=spawnSync(process.execPath,['-e','']);assert.ok(ended.pid);
 writeFileSync(join(dead,'owner.json'),JSON.stringify({kind:'foreman-policy-v1',pid:ended.pid}));
 const alias=join(root,'foreman-policy-alias');symlinkSync(dead,alias);
 sweepPolicySnapshots(root);
 assert.equal(existsSync(dead),false);assert.equal(existsSync(live),true);assert.equal(existsSync(unknown),true);
});


test('a SIGKILL orphan is removed at the next snapshot startup sweep', (t) => {
 const root=mkdtempSync(join(tmpdir(),'foreman-kill-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const module=new URL('../server/policy-snapshots.ts',import.meta.url).href;
 const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import {policySnapshot} from ${JSON.stringify(module)}; import {writeSync} from 'node:fs'; writeSync(1,policySnapshot(${JSON.stringify(root)})); process.kill(process.pid,'SIGKILL');`],{encoding:'utf8'});
 assert.equal(child.signal,'SIGKILL');assert.equal(existsSync(child.stdout),true);
 sweepPolicySnapshots(root);assert.equal(existsSync(child.stdout),false);
});
