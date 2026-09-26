import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// server/paths.ts reads FOREMAN_HOME at import: pin it to a temp dir before loading any server module.
const home = mkdtempSync(join(tmpdir(), 'foreman-fleet-policy-'));
process.env.FOREMAN_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { makeFleetServer } = await import('../server/tools.ts');
const { ProjectManager } = await import('../server/pm.ts');
const { PERMISSION_MODES } = await import('../server/permission-policy.ts');

test('spawn_session accepts each managed preset and omission without native flag passthrough', async () => {
  const launches: any[] = [];
  const service: any = { create: (input: any) => { launches.push(input); return input; } };
  const server = makeFleetServer({} as any, service);
  const spawn = (server.instance as any)._registeredTools.spawn_session.handler;
  const input = { name: 'test-worker', cwd: '/tmp', prompt: 'Inspect the project carefully', provider: 'codex' };
  for (const permission_mode of [undefined, ...PERMISSION_MODES]) {
    const result = await spawn({ ...input, permission_mode });
    assert.equal(result.isError, undefined);
    assert.equal(launches.at(-1).permission_mode, permission_mode);
  }
  const before = launches.length;
  assert.equal((await spawn({ ...input, permission_mode: 'bypassPermissions' })).isError, true);
  assert.equal(launches.length, before);
});
test('the Coordinator cannot spawn sessions at all (epic #157: it starts Leads; the Bypass deny moved to start_lead → launchAgent)', async () => {
  const pm = new ProjectManager({} as any);
  const guard = (pm as any).canUseTool;
  for (const permission_mode of ['bypass', 'bypassPermissions', 'native', undefined]) {
    assert.equal((await guard('mcp__fleet__spawn_session', { permission_mode })).behavior, 'deny');
    const hook = await (pm as any).enforceToolBoundary({ hook_event_name: 'PreToolUse', tool_name: 'mcp__fleet__spawn_session', tool_input: { permission_mode } });
    assert.equal(hook.hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('the Coordinator fleet server (spawn: false) has no spawn_session; the default keeps it; sender reaches the peer binding', async () => {
  const listed: string[] = [];
  const service: any = { create: () => ({}), list: () => { listed.push('list'); return []; }, detail: () => { throw new Error('No such session'); }, send: () => ({}), receipt: () => undefined, activeSource: () => 'user' };
  const fleet: any = { refresh: async () => {}, list: () => [] };
  const coordinator = (makeFleetServer(fleet, service, undefined, undefined, { spawn: false, sender: 'coordinator' }).instance as any)._registeredTools;
  assert.equal(coordinator.spawn_session, undefined);
  for (const name of ['list_sessions', 'list_models', 'list_projects', 'resolve_project', 'register_project', 'session_tail', 'stop_session']) assert.ok(coordinator[name], name);
  assert.equal((await coordinator.list_sessions.handler({})).isError, undefined);
  assert.deepEqual(listed, ['list']);
  assert.ok((makeFleetServer(fleet, service).instance as any)._registeredTools.spawn_session);
  assert.ok((makeFleetServer(fleet, service, undefined, undefined, { sender: 'coordinator' }).instance as any)._registeredTools.spawn_session);
  // An invalid sender identity is refused at construction, as bindPeerTools does.
  assert.throws(() => makeFleetServer(fleet, service, undefined, undefined, { sender: '' }));
});
