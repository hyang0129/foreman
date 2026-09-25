import { readFileSync } from 'node:fs';
import { PORT, LOCAL_API_TOKEN_FILE } from './paths.ts';

// The API requires the daemon's local token (see local-auth.ts). Read it; never create it here.
function readToken(): string | null {
  try {
    return readFileSync(LOCAL_API_TOKEN_FILE, 'utf8').trim();
  } catch (error: any) {
    if (error?.code === 'ENOENT') console.error(`Foreman local API token not found at ${LOCAL_API_TOKEN_FILE}. Start the Foreman service (it creates the token), or set FOREMAN_HOME to the daemon's home directory.`);
    else console.error(`Cannot read Foreman local API token at ${LOCAL_API_TOKEN_FILE}: ${error?.message ?? error}`);
    return null;
  }
}

const token = readToken();
if (token === null) process.exitCode = 1;
else try {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { headers:{ authorization:`Bearer ${token}` }, signal:AbortSignal.timeout(10_000) });
  if (response.status === 401) {
    console.error(`Foreman on port ${PORT} rejected the local API token at ${LOCAL_API_TOKEN_FILE} (HTTP 401). Check that FOREMAN_HOME matches the running daemon.`);
    process.exitCode = 1;
  } else {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const sessions = await response.json();
    console.table(sessions.map((s: { provider: string; session_key: string; name: string | null; state: string; current_tool: string | null }) => ({
      provider:s.provider, session:s.name ?? s.session_key, state:s.state, tool:s.current_tool ?? '',
    })));
  }
} catch (error) { console.error(`Foreman is unavailable on port ${PORT}: ${error}`); process.exitCode = 1; }
