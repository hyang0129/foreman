// Launch choices select provider behavior; Foreman adds no execution sandbox or deny list.
export const PERMISSION_MODES = ['native', 'bypass'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export function permissionMode(value: unknown): PermissionMode {
  if (value == null) return 'native';
  if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new Error('permission_mode must be native or bypass');
  return value as PermissionMode;
}
export function claudePolicy(mode: PermissionMode) {
  return mode === 'bypass' ? 'bypassPermissions' : 'default';
}
export function codexPolicy(mode: PermissionMode) {
  return {
    sandbox: mode === 'bypass' ? 'danger-full-access' : 'workspace-write',
    approvalPolicy: mode === 'bypass' ? 'never' : 'on-request',
  } as const;
}
