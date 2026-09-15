import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFleetServer } from '../server/tools.ts';
import { ProjectManager } from '../server/pm.ts';
import { PERMISSION_MODES } from '../server/permission-policy.ts';

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
test('PM may propose elevated settings but cannot approve its own elevated spawn', async () => {
  const pm = new ProjectManager({} as any, undefined, '/tmp/nonexistent-foreman-policy-settings.json');
  const guard = (pm as any).canUseTool;
  for (const permission_mode of ['bypass', 'bypassPermissions']) {
    assert.equal((await guard('mcp__fleet__spawn_session', { permission_mode })).behavior, 'deny');
    const hook = await (pm as any).enforceToolBoundary({ hook_event_name: 'PreToolUse', tool_name: 'mcp__fleet__spawn_session', tool_input: { permission_mode } });
    assert.equal(hook.hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.equal((await guard('mcp__fleet__spawn_session', { permission_mode: 'native' })).behavior, 'allow');
});
