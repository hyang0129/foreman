import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRefused, assertSuccess } from './live/harness.mjs';

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

test('Claude evidence must correlate the tool result to the requested operation', () => {
  const result = { kind: 'tool_result', type: 'tool_result', tool_use_id: 'read', content: 'fixture', is_error: false };
  const events = [{ type: 'tool_use', name: 'Bash', id: 'read', input: { command: 'cat readable.txt' } }, result];
  assertSuccess({ events }, 'cat readable.txt', 'fixture');
  assert.throws(() => assertSuccess({ events }, 'cat .env'), /No successful tool result/);
  result.is_error = true; result.content = 'Operation not permitted';
  assertRefused({ events }, 'cat readable.txt');
  assert.throws(() => assertRefused({ events }, 'cat .env'), /No boundary refusal/);
});
