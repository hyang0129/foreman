// Test-only observers retain the real service, provider controllers, and native tools.
import assert from 'node:assert/strict';
import { SessionService } from '../../server/session-service.ts';
import { ClaudeControl } from '../../server/claude-control.ts';
import { CodexControl } from '../../server/codex-control.ts';
import { bindPeerTools } from '../../server/peer-tools.ts';
assert.equal(process.env.FOREMAN_LIVE, '1');
assert.equal(process.env.FOREMAN_PM_DISABLED, '1');
assert.notEqual(process.env.FOREMAN_PORT, '4177');
assert.ok(process.env.FOREMAN_HOME?.includes('foreman-conformance-'));
const record = (event) => { if (process.connected) process.send({ event }); };
let service;
const launch = SessionService.prototype.launch;
SessionService.prototype.launch = async function (data, runtime) {
  service = this;
  this.options.claudeFactory = (options) => {
    const cwd = options.cwd;
    const control = new ClaudeControl({ ...options, maxTurns: 6, maxBudgetUsd: 1,
      persistSession: false, settingSources: [] });
    control.on('message', (message) => {
      for (const block of message.message?.content ?? []) {
        if (['tool_use', 'tool_result'].includes(block.type)) record({ cwd, kind: block.type, ...block });
      }
      if (message.type === 'system' && message.subtype === 'init') record({cwd,kind:'init',mode:message.permissionMode});
      if (message.type === 'result') record({ cwd, kind: 'result', subtype: message.subtype,
        errors: message.errors, is_error: message.is_error, cost: message.total_cost_usd, turns: message.num_turns });
    });
    return control;
  };
  this.options.codexFactory = (options) => {
    const control = new CodexControl(options);
    control.on('notification', (message) => {
      if (['item/started', 'item/completed'].includes(message.method)) record({cwd:options.cwd,kind:message.method,item:message.params.item});
    });
    return control;
  };
  return launch.call(this, data, runtime);
};
process.on('message', async (message) => {
  if (message.type !== 'peer') return;
  try {
    const result = await bindPeerTools(service, message.id).call('session_state', { session: message.id });
    process.send({ reply: message.seq, result });
  } catch (error) { process.send({ reply: message.seq, error: String(error) }); }
});
process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
await import('../../server/main.ts');
