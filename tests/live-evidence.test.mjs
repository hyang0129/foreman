import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRefused, assertSuccess, assertNetworkFailure } from './live/harness.mjs';

test('live evidence rejects model prose, unrelated tool denial, and unrelated command errors', () => {
  for (const events of [
    [],
    [{ kind: 'assistant', text: 'Permission denied: I cannot do that' }],
    [{ kind: 'hook', tool: 'Bash', input: { command: 'another command' }, result: { hookSpecificOutput: { permissionDecision: 'deny' } } }],
    [{ kind: 'command_result', input: { command: 'cat .env' }, result: { exit_code: 1, output: 'No such file or directory' } }],
    [{ kind: 'command_result', input: { command: 'cat another-file' }, result: { exit_code: 1, output: 'Operation not permitted' } }],
    [{ kind: 'command_result', input: { command: 'cat .env' }, result: { exit_code: 0, output: 'Permission denied' } }],
  ]) assert.throws(() => assertRefused({ events }, 'cat .env'), /No boundary refusal/);
  assertRefused({ events: [{ kind: 'command_result', input: { command: 'cat .env' }, result: { exit_code: 1, output: 'cat: .env: Operation not permitted' } }] }, 'cat .env');
});

test('Claude curl failure needs a matching sandbox hook and correlated failed tool result', () => {
  const command = 'curl http://127.0.0.1:12345/probe';
  const hook = { kind: 'hook', tool: 'Bash', input: { command }, result: {
    hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: 'sandbox profile (deny network*)' } },
  } };
  const use = { type: 'tool_use', name: 'Bash', id: 'curl', input: { command } };
  const result = { type: 'tool_result', tool_use_id: 'curl', is_error: true, content: 'curl: (7) Failed to connect' };
  assertNetworkFailure({ events: [hook, use, result] }, command);
  for (const events of [
    [use, result], [hook, result],
    [hook, use, { ...result, is_error: false }],
    [hook, use, { ...result, content: 'curl: (6) Could not resolve host' }],
    [hook, use, { ...result, tool_use_id: 'another-command' }],
  ]) assert.throws(() => assertNetworkFailure({ events }, command), /No correlated/);
});

test('Claude evidence must correlate the tool result to the requested operation', () => {
  const result = { kind: 'tool_result', type: 'tool_result', tool_use_id: 'read', content: 'fixture', is_error: false };
  const events = [{ type: 'tool_use', name: 'Bash', id: 'read', input: { command: 'cat readable.txt' } }, result];
  assertSuccess({ events }, 'cat readable.txt', 'fixture');
  result.content = [{ type: 'text', text: '{"number":2}' }];
  assertSuccess({ events }, 'cat readable.txt', '"number":2');
  assert.throws(() => assertSuccess({ events }, 'cat .env'), /No successful tool result/);
  result.is_error = true; result.content = 'Operation not permitted';
  assertRefused({ events }, 'cat readable.txt');
  assert.throws(() => assertRefused({ events }, 'cat .env'), /No boundary refusal/);
});

test('TLS success requires the actual correlated shell exit, including Claude', async () => {
  const { assertShellExit } = await import('./live/harness.mjs');
  const command = 'git fetch origin main';
  const hook = { kind: 'hook', tool: 'Bash', input: { command }, exitMarker: 'FOREMAN_EXIT_fixture=' };
  const use = { type: 'tool_use', name: 'Bash', id: 'fetch', input: { command } };
  const result = { type: 'tool_result', tool_use_id: 'fetch', is_error: false, content: '\nFOREMAN_EXIT_fixture=0\n' };
  assertShellExit({ events: [hook, use, result] }, command);
  const host = { kind: 'command_result', input: { command }, result: { exit_code: 0 } };
  assertShellExit({ events: [host] }, command);
  for (const events of [[], [use, result], [hook, result], [hook, use, { ...result, content: 'looks successful' }],
    [hook, use, { ...result, content: '\nFOREMAN_EXIT_fixture=128\n' }],
    [hook, use, { ...result, tool_use_id: 'unrelated' }],
    [{ ...host, result: { exit_code: null } }], [{ ...host, result: { exit_code: 128 } }],
    [{ ...host, input: { command: 'git status' } }],
  ]) assert.throws(() => assertShellExit({ events }, command), /shell exit/);
});
