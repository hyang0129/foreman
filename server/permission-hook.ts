// Executed from a private, per-controller snapshot; never from the live source tree.
import { readFileSync } from 'node:fs';
import { permissionMode, toolDecision } from './permission-policy.ts';
try {
  const [mode, cwd, foreman] = process.argv.slice(2);
  if (foreman) process.env.FOREMAN_HOME = foreman;
  const event = JSON.parse(readFileSync(0, 'utf8'));
  if (['Bash', 'exec_command', 'shell_command'].includes(event.tool_name)) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Use foreman_exec so the deny list remains enforced.' } }));
    process.exit(0);
  }
  const decision = toolDecision(permissionMode(mode), cwd, event.tool_name, event.tool_input ?? {});
  // Codex still applies its sandbox and approval policy to rewritten commands.
  // Hook "allow" is needed for updatedInput; it is not a sandbox escape grant.
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: decision.behavior,
    permissionDecisionReason: decision.message,
    ...(decision.behavior !== 'deny' ? { updatedInput: decision.input } : {}),
  } }));
} catch {
  console.error('Foreman could not verify the immutable launch policy.');
  process.exitCode = 2;
}
