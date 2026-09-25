export function underNodeTest(env?: NodeJS.ProcessEnv, execArgv?: string[]): boolean;
export function realHomes(): string[];
export function realCodexHomes(): string[];
export function isRealHome(path: string, homes?: string[]): boolean;
export function assertTestHome(path: string, options?: { explicit?: boolean; variable?: string; homes?: string[] }): void;
