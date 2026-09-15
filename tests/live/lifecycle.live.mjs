import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

if (process.env.FOREMAN_LIVE !== '1') {
  test('live Codex lifecycle (set FOREMAN_LIVE=1)', {skip:'spends real provider turns'}, () => {});
} else {
  const {Harness,until,quote,join,existsSync,randomUUID,processRows,commandProcesses,assertProcessesGone,assertSuccess,readFileSync} = await import('./harness.mjs');
  async function control(h,row,action) {
    const seq = ++h.sequence;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error(`lifecycle ${action} timed out`)),10000);
      h.responses.set(seq,(message) => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message.result); });
      h.child.send({type:'lifecycle',seq,cwd:row.cwd,threadId:row.session_id,action});
    });
  }
  for (const action of ['interrupt','close','thread-archive','provider-kill','provider-crash','provider-crash-at-spawn','background-close','daemon-shutdown','daemon-kill']) {
    test(`live Codex ${action} leaves no command process group`, {timeout:120000}, async (t) => {
      const h = new Harness(); t.after(() => h.close()); await h.start();
      const f = h.fixture(); const row = await h.create('codex','bypass',f); await h.idle(row);
      row.session_id = (await h.api(`/api/session?id=${encodeURIComponent(row.session_key)}`)).session.session_id;
      const {watchdog} = await control(h,row,'info');
      const marker = join(f.project,'started');
      const initialRows = processRows(); const initialIds = new Set([watchdog]);
      for (let i=0;i<10;i++) for (const r of initialRows) if (initialIds.has(r.ppid)) initialIds.add(r.pid);
      const native = initialRows.find((r) => initialIds.has(r.pid) && /\/codex app-server(?:\s|$)/.test(r.command));
      assert.ok(native, 'Identify actual native Codex binary before the test command');
      const command = action === 'provider-crash-at-spawn'
        ? `sleep 120 & ps -o pid=,ppid=,pgid=,stat= -p "$$,$!" > ${quote(marker + ".tmp")} && mv ${quote(marker + ".tmp")} ${quote(marker)}; kill -KILL ${native.pid}; wait; printf finished > ${quote(join(f.project,'finished'))}`
        : action === 'background-close'
        ? `sleep 120 >/dev/null 2>&1 & ps -o pid=,ppid=,pgid=,stat= -p "$$,$!" > ${quote(marker + ".tmp")} && mv ${quote(marker + ".tmp")} ${quote(marker)}`
        : `printf started > ${quote(marker)} && sleep 120 && printf finished > ${quote(join(f.project,'finished'))}`;
      const receipt = await h.api('/api/session/message',{id:row.session_key,message_id:randomUUID(),text:h.shell(row,command)+' Run exactly once. This is an owner-authorized lifecycle test. Do not inspect any configuration.'});
      await until(() => existsSync(marker),'native command must actually start');
      const before = ['provider-crash-at-spawn','background-close'].includes(action)
        ? readFileSync(marker,'utf8').trim().split('\n').map((line) => {
          const [pid,ppid,pgid,stat] = line.trim().split(/\s+/); return {pid:Number(pid),ppid:Number(ppid),pgid:Number(pgid),stat,command:''};
        }) : commandProcesses(marker);
      assert.ok(before.length >= 2, 'The live command must record its shell and child in ps');
      if (!['provider-crash-at-spawn','background-close'].includes(action)) assert.ok(before.some((r) => /sleep 120/.test(r.command) && !r.command.includes(marker)), 'sleep child must appear separately in ps');
      t.diagnostic(`Before ${action}: ${JSON.stringify(before.map(({pid,ppid,pgid,stat}) => ({pid,ppid,pgid,stat})))}`);
      // Capture every provider descendant for close/crash checks, not just the shell.
      const rows = processRows(); const ids = new Set([watchdog]);
      for (let i=0;i<10;i++) for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
      const owned = [...initialRows.filter((r) => initialIds.has(r.pid)), ...rows.filter((r) => ids.has(r.pid)), ...before];
      try {
        if (action === 'interrupt') {
          await h.api('/api/session/interrupt',{id:row.session_key});
          await until(async () => {
            const detail = await h.api(`/api/session?id=${encodeURIComponent(row.session_key)}`);
            return detail.receipts.some((r) => r.id === receipt.id && ['failed','completed'].includes(r.status));
          },'interrupted receipt settles');
        } else if (action === 'background-close') {
          await h.idle(row);
          await control(h,row,'close');
        } else if (action === 'provider-crash-at-spawn') {
          // The exact native command killed its own provider immediately after
          // recording the process table, with no sampling/readiness delay.
        } else if (action === 'close') await control(h,row,'close');
        else if (action === 'thread-archive') { const result = await control(h,row,'archive'); t.diagnostic(`Archive reply: ${JSON.stringify(result)}; thread transitions: ${h.events.filter((e) => ['thread/archived','thread/closed','thread/status/changed'].includes(e.kind)).map((e) => e.params?.status?.type ?? e.kind).join(', ')}`); }
        else if (action.startsWith('provider-')) {
          process.kill(native.pid,action === 'provider-crash' ? 'SIGABRT' : 'SIGKILL');
        } else {
          const exited = once(h.child,'exit');
          h.child.kill(action === 'daemon-kill' ? 'SIGKILL' : 'SIGTERM');
          const [code,signal] = await exited;
          if (action === 'daemon-shutdown') { assert.equal(code,0); assert.equal(signal,null); }
        }
        await assertProcessesGone(before,`${action}: shell group survives`);
        if (action !== 'interrupt') await assertProcessesGone(owned,`${action}: provider descendant survives`);
        t.diagnostic(`After ${action}: no owned ${action === 'interrupt' ? 'command' : 'provider or command'} group members in ps (before harness cleanup)`);
        assert.equal(existsSync(join(f.project,'finished')),false);
        if (action === 'interrupt') {
          const next = 'printf FOLLOWUP_EXECUTED';
          const probe = await h.probe(row,h.shell(row,next));
          assertSuccess(probe,next,'FOLLOWUP_EXECUTED');
          t.diagnostic('Same Codex session executed a new native command after interruption');
        }
      } finally {
        // A failure remains a failure. Only clean test-owned groups after the
        // assertions, so fixture teardown can never manufacture a passing result.
        for (const pgid of new Set(owned.map((r) => r.pgid))) { try { process.kill(-pgid,'SIGKILL'); } catch {} }
      }
    });
  }
}
