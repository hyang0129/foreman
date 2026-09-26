#!/usr/bin/env node
// Deploy the relay and pair this Mac without putting the host credential in argv.
import { randomBytes, webcrypto } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, lstatSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { assertTestHome } from '../server/home-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = process.env.FOREMAN_HOME || join(homedir(), '.foreman');
// Story #121 / #145: under node --test, never pair into (or write keys to) a real home: neither the
// default ~/.foreman nor a FOREMAN_HOME set explicitly to (or inside) a real one. Tests that run a
// standalone copy of this script copy server/home-guard.mjs beside it.
assertTestHome(state, { explicit: Boolean(process.env.FOREMAN_HOME) });
mkdirSync(state, { recursive: true, mode: 0o700 });
const configPath = join(state, 'cloud.json');
let previous;
if (existsSync(configPath)) {
  const stat = lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('cloud.json must be an owned regular file with mode 0600');
  try { previous = JSON.parse(readFileSync(configPath, 'utf8')); } catch { throw new Error('Invalid cloud.json'); }
  if (!previous || typeof previous.token !== 'string' || previous.token.length < 32 || previous.token.length > 512 || /\s/.test(previous.token)) throw new Error('Invalid existing cloud pairing');
  let previousUrl;
  try { previousUrl = new URL(previous.url); } catch { throw new Error('Invalid existing cloud pairing URL'); }
  if (previousUrl.protocol !== 'https:' || previousUrl.username || previousUrl.password || previousUrl.search || previousUrl.hash || previousUrl.pathname !== '/') throw new Error('Invalid existing cloud pairing URL');
}
const token = previous?.token || randomBytes(32).toString('hex');
// Web Push VAPID key (P-256 private JWK): generated once into vapid.json, reused after, and sent
// only through the secrets file below. Never argv, never logged; cloud.json is untouched.
async function vapidKey() {
  const path = join(state, 'vapid.json');
  const valid = (jwk) => jwk && jwk.kty === 'EC' && jwk.crv === 'P-256' && ['x', 'y', 'd'].every((key) => typeof jwk[key] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(jwk[key]));
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('vapid.json must be an owned regular file with mode 0600');
    let jwk;
    try { jwk = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Invalid vapid.json'); }
    if (!valid(jwk)) throw new Error('Invalid vapid.json');
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d };
  }
  const { privateKey } = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const { kty, crv, x, y, d } = await webcrypto.subtle.exportKey('jwk', privateKey);
  writeFileSync(path, JSON.stringify({ kty, crv, x, y, d }) + '\n', { mode: 0o600, flag: 'wx' });
  return { kty, crv, x, y, d };
}
const vapid = await vapidKey();
const temporary = mkdtempSync(join(state, '.deploy-'));
const secrets = join(temporary, 'secrets.json');
writeFileSync(secrets, JSON.stringify({ HOST_TOKEN: token, VAPID_PRIVATE_KEY: JSON.stringify(vapid) }), { mode: 0o600 });
try {
  const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--secrets-file', secrets], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) throw new Error(`Deployment failed (${code}); Mac pairing unchanged`);
  const url = output.match(/https:\/\/[^\s/]+\.workers\.dev\b/)?.[0];
  if (!url) throw new Error('Deployed but could not identify the Workers URL; configure cloud.json manually');
  const next = join(temporary, 'cloud.json');
  writeFileSync(next, JSON.stringify({ url, token }, null, 2) + '\n', { mode: 0o600 });
  renameSync(next, configPath);
  console.log(`Mac paired with ${url}. Restart Foreman to connect: npm run service:restart`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
