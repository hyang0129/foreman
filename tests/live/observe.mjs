// Test-only preload: retain the real HTTP server, SDK, providers, and guards.
// These private method taps intentionally fail loudly if controller internals change.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SessionService } from '../../server/session-service.ts';
import { bindPeerTools } from '../../server/peer-tools.ts';

assert.equal(process.env.FOREMAN_LIVE, '1');
assert.equal(process.env.FOREMAN_PM_DISABLED, '1');
assert.notEqual(process.env.FOREMAN_PORT, '4177');
assert.ok(process.env.FOREMAN_HOME?.includes('foreman-conformance-'));
const record = (event) => { if (process.connected) process.send({ event }); };
let service;
const launch = SessionService.prototype.launch;
assert.equal(typeof launch, 'function');
SessionService.prototype.launch = async function (data, runtime) {
  service = this;
  // Byte-identical disposable source copies let the model edit its ACTUAL source,
  // after the controller has loaded and the Codex hook snapshot has been taken.
  const module = (name) => import(pathToFileURL(join(data.session.cwd, 'server', name)).href);
  const { ClaudeControl } = await module('claude-control.ts');
  const { CodexControl } = await module('codex-control.ts');
  const { PolicyCommands } = await module('policy-commands.ts');
  observeCommands(PolicyCommands);
  this.options.claudeFactory = (options) => {
    const cwd = options.cwd;
    const control = new ClaudeControl({ ...options, maxTurns: 3, maxBudgetUsd: 0.30,
      persistSession: false, settingSources: [] }, (params) => {
      const opts = params.options;
      for (const matcher of opts.hooks.PreToolUse) matcher.hooks = matcher.hooks.map((hook) => async (...args) => {
        const result = await hook(...args);
        record({ cwd, kind: 'hook', tool: args[0].tool_name, input: args[0].tool_input, result });
        return result;
      });
      return query(params);
    });
    control.on('message', (message) => {
      // Only tool blocks, never assistant prose, are enforcement evidence.
      for (const block of message.message?.content ?? []) {
        if (['tool_use', 'tool_result'].includes(block.type)) record({ cwd, kind: block.type, ...block });
      }
      if (message.type === 'result') record({ cwd, kind: 'result', subtype: message.subtype,
        errors: message.errors, is_error: message.is_error, diagnostic: message.is_error ? message.result : undefined, cost: message.total_cost_usd, turns: message.num_turns });
    });
    return control;
  };
  this.options.codexFactory = (options) => {
    const control = new CodexControl(options);
    const cwd = options.cwd;
    const write = control.write.bind(control);
    control.write = (message) => {
      if (message.result?.permissions) record({ cwd, kind: 'permission_refusal', result: message.result });
      if (message.result?.contentItems) record({ cwd, kind: 'tool_result', id: message.id, result: message.result });
      return write(message);
    };
    control.on('notification', (message) => {
      if (['item/started', 'item/completed'].includes(message.method) && ['dynamicToolCall', 'mcpToolCall', 'commandExecution', 'fileChange'].includes(message.params.item?.type)) record({ cwd, kind: message.method, item: message.params.item });
    });
    return control;
  };
  return launch.call(this, data, runtime);
};
function observeCommands(PolicyCommands) {
  const call = PolicyCommands.prototype.call;
  PolicyCommands.prototype.call = async function (name, input) {
    const cwd = this.cwd;
    record({ cwd, kind: 'command_attempt', name, input });
    try {
      const result = await call.call(this, name, input);
      record({ cwd, kind: 'command_result', name, input, result });
      return result;
    } catch (error) {
      record({ cwd, kind: 'command_refusal', name, input, error: String(error) });
      throw error;
    }
  };
}
process.on('message', async (message) => {
  if (message.type !== 'peer') return;
  try {
    // Same bound projection exposed by the actual provider peer tools.
    const result = await bindPeerTools(service, message.id).call('session_state', { session: message.id });
    process.send({ reply: message.seq, result });
  } catch (error) { process.send({ reply: message.seq, error: String(error) }); }
});
process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
await import('../../server/main.ts');
