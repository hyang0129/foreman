import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

export function localAuth(home: string) {
  const path = join(home, 'local-api-token');
  let token: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Local API token must be an owned regular file with mode 0600');
    token = readFileSync(path, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local API token');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex'); writeFileSync(path, token + '\n', {mode:0o600,flag:'wx'});
  }
  const valid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  return { token, path, valid, accepts(req: IncomingMessage) {
    return valid(req.headers.authorization?.replace(/^Bearer /, '')) || valid(req.headers.cookie?.split(';').map((v) => v.trim()).find((v) => v.startsWith('foreman_local='))?.slice('foreman_local='.length));
  } };
}
