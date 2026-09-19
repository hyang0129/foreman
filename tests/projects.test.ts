import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectRegistry } from '../server/projects.ts';
import { makeFleetServer } from '../server/tools.ts';
function fixture(t: test.TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-projects-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = join(home, 'personal', 'foreman'), second = join(home, 'work', 'foreman');
  mkdirSync(first, { recursive: true }); mkdirSync(second, { recursive: true });
  return { home, first, second, registry: new ProjectRegistry(home) };
}
test('registry seeds recent sessions, persists names/aliases/order, deduplicates and keeps removals across restart', (t) => {
  const { home, first, second, registry } = fixture(t);
  const alias = join(home, 'alias'); symlinkSync(first, alias);
  registry.seed([{ cwd: first, updated_at: '2026-09-01' }, { cwd: alias, updated_at: '2026-09-02' }, { cwd: second, updated_at: '2026-09-03' }, { cwd: '/does-not-exist' }]);
  assert.equal(registry.list().length, 2); assert.equal(registry.list()[0].path, second);
  const project = registry.register({ name: 'personal', path: first, aliases: ['the personal repo'] });
  registry.update(project.id, 'My Foreman');
  const loaded = new ProjectRegistry(home);
  assert.equal(loaded.require('the personal repo').path, first);
  assert.equal(loaded.require('my foreman').project?.name, 'My Foreman');
  assert.equal(loaded.list().find((p) => p.id === project.id)?.lastUsed, '2026-09-02T00:00:00.000Z');
  assert.equal(statSync(join(home, 'projects.json')).mode & 0o777, 0o600);
  loaded.remove(project.id);
  const removed = new ProjectRegistry(home); removed.seed([{ cwd: first }, { cwd: alias }]);
  assert.equal(removed.list().length, 1); assert.equal(removed.resolve('personal').status, 'not_found');
  assert.equal(JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')).version, 1);
});
test('resolution prefers exact names and aliases, asks for ambiguous/missing references and never invents directories', (t) => {
  const { registry, first, second, home } = fixture(t);
  registry.register({ name: 'home', path: first, aliases: ['personal repo', 'shared'] });
  registry.register({ name: 'office', path: second, aliases: ['shared'] });
  assert.equal(registry.require('THE PERSONAL REPO').path, first);
  assert.equal(registry.require('person').path, first);
  assert.equal(registry.resolve('foreman').status, 'ambiguous');
  assert.equal(registry.resolve('shared').status, 'ambiguous');
  assert.equal(registry.resolve('unknown repo').status, 'not_found');
  assert.throws(() => registry.require('unknown repo'), /No project matches/);
  assert.equal(registry.resolve('../invented').status, 'not_found');
  assert.throws(() => registry.resolve(join(home, 'invented')), /missing or unreadable/);
  assert.equal(existsSync(join(home, 'invented')), false);
  const file = join(home, 'file'); writeFileSync(file, 'fixture');
  assert.throws(() => registry.register({ name: 'file', path: file }), /missing or unreadable/);
  chmodSync(second, 0o000);
  try { assert.throws(() => registry.require('office'), /missing or unreadable/); }
  finally { chmodSync(second, 0o700); }
  rmSync(first, { recursive: true }); assert.throws(() => registry.require('home'), /missing or unreadable/);
});
test('registration accepts symlinked parents and pins all registered lexical paths across restart', (t) => {
  const { home, first, second, registry } = fixture(t);
  const parent = join(home, 'code'); symlinkSync(join(home, 'personal'), parent);
  const linked = join(parent, 'foreman');
  registry.register({ name: 'foreman-home', path: linked });
  assert.equal(registry.require('foreman-home').path, first);
  assert.equal(registry.require(linked).path, first);
  registry.register({ name: 'alternate', path: first });
  assert.equal(registry.list().length, 1);
  rmSync(parent); symlinkSync(join(home, 'work'), parent);
  const loaded = new ProjectRegistry(home);
  for (const ref of ['foreman-home', 'alternate', linked, first]) assert.throws(() => loaded.require(ref), /changed its symlink target/);
  assert.throws(() => loaded.register({ name: 'repin', path: linked }), /changed its symlink target/);
  assert.equal(loaded.list()[0].canonicalPath, first);
  loaded.remove(loaded.list()[0].id);
  assert.equal(loaded.register({ name: 'new-target', path: linked }).canonicalPath, second);
});
test('additional symlink registrations preserve their own pins rather than silently following later targets', (t) => {
  const { home, first, second, registry } = fixture(t);
  registry.register({ name: 'plain', path: first });
  const link = join(home, 'link'); symlinkSync(first, link);
  registry.register({ name: 'linked', path: link });
  rmSync(link); symlinkSync(second, link);
  assert.throws(() => registry.require(link), /changed its symlink target/);
  assert.throws(() => registry.require('linked'), /changed its symlink target/);
});
test('PM project tools dispatch through the registry and named/absolute spawn remain compatible', async (t) => {
  const { registry, first, second } = fixture(t), launches: any[] = [];
  const server = makeFleetServer({} as any, { create: (input: any) => { launches.push(input); return input; } } as any, registry);
  const tools = (server.instance as any)._registeredTools;
  const invoke = async (name: string, input: any) => tools[name].handler(input);
  assert.equal((await invoke('register_project', { name: 'foreman', path: first, aliases: ['personal repo'] })).isError, undefined);
  assert.equal(JSON.parse((await invoke('list_projects', {})).content[0].text)[0].name, 'foreman');
  assert.equal(JSON.parse((await invoke('resolve_project', { reference: 'personal repo' })).content[0].text).path, first);
  const input = { name: 'project-task', prompt: 'Inspect the project carefully', permission_mode: 'native' };
  for (const cwd of ['personal repo', first]) assert.equal((await invoke('spawn_session', { ...input, cwd })).isError, undefined);
  assert.deepEqual(launches.map((v) => v.cwd), [first, first]);
  registry.register({ name: 'foreman', path: second });
  assert.equal((await invoke('spawn_session', { ...input, cwd: 'foreman' })).isError, true);
  assert.equal((await invoke('spawn_session', { ...input, cwd: 'unknown' })).isError, true);
  assert.equal(launches.length, 2);
});


test('seeding retains canonical-equivalent recent path names and pins them across polling and restart', (t) => {
  const { home, first, second, registry } = fixture(t);
  const link = join(home, 'personal-link'); symlinkSync(first, link);
  registry.seed([{ cwd: first }, { cwd: link }]);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.require('personal-link').path, first);
  assert.ok(registry.list()[0].registeredPaths?.includes(link));
  rmSync(link); symlinkSync(second, link);
  const restored = new ProjectRegistry(home);
  for (const reference of [link, first, 'personal-link']) assert.throws(() => restored.require(reference), /changed its symlink target/);
  restored.seed([{ cwd: first }, { cwd: link }]);
  assert.equal(restored.list().length, 1);
  assert.equal(restored.list()[0].canonicalPath, first);
  assert.throws(() => restored.require(link), /changed its symlink target/);
});
