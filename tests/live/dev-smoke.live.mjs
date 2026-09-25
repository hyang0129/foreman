// Opt-in REAL smoke test of the dev preview (#41): deploys the current commit to the
// `foreman-dev` Worker, starts the dev daemon with this Mac's normal provider logins,
// checks the dev origin, then stops the daemon. It spends a real Cloudflare deploy and
// talks to the real dev relay, so it runs only with FOREMAN_DEV_SMOKE=1:
//
//   FOREMAN_DEV_SMOKE=1 node tests/live/dev-smoke.live.mjs
//   FOREMAN_DEV_SMOKE=1 FOREMAN_DEV_SMOKE_KEEP=1 node tests/live/dev-smoke.live.mjs   # leave dev running
//
// Run it from a clean checkout with installed node_modules. It never targets the
// production Worker: the target is read from scripts/dev-environment.mjs (the only file
// that chooses dev targets) and from the config that deploy would actually generate, and
// the test refuses before running any command unless that is `foreman-dev`.
//
// dev:destroy is deliberately NOT run here: it deletes the `foreman-dev` Worker and the
// developer's dev history. Destroy stays covered by the mocked tests in
// tests/dev-lifecycle.test.mjs ("destroy stops the real daemon, deletes only the dev
// Worker with force=false, then removes the dev home", "destroy retains local state when
// the deleter refuses ...", "... when the auth token cannot be read", "destroy removes the
// dev home but never the host provider directories ...", "destroy refuses any path that
// is not the dev home ...") and the deleteDevWorker API tests in tests/dev-environment.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:https';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const EXPECTED = Object.freeze({ worker: 'foreman-dev', url: 'https://foreman-dev.hooong-yang.workers.dev' });

if (process.env.FOREMAN_DEV_SMOKE !== '1') {
  test('real dev preview smoke: deploy, status, start, relay, PWA headers, stop (set FOREMAN_DEV_SMOKE=1)', { skip: 'deploys to the real foreman-dev Worker' }, () => {});
} else {
  const keep = process.env.FOREMAN_DEV_SMOKE_KEEP === '1';
  const evidence = [];
  const note = (line) => { evidence.push(line); console.log(`[dev-smoke] ${line}`); };

  // The dev scripts refuse any FOREMAN_* variable (including FOREMAN_DEV_SMOKE) and any
  // provider/Cloudflare target override, so they run with those removed.
  const devEnv = () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('FOREMAN_')) delete env[key];
    return env;
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  function dev(command, timeout = 120_000) {
    const started = Date.now();
    const result = spawnSync('npm', ['run', '--silent', `dev:${command}`], { cwd: root, env: devEnv(), encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    note(`$ npm run dev:${command} -> exit ${result.status ?? result.signal ?? result.error?.code} (${seconds}s)`);
    if (result.status !== 0) {
      console.log(result.stdout);
      console.error(result.stderr);
    }
    return result;
  }
  function devStatus() {
    const result = dev('status');
    assert.equal(result.status, 0, `dev:status failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  }
  const summary = (s) => JSON.stringify({ pid: s.pid, logins: s.logins, commit: s.commit, relay: s.relay && { environment: s.relay.environment, commit: s.relay.commit, online: s.relay.relay?.online, host: s.relay.relay?.host }, error: s.error ?? null });
  // `curl -I`-equivalent: raw response headers (duplicates preserved), no redirect following.
  function raw(path, method = 'HEAD') {
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, EXPECTED.url), { method, timeout: 20_000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          const headers = {};
          for (let i = 0; i < res.rawHeaders.length; i += 2) (headers[res.rawHeaders[i].toLowerCase()] ??= []).push(res.rawHeaders[i + 1]);
          resolve({ status: res.statusCode, headers, body });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
      req.on('error', reject);
      req.end();
    });
  }
  async function localHealth(port) {
    try { return await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })).json(); }
    catch (error) { return { unreachable: error.cause?.code ?? error.name }; }
  }

  test('real dev preview smoke: deploy, status, start, relay, PWA headers, stop', { timeout: 20 * 60_000 }, async (t) => {
    t.after(() => {
      console.log('\n===== dev-smoke evidence =====');
      for (const line of evidence) console.log(line);
      console.log('==============================');
    });

    // 1. Fail closed unless the resolved target is foreman-dev, before any command runs.
    const devModule = await import('../../scripts/dev-environment.mjs');
    const { experimental_readRawConfig } = await import('wrangler');
    const { rawConfig } = experimental_readRawConfig({ config: join(root, 'wrangler.jsonc') });
    const generated = devModule.workerConfig(rawConfig);
    const target = { worker: devModule.TARGET.worker, url: devModule.TARGET.url, generatedName: generated.name, production: rawConfig.name, port: devModule.TARGET.port };
    note(`target: ${JSON.stringify(target)}`);
    if (target.worker !== EXPECTED.worker || target.generatedName !== EXPECTED.worker || target.url !== EXPECTED.url
      || target.production === EXPECTED.worker || target.worker === target.production || new URL(target.url).hostname !== `${EXPECTED.worker}.hooong-yang.workers.dev`) {
      throw new Error(`Refusing to smoke-test: resolved dev target ${JSON.stringify(target)} is not the foreman-dev Worker`);
    }

    // The exact commit to deploy: HEAD of a clean tree.
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Commit tracked changes first: dev:deploy previews HEAD');
    const commit = git('rev-parse', '--verify', 'HEAD^{commit}');
    assert.match(commit, /^[a-f0-9]{40}$/);
    note(`commit under test: ${commit} (${git('rev-parse', '--abbrev-ref', 'HEAD')})`);

    // A running dev daemon blocks deploy (UI and daemon must share one snapshot).
    const before = devStatus();
    note(`before: ${summary(before)}`);
    assert.equal(before.url, EXPECTED.url);
    if (before.pid !== null) {
      const stopped = dev('stop');
      assert.equal(stopped.status, 0, 'dev:stop of the already-running dev daemon failed');
      note(`stopped the previously running dev daemon (pid ${before.pid}, commit ${before.commit})`);
    }

    // 2. Real deploy of this commit; the dev origin's credentialed status route reports it.
    const deployed = dev('deploy', 15 * 60_000);
    assert.equal(deployed.status, 0, 'dev:deploy failed');
    assert.match(deployed.stdout, new RegExp(`DEV deployed ${commit}\\n${EXPECTED.url.replaceAll('.', '\\.')}`));
    const afterDeploy = devStatus();
    note(`after deploy: ${summary(afterDeploy)}`);
    assert.equal(afterDeploy.error, undefined, `dev:status reported an error: ${afterDeploy.error}`);
    assert.equal(afterDeploy.commit, commit, 'local deployment record is not this commit');
    assert.equal(afterDeploy.relay?.environment, 'dev');
    assert.equal(afterDeploy.relay?.commit, commit, '/api/dev/status on the dev origin does not report the deployed commit');
    assert.equal(afterDeploy.pid, null);
    // The route itself is on the dev origin and refuses callers without the dev credential.
    const anonymous = await raw('/api/dev/status', 'GET');
    note(`GET ${EXPECTED.url}/api/dev/status without credential -> ${anonymous.status}`);
    assert.equal(anonymous.status, 401);
    // The uploaded web assets are this commit's snapshot (DEV badge carries the short commit).
    const page = await raw('/', 'GET');
    const badge = page.body.match(/DEV · ([a-f0-9]{8}) · :4178/)?.[1];
    note(`GET ${EXPECTED.url}/ -> ${page.status}, title ${JSON.stringify(page.body.match(/<title>([^<]*)<\/title>/)?.[1])}, badge commit ${badge}`);
    assert.equal(page.status, 200);
    assert.equal(badge, commit.slice(0, 8));

    // 3. Start with the host's normal logins; local health and relay convergence.
    const started = dev('start', 5 * 60_000);
    assert.equal(started.status, 0, 'dev:start failed');
    for (const line of started.stderr.split('\n').filter((l) => l.startsWith('Notice:'))) note(`dev:start ${line}`);
    const running = devStatus();
    note(`after start: ${summary(running)}`);
    assert.equal(running.error, undefined, `dev:status reported an error: ${running.error}`);
    assert.ok(Number.isSafeInteger(running.pid), 'no dev daemon PID recorded');
    assert.equal(running.logins, 'host', 'dev daemon is not using the host logins');
    assert.equal(running.commit, commit);
    assert.equal(running.relay?.commit, commit);
    assert.equal(running.relay?.relay?.online, true, 'dev relay does not show the host connected');
    assert.ok(running.relay.relay.host, 'dev relay reports no host name');
    const health = await localHealth(target.port);
    note(`GET http://127.0.0.1:${target.port}/api/health -> ${JSON.stringify(health)}`);
    assert.equal(health.ok, true);
    assert.equal(health.pid, running.pid, 'local health is served by a different process than the recorded dev daemon');

    // 4. PWA headers on the dev origin (#100): set, not appended; offline screen resolves.
    const manifest = await raw('/manifest.webmanifest');
    note(`HEAD /manifest.webmanifest -> ${manifest.status}, content-type ${JSON.stringify(manifest.headers['content-type'])}`);
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.headers['content-type'], ['application/manifest+json'], 'manifest must carry exactly one Content-Type');
    const worker = await raw('/sw.js');
    note(`HEAD /sw.js -> ${worker.status}, cache-control ${JSON.stringify(worker.headers['cache-control'])}, content-type ${JSON.stringify(worker.headers['content-type'])}`);
    assert.equal(worker.status, 200);
    assert.deepEqual(worker.headers['cache-control'], ['no-cache']);
    let path = '/offline.html', hops = [], offline;
    for (let i = 0; i < 5; i++) {
      offline = await raw(path, 'GET');
      hops.push(`${path} ${offline.status}`);
      if (![301, 302, 303, 307, 308].includes(offline.status)) break;
      path = new URL(offline.headers.location[0], new URL(path, EXPECTED.url)).pathname;
    }
    note(`GET /offline.html -> ${hops.join(' -> ')}, content-type ${JSON.stringify(offline.headers['content-type'])}`);
    assert.equal(offline.status, 200);
    assert.equal(path, '/offline', '/offline.html should resolve through its redirect to /offline');
    assert.match(offline.headers['content-type']?.[0] ?? '', /^text\/html/);
    assert.match(offline.body, /<html/i);

    // 5. Stop, and confirm the daemon, its local port and its relay connection are gone.
    if (keep) { note('FOREMAN_DEV_SMOKE_KEEP=1: leaving the dev daemon running'); return; }
    const stopped = dev('stop');
    assert.equal(stopped.status, 0, 'dev:stop failed');
    assert.match(stopped.stdout, /DEV daemon stopped/);
    let after;
    for (let i = 0; i < 30; i++) {
      after = devStatus();
      if (after.pid === null && after.relay?.relay?.online === false) break;
      await delay(1000);
    }
    note(`after stop: ${summary(after)}`);
    assert.equal(after.pid, null);
    assert.equal(after.relay?.relay?.online, false, 'dev relay still shows the host connected after stop');
    const gone = await localHealth(target.port);
    note(`GET http://127.0.0.1:${target.port}/api/health after stop -> ${JSON.stringify(gone)}`);
    assert.ok(gone.unreachable, 'local dev port still answers after stop');
  });
}
