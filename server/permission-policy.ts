// Launch choices select provider behavior; Foreman adds no execution sandbox or deny list.
// - native: the provider's own permission prompts (Claude `default`, Codex workspace-write/on-request).
// - bypass: no prompts (Claude `bypassPermissions`, Codex danger-full-access/never).
// - auto (#157 S1/D6): Claude's model-classifier mode (`permissionMode: 'auto'`). Claude only:
//   Codex has no Auto mapping and refuses it.
export const PERMISSION_MODES = ['native', 'bypass', 'auto'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export const CODEX_AUTO_UNSUPPORTED = 'Auto is not supported for Codex';
export function permissionMode(value: unknown): PermissionMode {
  if (value == null) return 'native';
  if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new Error('permission_mode must be native, bypass or auto');
  return value as PermissionMode;
}
export function claudePolicy(mode: PermissionMode) {
  return mode === 'bypass' ? 'bypassPermissions' : mode === 'auto' ? 'auto' : 'default';
}
/** Throws `CODEX_AUTO_UNSUPPORTED` for `auto`: Codex never runs a mode it cannot verify. */
export function codexPolicy(mode: PermissionMode) {
  if (mode === 'auto') throw new Error(CODEX_AUTO_UNSUPPORTED);
  return {
    sandbox: mode === 'bypass' ? 'danger-full-access' : 'workspace-write',
    approvalPolicy: mode === 'bypass' ? 'never' : 'on-request',
  } as const;
}
