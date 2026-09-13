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
  } finally {
    for (const [key,value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(home, { recursive:true, force:true });
  }
});
