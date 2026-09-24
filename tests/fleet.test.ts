import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('fleet separates provider identity, refuses ambiguous routing, and reads Codex transcripts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-fleet-test-'));
  const old = { FOREMAN_HOME:process.env.FOREMAN_HOME, CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR, FOREMAN_CLAUDE_BIN:process.env.FOREMAN_CLAUDE_BIN };
  Object.assign(process.env, { FOREMAN_HOME:home, CLAUDE_CONFIG_DIR:join(home, 'claude'), FOREMAN_CLAUDE_BIN:process.execPath });
  try {
    const { Fleet, transcriptTail } = await import('../server/fleet.ts');
    mkdirSync(join(home, 'sessions'));
    for (const provider of ['claude', 'codex']) writeFileSync(join(home, 'sessions', `${provider}-same.json`), JSON.stringify({
      session_id:'same', provider, name:'same-name', state:'working', updated_at:new Date().toISOString(),
    }));
    writeFileSync(join(home, 'sessions', 'stale.json'), JSON.stringify({ session_id:'stale', provider:'codex', state:'working', updated_at:'2020-01-01T00:00:00Z' }));
    const fleet = new Fleet(); await Promise.all([fleet.refresh(), fleet.refresh()]);
    assert.equal(fleet.list().length, 3);
    assert.equal(fleet.get('same'), undefined);
    assert.equal(fleet.get('same-name'), undefined);
    assert.equal(fleet.get('codex:same')?.provider, 'codex');
    assert.equal(fleet.get('claude:same')?.provider, 'claude');
    assert.equal(fleet.get('codex:stale')?.state, 'unknown');
    const log = join(home, 'log.jsonl');
    writeFileSync(log, [JSON.stringify({ type:'response_item', timestamp:'now', payload:{ type:'message', role:'assistant', content:[{ type:'output_text', text:'Codex result' }] } }), '{partial'].join('\n'));
    assert.match(transcriptTail(log, 10, 'codex'), /assistant.*Codex result/);
    assert.doesNotMatch(transcriptTail(log, 10, 'claude'), /Codex result/);
    fleet.start(); fleet.stop();
    const registry = join(home, 'claude', 'sessions'); mkdirSync(registry, { recursive: true });
    const internal = '11111111-1111-4111-8111-111111111111';
    const temporary = join(home, 'temporary-launcher'); mkdirSync(temporary);
    const ordinary = join(home, 'ordinary-project'); mkdirSync(ordinary);
    writeFileSync(join(registry, 'launcher.json'), JSON.stringify({ sessionId: internal, pid: process.pid, cwd: temporary, name: 'same-name', entrypoint: 'sdk-ts' }));
    writeFileSync(join(registry, 'ordinary.json'), JSON.stringify({ sessionId: 'ordinary', pid: process.pid, cwd: ordinary, name: 'same-name', entrypoint: 'sdk-ts' }));
    const filtered = new Fleet({ excludeSession: (s) => s.provider === 'claude' && s.session_id === internal });
    let emitted: any[] = []; filtered.on('change', (rows) => { emitted = rows; }); await filtered.refresh();
    assert.equal(filtered.get(`claude:${internal}`), undefined); assert.equal(emitted.some((s) => s.session_id === internal), false);
    assert.equal(filtered.get('claude:ordinary')?.cwd, ordinary);
    const { ProjectRegistry } = await import('../server/projects.ts'); const projects = new ProjectRegistry(home);
    projects.seed(filtered.list()); assert.deepEqual(projects.list().map((p) => p.path), [ordinary]);
    // Similar names/cwd and other providers are not role identifiers.
    writeFileSync(join(registry, 'same-cwd.json'), JSON.stringify({ sessionId: 'same-cwd', pid: process.pid, cwd: temporary, name: 'same-name', entrypoint: 'sdk-ts' }));
    writeFileSync(join(home, 'sessions', 'codex-internal-id.json'), JSON.stringify({ session_id: internal, provider: 'codex', cwd: ordinary }));
    await filtered.refresh(); assert.equal(filtered.get('claude:same-cwd')?.cwd, temporary); assert.ok(filtered.get(`codex:${internal}`));
    filtered.stop();
  } finally {
    for (const [key,value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(home, { recursive:true, force:true });
  }
});
