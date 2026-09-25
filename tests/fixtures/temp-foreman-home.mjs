// Story #121: server/paths.ts resolves FOREMAN_HOME at import and refuses the real ~/.foreman
// under node --test. A test file that loads server modules statically imports this module FIRST
// (ES modules evaluate their imports in order), so FOREMAN_HOME is a fresh temp dir by the time
// paths.ts runs. Removed when the test process exits.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEMP_FOREMAN_HOME = mkdtempSync(join(tmpdir(), 'foreman-test-home-'));
process.env.FOREMAN_HOME = TEMP_FOREMAN_HOME;
process.on('exit', () => rmSync(TEMP_FOREMAN_HOME, { recursive: true, force: true }));
