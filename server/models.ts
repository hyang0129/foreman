import { query } from '@anthropic-ai/claude-agent-sdk';
import { CodexControl } from './codex-control.ts';
import { CLAUDE_BIN, FOREMAN_HOME } from './paths.ts';

export interface ModelOption { value: string; displayName: string; description?: string }
export function normalizeModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/.test(value)) throw new Error('Invalid model identifier');
  return value;
}

// Discovery starts no inference turn and reuses the user's existing provider login.
async function discover(provider: 'claude' | 'codex'): Promise<ModelOption[]> {
  if (provider === 'claude') {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    const prompt = (async function* () {
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) resolve();
        else abort.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    })();
    const q = query({ prompt, options: { cwd: FOREMAN_HOME, pathToClaudeCodeExecutable: CLAUDE_BIN, settingSources: ['user'], persistSession: false, abortController: abort } });
    try { return (await q.supportedModels()).map(({ value, displayName, description }) => ({ value, displayName, description })); }
    finally { clearTimeout(timer); abort.abort(); q.close(); }
  }
  const control = new CodexControl({ cwd: FOREMAN_HOME, timeoutMs: 15_000 });
  try {
    await control.connect();
    await control.requireSignedIn(); // Always a real CodexControl here, so no optional call.
    const models: ModelOption[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result: { data: { model: string; displayName: string; description?: string; hidden?: boolean }[]; nextCursor?: string | null } = await control.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...result.data.filter((m) => !m.hidden).map((m) => ({ value: m.model, displayName: m.displayName, description: m.description })));
      if (!result.nextCursor) return models;
      cursor = result.nextCursor;
    }
    throw new Error('Model catalog exceeded pagination limit');
  } finally { control.close(); }
}

export class ModelCatalog {
  private cache = new Map<string, { at: number; models: Promise<ModelOption[]> }>();
  private fetchModels: typeof discover;
  constructor(fetchModels = discover) { this.fetchModels = fetchModels; }
  list(provider: string): Promise<ModelOption[]> {
    if (provider !== 'claude' && provider !== 'codex') return Promise.reject(new Error('Unsupported provider'));
    const cached = this.cache.get(provider);
    if (cached && Date.now() - cached.at < 300_000) return cached.models;
    const models = this.fetchModels(provider).catch((error) => { this.cache.delete(provider); throw error; });
    this.cache.set(provider, { at: Date.now(), models });
    return models;
  }
}

export const modelCatalog = new ModelCatalog();
