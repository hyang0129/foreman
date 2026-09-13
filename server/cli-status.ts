import { PORT } from './paths.ts';
try {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { signal:AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const sessions = await response.json();
  console.table(sessions.map((s: { provider: string; session_key: string; name: string | null; state: string; current_tool: string | null }) => ({
    provider:s.provider, session:s.name ?? s.session_key, state:s.state, tool:s.current_tool ?? '',
  })));
} catch (error) { console.error(`Foreman is unavailable on port ${PORT}: ${error}`); process.exitCode = 1; }
