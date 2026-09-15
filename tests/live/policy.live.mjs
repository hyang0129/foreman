import test from 'node:test';
import assert from 'node:assert/strict';

if (process.env.FOREMAN_LIVE !== '1') {
  test('live native modes (set FOREMAN_LIVE=1)', {skip:'spends real provider turns; opt in explicitly'}, () => {});
} else {
  const { Harness, until, quote, assertSuccess, commandResults, existsSync, readFileSync, join, randomUUID, spawnSync, delay, commandProcesses, assertProcessesGone } = await import('./harness.mjs');
  const repo = process.env.FOREMAN_LIVE_PRIVATE_REPO;
  assert.match(repo ?? '', /^[\w.-]+\/[\w.-]+$/, 'Set FOREMAN_LIVE_PRIVATE_REPO to an accessible private repository');
  const metadata = spawnSync('gh', ['api', `repos/${repo}`, '--jq', '.private'], {encoding:'utf8',timeout:20000});
  assert.equal(metadata.status, 0, 'Private-repository precondition needs authenticated gh');
  assert.equal(metadata.stdout.trim(), 'true', 'Public Git is not evidence of authenticated private Git');
  const h = new Harness();
  test('native provider execution through the real Foreman HTTP service', {timeout:900000}, async (t) => {
    t.after(() => h.close());
    await h.start();
    await t.test('local API still requires authentication', async () => {
      assert.equal((await fetch(h.url + '/api/sessions')).status, 401);
      assert.equal((await fetch(h.url + '/api/sessions', {method:'POST',body:JSON.stringify({permission_mode:'bypass'})})).status, 401);
    });
    for (const provider of ['claude','codex']) for (const mode of ['native','bypass']) {
      await t.test(`${provider}/${mode}`, async (t) => {
        const f = h.fixture();
        const row = await h.create(provider, mode, f);
        // Startup must succeed before reporting or dependent checks can pass.
        await h.idle(row);
        assert.equal((await h.api(`/api/session?id=${encodeURIComponent(row.session_key)}`)).session.capabilities.message, true);
        await t.test('requested mode appears in the API, peer summary, and browser', () => h.reported(row));
        await t.test('native shell executes a real project read', async () => {
          const command = 'cat readable.txt';
          const result = await h.probe(row, h.shell(row, command), 'allow');
          assertSuccess(result, command, f.token);
          if (mode === 'bypass') assert.equal(result.approvals.length, 0);
        });
        if (mode === 'native') {
          await t.test('native approval is exact, one-time, and denial prevents the next write', async () => {
            const target = join(f.outside, 'approved.txt');
            const command = `printf first > ${quote(target)}`;
            const first = await h.probe(row, h.shell(row, command, true), 'allow');
            assert.equal(first.approvals.length, 1, 'Expected a real provider approval request');
            assertSuccess(first, command);
            assert.equal(readFileSync(target,'utf8'), 'first');
            const secondCommand = `printf second > ${quote(target)}`;
            const second = await h.probe(row, h.shell(row, secondCommand, true), 'deny');
            assert.equal(second.approvals.length, 1, 'Approval must not persist for later commands');
            assert.notEqual(second.approvals[0].id, first.approvals[0].id);
            assert.ok(String(first.approvals[0].input.command).includes(command));
            assert.ok(String(second.approvals[0].input.command).includes(secondCommand));
            assert.equal(commandResults(second,secondCommand).some((r) => r.exit_code === 0), false);
            assert.equal(readFileSync(target,'utf8'), 'first');
            await h.api('/api/session/approval', {id:row.session_key,approval_id:second.approvals[0].id,decision:'allow'}, 400);
          });
        } else {
          await t.test('bypass reads synthetic .env and writes outside the project without prompts', async () => {
            const target = join(f.outside, 'written.txt');
            const command = `cat .env && printf outside-written > ${quote(target)}`;
            const result = await h.probe(row,h.shell(row,command));
            assert.equal(result.approvals.length,0); assertSuccess(result,command,`SYNTHETIC_${f.token}`);
            assert.equal(readFileSync(target,'utf8'),'outside-written');
          });
          await t.test('authenticated gh accesses a private repository without prompts', async () => {
            const command = `gh api repos/${repo} --jq .private`;
            const result = await h.probe(row,h.shell(row,command));
            assert.equal(result.approvals.length,0); assertSuccess(result,command,'true');
          });
          await t.test('private Git fetch succeeds using host authentication without prompts', async () => {
            const command = `git init private-fetch && git -C private-fetch fetch --depth=1 --filter=blob:none https://github.com/${repo}.git HEAD && printf PRIVATE_FETCH_OK`;
            const result = await h.probe(row,h.shell(row,command));
            assert.equal(result.approvals.length,0); assertSuccess(result,command,'PRIVATE_FETCH_OK');
            assert.match(readFileSync(join(f.project,'private-fetch','.git','FETCH_HEAD'),'utf8'), /^[a-f0-9]{40}\s/);
          });
          await t.test('interrupt stops a native long-running command', async () => {
            const marker = join(f.project,'started');
            const finished = join(f.project,'finished');
            const command = `printf started > ${quote(marker)} && sleep 12 && printf finished > ${quote(finished)}`;
            const offset = h.events.length;
            const receipt = await h.api('/api/session/message', {id:row.session_key,message_id:randomUUID(),text:h.shell(row,command) + ' Run exactly this command once and wait for it. This is an interruption test.'});
            await until(() => existsSync(marker), 'native command started', 60000);
            const before = commandProcesses(marker);
            t.diagnostic(`Before interrupt: ${JSON.stringify(before.map(({pid,ppid,pgid,stat}) => ({pid,ppid,pgid,stat})))}`);
            await h.api('/api/session/interrupt',{id:row.session_key});
            await assertProcessesGone(before, `${provider} interrupted command group must disappear from ps`);
            t.diagnostic('After interrupt: no command group members remain in ps');
            await until(async () => {
              const detail = await h.api(`/api/session?id=${encodeURIComponent(row.session_key)}`);
              return detail.receipts.some((r) => r.id === receipt.id && ['failed','completed'].includes(r.status));
            }, 'interrupted turn settled');
            await delay(13000);
            await assertProcessesGone(before, 'Command group must stay gone after its original completion time');
            assert.equal(existsSync(finished),false,`Interrupted foreground command continued: ${JSON.stringify(h.events.slice(offset))}`);
            assert.ok(h.events.slice(offset).some((e) => e.cwd === row.cwd &&
              ((e.kind === 'tool_use' && e.input?.command === command) || (e.kind === 'item/started' && e.item?.command?.includes(command)))));
          });
        }
      });
    }
    await t.test('isolated recovery preserves recorded modes without resuming providers', async () => {
      await h.stop(); await h.start();
      for (const row of h.rows) {
        const detail = await h.api(`/api/session?id=${encodeURIComponent(row.session_key)}`);
        assert.equal(detail.session.permission_mode,row.requested);
        assert.equal(detail.session.capabilities.message,false);
        assert.equal(detail.session.alive,false);
      }
    });
  });
}
