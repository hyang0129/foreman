export type ClaudeBinSource = 'override' | 'installed' | 'bundled' | 'unresolved';
export function findInstalledClaude(pathEnv: string | undefined, isExecutable?: (path: string) => boolean): string | null;
export function resolveClaudeBin(options: {
  env?: NodeJS.ProcessEnv; bundled: string; isExecutable?: (path: string) => boolean; bundledExists?: (path: string) => boolean;
}): { path: string; source: ClaudeBinSource };
