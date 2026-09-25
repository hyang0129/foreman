import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PM_MEMORY_TOOLS, PM_DOC_LIMITS, MAX_LOG_ENTRY, MAX_LOG_READ,
  type PmMemory, type PmDocName, type Doc, type LogEntry,
} from '../shared/pm-state.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Never let a server module resolve the real ~/.foreman: pin FOREMAN_HOME to a temp dir before
// importing anything from server/ (paths.ts reads it at import time).
const HOME = mkdtempSync(join(tmpdir(), 'foreman-memory-tools-'));
process.env.FOREMAN_HOME = HOME;
test.after(() => rmSync(HOME, { recursive: true, force: true }));
const { makeFleetServer } = await import('../server/tools.ts');
const { PmStoreError, pmErrorCode, MEMORY_READ_DEFAULT_LOG } = await import('../server/memory-tools.ts');

// In-memory fake PmMemory with the contract's store semantics: optimistic versions, exactly-once
// edits, doc limits, and coded rejections. Records every call so tests can prove what reached it.
class FakeMemory implements PmMemory {
  docs: Record<PmDocName, Doc> = { projects: { content: '', version: 0, updated_at: '' }, preferences: { content: '', version: 0, updated_at: '' } };
  entries: LogEntry[] = [];
  calls: { op: string; args: unknown[] }[] = [];
  failNext: Error | null = null;
  seq = 0;
  private take() { const e = this.failNext; this.failNext = null; if (e) throw e; }
  async read() {
    this.calls.push({ op: 'read', args: [] }); this.take();
    return { initialized: true, projects: { ...this.docs.projects }, preferences: { ...this.docs.preferences }, log: this.entries.slice(-MAX_LOG_READ), model: null };
  }
  private put(doc: PmDocName, content: string, expected: number) {
    const d = this.docs[doc];
    if (d.version !== expected) throw new PmStoreError('version_conflict', `expected ${expected}, current ${d.version}`);
    if (Buffer.byteLength(content) > PM_DOC_LIMITS[doc]) throw new PmStoreError('too_large', `${doc} exceeds ${PM_DOC_LIMITS[doc]} bytes`);
    this.docs[doc] = { content, version: d.version + 1, updated_at: new Date().toISOString() };
    return { version: d.version + 1 };
  }
  async write(doc: PmDocName, content: string, expectedVersion: number) {
    this.calls.push({ op: 'write', args: [doc, content, expectedVersion] }); this.take();
    return this.put(doc, content, expectedVersion);
  }
  async edit(doc: PmDocName, oldText: string, newText: string, expectedVersion: number) {
    this.calls.push({ op: 'edit', args: [doc, oldText, newText, expectedVersion] }); this.take();
    const d = this.docs[doc];
    if (d.version !== expectedVersion) throw new PmStoreError('version_conflict', 'stale');
    const at = d.content.indexOf(oldText);
    if (at < 0 || d.content.indexOf(oldText, at + 1) >= 0) throw new PmStoreError('invalid', 'old_text must occur exactly once');
    return this.put(doc, d.content.replace(oldText, () => newText), expectedVersion);
  }
  async log(text: string) {
    this.calls.push({ op: 'log', args: [text] }); this.take();
    this.entries.push({ seq: ++this.seq, at: new Date().toISOString(), text });
  }
  storeCalls(op: string) { return this.calls.filter((c) => c.op === op); }
}

function fixture(memory?: PmMemory) {
  const server = makeFleetServer({} as any, undefined, undefined, memory);
  const tools = (server.instance as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }>;
  const invoke = async (name: string, input: any) => tools[name].handler(input);
  return { tools, invoke };
}
const text = (r: any) => r.content[0].text as string;
const json = (r: any) => JSON.parse(text(r));

test('memory tools are registered on the fleet server with the PM_MEMORY_TOOLS names', () => {
  const { tools } = fixture(new FakeMemory());
  for (const full of PM_MEMORY_TOOLS) assert.ok(tools[full.replace('mcp__fleet__', '')], `${full} registered`);
  for (const other of ['list_sessions', 'list_models', 'list_projects', 'resolve_project', 'register_project', 'spawn_session', 'session_tail', 'stop_session']) assert.ok(tools[other], `${other} kept`);
});

test('memory tools are absent when memory is undefined (old file-based log_note is gone)', () => {
  const { tools } = fixture(undefined);
  for (const full of PM_MEMORY_TOOLS) assert.equal(tools[full.replace('mcp__fleet__', '')], undefined);
  assert.deepEqual(Object.keys(tools).sort(), ['list_models', 'list_projects', 'list_sessions', 'register_project', 'resolve_project', 'session_tail', 'spawn_session', 'stop_session']);
  assert.doesNotMatch(readFileSync(join(ROOT, 'server', 'tools.ts'), 'utf8'), /MEMORY_DIR|appendFileSync|LOG\.md/);
});

test('memory_read returns both docs with versions and the newest N log entries (default 40, max 200)', async () => {
  const mem = new FakeMemory();
  mem.docs.projects = { content: '## foreman\nGoal: portable PM', version: 3, updated_at: '2026-09-01T00:00:00.000Z' };
  mem.docs.preferences = { content: 'Short tables.', version: 1, updated_at: '2026-09-02T00:00:00.000Z' };
  for (let i = 1; i <= 250; i++) await mem.log(`entry ${i}`);
  const { invoke } = fixture(mem);
  const r = json(await invoke('memory_read', {}));
  assert.deepEqual(Object.keys(r).sort(), ['initialized', 'log', 'preferences', 'projects']);
  assert.deepEqual(r.projects, mem.docs.projects);
  assert.deepEqual(r.preferences, mem.docs.preferences);
  assert.equal(MEMORY_READ_DEFAULT_LOG, 40);
  assert.equal(r.log.length, 40);
  assert.equal(r.log[0].text, 'entry 211');
  assert.equal(r.log.at(-1).text, 'entry 250');
  assert.deepEqual(Object.keys(r.log[0]).sort(), ['at', 'seq', 'text']);
  assert.equal(json(await invoke('memory_read', { log_limit: 5 })).log.map((e: any) => e.text).join(','), 'entry 246,entry 247,entry 248,entry 249,entry 250');
  assert.equal(json(await invoke('memory_read', { log_limit: 200 })).log.length, 200);
  for (const bad of [0, 201, 1.5, '10']) assert.equal((await invoke('memory_read', { log_limit: bad })).isError, true, `log_limit ${bad}`);
});

test('memory_write and memory_edit happy path bump versions and reach the store', async () => {
  const mem = new FakeMemory();
  const { invoke } = fixture(mem);
  const w = await invoke('memory_write', { doc: 'projects', content: '## foreman\nState: blocked on review', expected_version: 0 });
  assert.equal(w.isError, undefined);
  assert.deepEqual(json(w), { saved: 'projects', version: 1 });
  const e = await invoke('memory_edit', { doc: 'projects', old_text: 'blocked on review', new_text: 'merged', expected_version: 1 });
  assert.equal(e.isError, undefined);
  assert.deepEqual(json(e), { saved: 'projects', version: 2 });
  assert.equal(mem.docs.projects.content, '## foreman\nState: merged');
  const p = await invoke('memory_write', { doc: 'preferences', content: 'Lead with blockers.', expected_version: 0 });
  assert.deepEqual(json(p), { saved: 'preferences', version: 1 });
  assert.deepEqual(mem.storeCalls('write').map((c) => c.args), [['projects', '## foreman\nState: blocked on review', 0], ['preferences', 'Lead with blockers.', 0]]);
});

test('version_conflict passes through as a tool error telling the PM to re-read memory and retry, with no automatic retry', async () => {
  const mem = new FakeMemory();
  mem.docs.projects = { content: 'A', version: 5, updated_at: 'x' };
  const { invoke } = fixture(mem);
  const w = await invoke('memory_write', { doc: 'projects', content: 'B', expected_version: 4 });
  assert.equal(w.isError, true);
  assert.match(text(w), /version_conflict/);
  assert.match(text(w), /re-read memory and retry/);
  assert.equal(mem.storeCalls('write').length, 1, 'no automatic retry');
  const e = await invoke('memory_edit', { doc: 'projects', old_text: 'A', new_text: 'C', expected_version: 4 });
  assert.equal(e.isError, true);
  assert.match(text(e), /re-read memory and retry/);
  assert.equal(mem.storeCalls('edit').length, 1, 'no automatic retry');
  assert.equal(mem.docs.projects.content, 'A');
  // Any Error carrying a PmErrorCode `code` works, not only PmStoreError.
  mem.failNext = Object.assign(new Error('changed'), { code: 'version_conflict' });
  assert.match(text(await invoke('log_note', { note: 'something happened' })), /re-read memory and retry/);
  assert.equal(pmErrorCode(Object.assign(new Error('x'), { code: 'too_large' })), 'too_large');
  assert.equal(pmErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' })), null);
  assert.equal(pmErrorCode('nope'), null);
});

test('store too_large and other codes come back as clear tool errors with next steps', async () => {
  const mem = new FakeMemory();
  const { invoke } = fixture(mem);
  mem.failNext = new PmStoreError('too_large', 'projects exceeds 32768 bytes');
  const big = await invoke('memory_edit', { doc: 'projects', old_text: 'x', new_text: 'y', expected_version: 0 });
  assert.equal(big.isError, true);
  assert.match(text(big), /too_large/); assert.match(text(big), /summarize/);
  mem.failNext = new PmStoreError('unavailable', 'relay offline');
  const down = await invoke('memory_write', { doc: 'projects', content: 'x', expected_version: 0 });
  assert.equal(down.isError, true); assert.match(text(down), /unavailable/); assert.match(text(down), /Nothing was saved/);
  mem.failNext = new PmStoreError('not_active', 'not the PM host');
  assert.match(text(await invoke('log_note', { note: 'abc' })), /no longer the active PM host/);
  mem.failNext = new Error('disk exploded');
  const plain = await invoke('memory_read', {});
  assert.equal(plain.isError, true); assert.match(text(plain), /disk exploded/);
});

test('host transport failures (PMM-03 disconnected/timeout/invalid_result) are reported as unknown outcomes, never as "nothing saved" or a conflict', async () => {
  const mem = new FakeMemory();
  mem.docs.projects = { content: '## a\nState: building', version: 1, updated_at: 'x' };
  const { invoke } = fixture(mem);
  // The relay applied the edit but the answer was lost: the store rejects with `timeout` while the version moved on.
  const origEdit = mem.edit.bind(mem);
  mem.edit = async (...args: Parameters<FakeMemory['edit']>) => {
    await origEdit(...args);
    throw Object.assign(new Error('The PM state store did not answer memory.edit within 10 s.'), { code: 'timeout' });
  };
  const e = await invoke('memory_edit', { doc: 'projects', old_text: 'building', new_text: 'merged', expected_version: 1 });
  assert.equal(e.isError, true);
  assert.match(text(e), /^timeout: /);
  assert.match(text(e), /may or may not have been saved/);
  assert.match(text(e), /memory_read/);
  assert.doesNotMatch(text(e), /version_conflict|Nothing was saved/);
  assert.equal(mem.storeCalls('edit').length, 1, 'no automatic retry');
  for (const code of ['disconnected', 'invalid_result']) {
    mem.failNext = Object.assign(new Error('The cloud relay connection closed.'), { code });
    const r = await invoke('memory_write', { doc: 'preferences', content: 'x', expected_version: 0 });
    assert.equal(r.isError, true);
    assert.match(text(r), new RegExp(`^${code}: .*may or may not have been saved`));
    assert.doesNotMatch(text(r), /Nothing was saved/);
  }
  mem.failNext = Object.assign(new Error('lost'), { code: 'timeout' });
  assert.match(text(await invoke('log_note', { note: 'shipped it' })), /may or may not have been saved/);
});

test('memory_edit counts overlapping matches as not unique, like the stores', async () => {
  const mem = new FakeMemory();
  mem.docs.projects = { content: 'State: aaa', version: 1, updated_at: 'x' };
  const { invoke } = fixture(mem);
  const r = await invoke('memory_edit', { doc: 'projects', old_text: 'aa', new_text: 'b', expected_version: 1 });
  assert.equal(r.isError, true);
  assert.match(text(r), /not_unique: old_text occurs 2 times/);
  assert.equal(mem.docs.projects.content, 'State: aaa');
});

test('memory_edit reports missing and non-unique old_text clearly and saves nothing', async () => {
  const mem = new FakeMemory();
  mem.docs.projects = { content: '## a\nState: blocked\n## b\nState: blocked\n', version: 2, updated_at: 'x' };
  const { invoke } = fixture(mem);
  const dup = await invoke('memory_edit', { doc: 'projects', old_text: 'State: blocked', new_text: 'State: done', expected_version: 2 });
  assert.equal(dup.isError, true);
  assert.match(text(dup), /not_unique/); assert.match(text(dup), /2 times/);
  const missing = await invoke('memory_edit', { doc: 'projects', old_text: 'State: shipped', new_text: 'x', expected_version: 2 });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /not_found/); assert.match(text(missing), /does not occur/);
  assert.equal(mem.docs.projects.version, 2);
  assert.equal(mem.storeCalls('edit').length, 2, 'each edit reached the store once, never retried');
  const empty = await invoke('memory_edit', { doc: 'projects', old_text: '', new_text: 'x', expected_version: 2 });
  assert.equal(empty.isError, true);
  assert.equal(mem.storeCalls('edit').length, 2, 'empty old_text rejected before the store');
});

test('limits and non-string content are rejected before calling the store', async () => {
  const mem = new FakeMemory();
  const { invoke } = fixture(mem);
  const overProjects = 'é'.repeat(PM_DOC_LIMITS.projects / 2 + 1); // UTF-8 bytes over, characters under
  assert.ok(overProjects.length < PM_DOC_LIMITS.projects);
  const r1 = await invoke('memory_write', { doc: 'projects', content: overProjects, expected_version: 0 });
  assert.equal(r1.isError, true); assert.match(text(r1), /too_large/); assert.match(text(r1), /summarize/);
  const r2 = await invoke('memory_write', { doc: 'preferences', content: 'x'.repeat(PM_DOC_LIMITS.preferences + 1), expected_version: 0 });
  assert.equal(r2.isError, true); assert.match(text(r2), /summarize/);
  assert.equal((await invoke('memory_write', { doc: 'preferences', content: 'x'.repeat(PM_DOC_LIMITS.preferences), expected_version: 0 })).isError, undefined, 'exactly at the limit is allowed');
  const r3 = await invoke('memory_edit', { doc: 'preferences', old_text: 'x', new_text: 'y'.repeat(PM_DOC_LIMITS.preferences + 1), expected_version: 1 });
  assert.equal(r3.isError, true); assert.match(text(r3), /summarize/);
  for (const input of [
    { doc: 'projects', content: 42, expected_version: 0 },
    { doc: 'projects', content: { text: 'x' }, expected_version: 0 },
    { doc: 'projects', content: null, expected_version: 0 },
    { doc: 'notes', content: 'x', expected_version: 0 },
    { doc: 'projects', content: 'x', expected_version: -1 },
    { doc: 'projects', content: 'x', expected_version: '0' },
  ]) assert.equal((await invoke('memory_write', input)).isError, true, JSON.stringify(input));
  for (const input of [
    { doc: 'projects', old_text: 1, new_text: 'x', expected_version: 0 },
    { doc: 'projects', old_text: 'x', new_text: ['y'], expected_version: 0 },
  ]) assert.equal((await invoke('memory_edit', input)).isError, true, JSON.stringify(input));
  for (const note of [42, null, 'ab', '  a \n\t  ', 'x'.repeat(MAX_LOG_ENTRY + 1)]) {
    const r = await invoke('log_note', { note });
    assert.equal(r.isError, true, JSON.stringify(note));
  }
  assert.match(text(await invoke('log_note', { note: 'x'.repeat(MAX_LOG_ENTRY + 1) })), /summarize/);
  assert.equal(mem.storeCalls('write').length, 1, 'only the at-limit write reached the store');
  assert.equal(mem.storeCalls('edit').length, 0);
  assert.equal(mem.storeCalls('log').length, 0);
});

test('log_note collapses whitespace, enforces 3-500 characters after collapsing, and logs through the store', async () => {
  const mem = new FakeMemory();
  const { invoke } = fixture(mem);
  const r = await invoke('log_note', { note: '  Decided:\n\tship   PMM-04\r\n first  ' });
  assert.equal(r.isError, undefined);
  assert.equal(text(r), 'Logged.');
  assert.deepEqual(mem.storeCalls('log').map((c) => c.args[0]), ['Decided: ship PMM-04 first']);
  // Long input whose collapsed form fits is accepted; collapsed form is what is limited.
  const padded = `${'a '.repeat(250).trim()}${' '.repeat(100)}`; // 499 chars after collapse
  assert.equal((await invoke('log_note', { note: padded })).isError, undefined);
  assert.equal((mem.storeCalls('log').at(-1)!.args[0] as string).length, 499);
  assert.equal((await invoke('log_note', { note: `  ${'x'.repeat(MAX_LOG_ENTRY)}  ` })).isError, undefined);
  assert.equal((await invoke('log_note', { note: ' a  b ' })).isError, undefined, '"a b" is 3 characters');
  assert.equal((await invoke('log_note', { note: ' ab ' })).isError, true);
});

test('PM system prompt describes portable tool-backed memory, not ~/.foreman/memory files', () => {
  const prompt = readFileSync(join(ROOT, 'agents', 'pm-system-prompt.md'), 'utf8');
  assert.doesNotMatch(prompt, /~\/\.foreman\/memory|\.foreman\/memory/);
  assert.doesNotMatch(prompt, /PROJECTS\.md|LOG\.md/);
  for (const full of PM_MEMORY_TOOLS) assert.ok(prompt.includes(`\`${full.replace('mcp__fleet__', '')}\``), `${full} named`);
  assert.match(prompt, /portable/i);
  assert.match(prompt, /before you end the turn/i);
  assert.match(prompt, /## <name>/);
  assert.match(prompt, /[Nn]o filesystem paths/);
  assert.match(prompt, /list_projects/); assert.match(prompt, /resolve_project/);
  assert.match(prompt, /never invent a path/i);
  // The never-touches-code rules are kept.
  assert.match(prompt, /You never write, edit, or read source code/);
  assert.match(prompt, /You never run the project's build, tests, or scripts/);
});
