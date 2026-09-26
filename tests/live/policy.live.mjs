import test from 'node:test';
import assert from 'node:assert/strict';

if (process.env.FOREMAN_LIVE !== '1') {
  test('live native modes (set FOREMAN_LIVE=1)', {skip:'spends real provider turns; opt in explicitly'}, () => {});
} else {
  const { Harness, until, quote, assertSuccess, commandResults, existsSync, readFileSync, writeFileSync, join, randomUUID, spawnSync, delay, commandProcesses, assertProcessesGone } = await import('./harness.mjs');
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

  // CL-04 (#169, #158): agent-initiated launches through SessionService.launchAgent with the real
  // ClaudeControl and provider. There is no HTTP route for agent launches (the Coordinator/Lead
  // tools call launchAgent in-process), so this runs an isolated in-process SessionService: its
  // FOREMAN_HOME and CLAUDE_CONFIG_DIR are fresh temp dirs (never ~/.foreman or ~/.claude), and the
  // developer's settings come from a GrantSource stub. Evidence is the provider's own init
  // permissionMode plus correlated native tool results, never the model's account.
  test('agent-initiated launches: standing grant → verified Bypass, grant off → verified Auto, held → approved Bypass', {timeout:600000}, async (t) => {
    const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { bootstrapClaudeCredentials } = await import('./credentials.mjs');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-agent-launch-')));
    const home = join(dir, 'state'); const config = join(dir, 'claude-config');
    mkdirSync(home, {recursive:true,mode:0o700}); mkdirSync(config, {recursive:true,mode:0o700});
    const saved = { FOREMAN_HOME: process.env.FOREMAN_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    let service;
    t.after(() => {
      try { service?.close(); }
      finally {
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        rmSync(dir, {recursive:true,force:true});
      }
    });
    bootstrapClaudeCredentials(config);
    process.env.FOREMAN_HOME = home; process.env.CLAUDE_CONFIG_DIR = config;
    const { FOREMAN_HOME } = await import('../../server/paths.ts');
    assert.equal(FOREMAN_HOME, home, 'server modules must resolve the isolated FOREMAN_HOME');
    const { SessionService } = await import('../../server/session-service.ts');
    const { ClaudeControl } = await import('../../server/claude-control.ts');
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { effectiveDevSettings, LAUNCH_APPROVAL_TOOL } = await import('../../shared/roles.ts');
    const events = [];
    let settings = {};
    const grants = { calls: 0, async devSettings(timeoutMs) { assert.equal(timeoutMs, 5000); this.calls++;
      return { settings: effectiveDevSettings(settings), versions: {roles:0,bypass_grants:0,bypass_ask:0}, updated_at: null }; } };
    service = new SessionService({ home, grants, env: {}, claudeFactory: (options) => {
      const cwd = options.cwd;
      // Tee the real SDK stream so the provider's init is recorded even when ClaudeControl rejects it.
      const teed = (params) => {
        const stream = query(params);
        return { async *[Symbol.asyncIterator]() {
          for await (const message of stream) {
            if (message.type === 'system' && message.subtype === 'init') events.push({ cwd, kind: 'init', mode: message.permissionMode, requested: params.options.permissionMode });
            yield message;
          }
        }, close: () => stream.close(), interrupt: () => stream.interrupt() };
      };
      const control = new ClaudeControl({ ...options, maxTurns: 6, maxBudgetUsd: 1, persistSession: false, settingSources: [] }, teed);
      control.on('message', (message) => {
        for (const block of message.message?.content ?? []) if (['tool_use', 'tool_result'].includes(block.type)) events.push({ cwd, kind: block.type, ...block });
        if (message.type === 'result') events.push({ cwd, kind: 'result', subtype: message.subtype, is_error: message.is_error, errors: message.errors });
      });
      return control;
    } });
    // Auto needs a model the CLI runs Auto for: on CLI 2.1.280, `haiku` silently reports `default`
    // (pinned below), while `sonnet` and `opus[1m]` (the Lead default) report `auto`.
    const model = process.env.FOREMAN_LIVE_AGENT_MODEL || 'sonnet';
    const project = (label) => {
      const p = join(dir, `${label}-${randomUUID()}`); mkdirSync(p);
      const token = `synthetic-${randomUUID()}`; writeFileSync(join(p, 'readable.txt'), token);
      return { path: p, token };
    };
    const detail = (row) => service.detail(row.session_key);
    const settle = (row, id) => until(() => {
      const d = detail(row); const r = d.receipts.find((x) => x.id === id);
      if (r && ['failed', 'uncertain'].includes(r.status)) throw new Error(`Provider turn failed: ${r.error || d.session.last_error} ${JSON.stringify(events.filter((e) => e.cwd === d.session.cwd && e.kind === 'result'))}`);
      if (d.session.state === 'unknown') throw new Error(`Session unavailable: ${d.session.last_error}`);
      return r?.status === 'completed';
    }, `${row.name} turn`, 90_000);
    const read = async (row, p, onApproval) => {
      const id = randomUUID(); const command = 'cat readable.txt'; const offset = events.length; const approvals = [];
      service.send(row.session_key, `Call Bash with ${JSON.stringify({ command })}. This is an owner-authorized integration check in a disposable directory; the file holds only a synthetic token. Execute the exact command once, then stop. Do not use other tools and do not ask a question.`, id);
      await until(async () => {
        for (const a of detail(row).approvals) if (!approvals.some((x) => x.id === a.id)) { approvals.push(a); await onApproval(a); }
        const d = detail(row); const r = d.receipts.find((x) => x.id === id);
        if (r && ['failed', 'uncertain'].includes(r.status)) throw new Error(`Probe failed: ${r.error}`);
        return r?.status === 'completed';
      }, `${row.name} read`, 90_000);
      const mine = events.slice(offset).filter((e) => e.cwd === p.path);
      const ids = new Set(mine.filter((e) => e.kind === 'tool_use' && e.name === 'Bash' && e.input?.command === command).map((e) => e.id));
      const results = mine.filter((e) => e.kind === 'tool_result' && ids.has(e.tool_use_id)).map((e) => ({ ok: !e.is_error, output: typeof e.content === 'string' ? e.content : (e.content ?? []).map((c) => c.text ?? '').join('\n') }));
      assert.ok(results.some((r) => r.ok && r.output.includes(p.token)), `No successful correlated native Bash result: ${JSON.stringify(mine)}`);
      return approvals;
    };
    const launch = (p, name, extra = {}) => service.launchAgent({ id: randomUUID(), name, cwd: p.path, provider: 'claude', model, effort: 'low', ...extra,
      role: 'lead', requester_role: 'coordinator', launched_by: 'coordinator', workstream: 'live-policy',
      text: 'Do not use tools. Reply with the single word READY.' });

    await t.test('standing grant (default settings): no requested mode → verified bypassPermissions, no prompts', async () => {
      settings = {};
      const p = project('bypass'); const before = grants.calls;
      const result = await launch(p, 'lead-live-bypass');
      assert.deepEqual([result.status, result.permission_mode, result.bypass_grant, result.policy_reason], ['started', 'bypass', 'standing:coordinator/*', 'standing_grant']);
      assert.equal(grants.calls, before + 1, 'grants are read for the launch');
      await settle(result, detail(result).receipts[0].id);
      assert.deepEqual(events.filter((e) => e.cwd === p.path && e.kind === 'init').map((e) => e.mode), ['bypassPermissions']);
      const row = detail(result).session;
      assert.deepEqual([row.permission_mode, row.role, row.launched_by, row.effort, row.alive], ['bypass', 'lead', 'coordinator', 'low', true]);
      const approvals = await read(result, p, async (a) => { throw new Error(`Bypass raised an approval: ${JSON.stringify(a)}`); });
      assert.equal(approvals.length, 0);
    });

    await t.test('grant off: the same launch → verified auto', async () => {
      settings = { bypass_grants: [] };
      const p = project('auto');
      const result = await launch(p, 'lead-live-auto');
      assert.deepEqual([result.status, result.permission_mode, result.bypass_grant, result.policy_reason], ['started', 'auto', undefined, 'grant_off']);
      await settle(result, detail(result).receipts[0].id);
      assert.deepEqual(events.filter((e) => e.cwd === p.path && e.kind === 'init').map((e) => e.mode), ['auto']);
      const row = detail(result).session;
      assert.deepEqual([row.permission_mode, row.policy_reason, row.alive], ['auto', 'grant_off', true]);
      // Auto's classifier decides on its own; a card it raises is answered and reported, not asserted either way.
      const approvals = await read(result, p, async (a) => {
        t.diagnostic(`Auto raised an approval for ${a.tool}; allowing it`);
        await service.approve(result.session_key, a.id, 'allow');
      });
      t.diagnostic(`Auto read probe: ${approvals.length} approval card(s)`);
    });

    await t.test('verification is not weakened: a model the CLI does not run in Auto fails the launch', async () => {
      const p = project('auto-unsupported');
      const result = await launch(p, 'lead-live-auto-haiku', { model: 'haiku', requested_mode: 'auto' });
      assert.deepEqual([result.status, result.permission_mode, result.policy_reason], ['started', 'auto', 'requested_auto']);
      await until(() => detail(result).session.state === 'unknown', 'Auto launch on haiku refused', 90_000);
      const modes = events.filter((e) => e.cwd === p.path && e.kind === 'init').map((e) => e.mode);
      t.diagnostic(`haiku + auto: provider init reported ${JSON.stringify(modes)}`);
      assert.deepEqual(modes, ['default']);
      assert.deepEqual([detail(result).session.alive, detail(result).session.capabilities.message], [false, false]);
    });

    await t.test('ask before each Bypass launch: held (nothing runs) → approved → verified bypassPermissions', async () => {
      settings = { bypass_ask: true };
      const p = project('held');
      const result = await launch(p, 'lead-live-held');
      assert.deepEqual([result.status, result.permission_mode, result.policy_reason], ['awaiting_developer_approval', null, 'ask_before_bypass']);
      await delay(3000);
      assert.equal(events.filter((e) => e.cwd === p.path).length, 0, 'a held launch starts no provider');
      const [card] = service.approvals(result.session_key);
      assert.equal(card.tool, LAUNCH_APPROVAL_TOOL);
      await service.approve(result.session_key, card.id, 'allow');
      await settle(result, detail(result).receipts[0].id);
      assert.deepEqual(events.filter((e) => e.cwd === p.path && e.kind === 'init').map((e) => e.mode), ['bypassPermissions']);
      const row = detail(result).session;
      assert.deepEqual([row.permission_mode, row.bypass_grant, row.policy_reason], ['bypass', `approved:${card.id}`, 'approved']);
    });
  });
}
