import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

if (process.env.FOREMAN_LIVE !== '1') {
  test('live PM success and authentication failure', { skip: 'spends real provider turns' }, () => {});
} else {
  const home = mkdtempSync(join(tmpdir(), 'foreman-pm-live-'));
  process.env.FOREMAN_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude');
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  if (process.platform === 'darwin') {
    assert.equal(process.env.FOREMAN_LIVE_CLAUDE_KEYCHAIN, '1', 'Explicit read-only Keychain opt-in required');
    // Read the current access token only. Never clone or rotate the owner's refresh token.
    const credentials = JSON.parse(execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    process.env.CLAUDE_CODE_OAUTH_TOKEN = credentials.claudeAiOauth.accessToken;
  }
  // Elsewhere (no Keychain) the caller supplies an access token in CLAUDE_CODE_OAUTH_TOKEN.
  assert.ok(process.env.CLAUDE_CODE_OAUTH_TOKEN, 'An access token is required: the macOS Keychain, or CLAUDE_CODE_OAUTH_TOKEN');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FOREMAN_PM_MODEL;
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { ProjectManager } = await import('../../server/pm.ts');
  const { LocalPmStore } = await import('../../server/pm-store.ts');
  const { ensureDirs } = await import('../../server/paths.ts');
  ensureDirs();
  // A closed CLI can still be writing its config dir while it exits: retry the cleanup.
  test.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const identity = { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'live-test-mac' };
  // Each test gets its own local-only PM state store (pm/state.json in its own temp dir), with the
  // portable model set to haiku.
  const livePm = async () => {
    const storeHome = mkdtempSync(join(home, 'store-'));
    const store = new LocalPmStore({ identity, home: storeHome, log: () => {} });
    await store.setModel('haiku');
    const pm = new ProjectManager({}, { machineName: identity.name }); /* fleet tools are forbidden by the prompt */
    pm.attach(store, { autoStart: false });
    return { pm, store, storeHome };
  };
  const waitFor = async (check, label, ms = 65000) => {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    assert.ok(check(), label);
  };
  const unconfirmed = (pm) => pm.history().filter((e) => /could not be confirmed|was not delivered/.test(e.text ?? ''));

  for (const badAuth of [true, false]) test(`live PM ${badAuth ? 'authentication rejection is reported and logged' : 'actually answers a dispatched message, attributed to its input'}`, { timeout: 90000 }, async (t) => {
    const { pm, store, storeHome } = await livePm();
    if (badAuth) pm.queryFactory = ({ prompt, options }) => query({ prompt, options: { ...options, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'invalid-live-test-token' } } });
    const events = [], logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    pm.on('event', (event) => events.push(event));
    const running = pm.start();
    try {
      await pm.send('Reply with exactly FOREMAN_PM_LIVE_OK. Do not call tools or change anything.');
      await waitFor(() => events.some((e) => e.type === 'turn_end') || !!pm.lastError, 'a turn end or a failure', 75000);
      if (badAuth) {
        assert.match(pm.lastError || '', /auth|token|401|login/i);
        assert.ok(pm.history().some((entry) => entry.error)); assert.ok(logs.length);
      } else {
        assert.equal(pm.lastError, null);
        assert.ok(events.some((event) => event.type === 'turn_end' && !event.is_error), 'A real successful result is required');
        assert.ok(pm.history().some((entry) => entry.role === 'assistant' && entry.text.includes('FOREMAN_PM_LIVE_OK')), 'An actual recorded answer is required');
        // The real CLI echoed the input's uuid on its result, so the turn settled as completed
        // (not uncertain) and its record was ended in the store.
        assert.deepEqual(unconfirmed(pm), []);
        await waitFor(() => store.openTurnIds().length === 0, 'the turn record was ended', 5000);
        assert.equal(pm.modelBusy, false);
      }
      assert.deepEqual(readdirSync(join(storeHome, 'pm')), ['state.json'], 'no transcript or session file');
    } finally { pm.close(); await running; }
  });

  test('live PM: a fresh session answers from memory injected by the store', { timeout: 90000 }, async (t) => {
    const { pm, store } = await livePm();
    await store.write('projects', '## zebra-project\nStatus: blocked on FOREMAN_MEMORY_CANARY_7Q\n', 0);
    const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
    const running = pm.start();
    try {
      await pm.send('From your memory only, what is zebra-project blocked on? Answer with the exact blocker text. Do not call any tools.');
      await waitFor(() => pm.history().some((e) => e.role === 'assistant') || !!pm.lastError, 'an answer', 75000);
      assert.equal(pm.lastError, null, JSON.stringify(logs));
      const answer = pm.history().filter((e) => e.role === 'assistant').map((e) => e.text).join('\n');
      assert.match(answer, /FOREMAN_MEMORY_CANARY_7Q/, `the answer must come from injected memory: ${answer}`);
      assert.deepEqual(unconfirmed(pm), []);
    } finally { pm.close(); await running; }
  });

  // #233: the memory tools were deferred behind ToolSearch, which the Coordinator is denied, so it
  // said they "weren't available". The store is the evidence: only a real tool call can write it.
  test('live PM: a turn asked to remember something actually writes memory and the log through the tools', { timeout: 120000 }, async (t) => {
    const { pm, store } = await livePm();
    const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
    // Every tool the model called. Before the fix it tried ToolSearch first, was denied, and then
    // either gave up (production) or guessed the unloaded tools' inputs (haiku, sometimes).
    const calls = [];
    pm.queryFactory = (args) => {
      const q = query(args), iterate = q[Symbol.asyncIterator].bind(q);
      const frames = (async function* () { for await (const m of { [Symbol.asyncIterator]: iterate }) {
        if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'tool_use') calls.push(b.name);
        yield m;
      } })();
      return new Proxy(q, { get: (target, key) => key === Symbol.asyncIterator ? () => frames : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
    };
    const running = pm.start();
    try {
      await pm.send('Remember this: the developer decided that zebra-project ships on FOREMAN_DECISION_CANARY_4K. Record it now with log_note (a one-line note containing FOREMAN_DECISION_CANARY_4K) and add a `## zebra-project` section containing FOREMAN_DECISION_CANARY_4K to the projects memory doc. Then reply in one sentence.');
      await waitFor(() => pm.history().some((e) => e.role === 'assistant') || !!pm.lastError, 'an answer', 110000);
      assert.equal(pm.lastError, null, JSON.stringify(logs));
      const answer = pm.history().filter((e) => e.role === 'assistant').map((e) => e.text).join('\n');
      const memory = await store.read();
      assert.ok(memory.log.some((e) => e.text.includes('FOREMAN_DECISION_CANARY_4K')), `log_note must have run: ${JSON.stringify(memory.log)} / ${answer}`);
      assert.match(memory.projects.content, /FOREMAN_DECISION_CANARY_4K/, `a memory write must have run: ${answer}`);
      assert.doesNotMatch(answer, /(n't|not|un)\s*(been\s*)?available|could(n't| not) (load|access)/i, answer);
      assert.ok(calls.includes('mcp__fleet__log_note'), calls.join(','));
      assert.ok(!calls.includes('ToolSearch'), `the memory tools must already be loaded, not searched for: ${calls.join(',')}`);
      assert.deepEqual(unconfirmed(pm), []);
    } finally { pm.close(); await running; }
  });

  test('live PM recovers on the same instance after auth rejection and provider shutdown', { timeout: 150000 }, async t => {
    const { pm } = await livePm();
    let invalid = true, launches = 0;
    pm.queryFactory = ({ prompt, options }) => {
      launches++;
      return query({ prompt, options: { ...options, env: { ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: invalid ? 'invalid-live-test-token' : process.env.CLAUDE_CODE_OAUTH_TOKEN } } });
    };
    const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
    const running = pm.start();
    try {
      await pm.send('Reply with FAILED_INPUT_MUST_NOT_REPLAY. Do not call tools.');
      await waitFor(() => !!pm.lastError, 'Real provider authentication rejection is required');
      assert.match(pm.lastError || '', /auth|token|401|login/i);
      assert.ok(pm.history().some(e => e.error)); assert.ok(logs.length);
      // This SDK keeps its streaming-input process alive after invalid-token
      // rejection. Explicitly end the real Query to exercise the incident's EOF
      // condition as well, without closing the ProjectManager itself.
      pm.q?.close();
      await waitFor(() => !pm.running, 'The rejected provider must actually exit');
      await running;
      invalid = false;
      await pm.send('Reply with exactly FOREMAN_PM_RECOVERED. Do not call tools or change anything.');
      await waitFor(() => pm.history().some(e => e.role === 'assistant' && e.text.includes('FOREMAN_PM_RECOVERED')), 'New input must receive a real recorded answer on the same PM');
      assert.equal(launches, 2); assert.equal(pm.lastError, null);
      assert.equal(pm.history().filter(e => e.role === 'user').length, 2);
    } finally { pm.close(); await running; }
  });
  test('live PM restarts an alive-but-rejecting provider on the next explicit send', { timeout: 150000 }, async t => {
    const { pm } = await livePm();
    let invalid = true, launches = 0;
    pm.queryFactory = ({ prompt, options }) => {
      launches++;
      return query({ prompt, options: { ...options, env: { ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: invalid ? 'invalid-live-test-token' : process.env.CLAUDE_CODE_OAUTH_TOKEN } } });
    };
    const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
    const running = pm.start();
    try {
      await pm.send('Reply with FAILED_INPUT_MUST_NOT_REPLAY. Do not call tools.');
      await waitFor(() => !!pm.lastError, 'Real provider authentication rejection is required');
      assert.match(pm.lastError || '', /auth|token|401|login/i);
      assert.ok(pm.history().some(e => e.error)); assert.ok(logs.length);
      // No pm.q?.close() here: the real provider must still be alive after rejecting, which
      // is the shape this case exists to cover. If the SDK ever exits instead, fail loudly.
      await new Promise(r => setTimeout(r, 2000));
      assert.equal(pm.running, true, 'The rejecting provider is expected to stay alive');
      assert.equal(launches, 1);
      invalid = false;
      await pm.send('Reply with exactly FOREMAN_PM_ALIVE_RECOVERED. Do not call tools or change anything.');
      await waitFor(() => pm.history().some(e => e.role === 'assistant' && e.text.includes('FOREMAN_PM_ALIVE_RECOVERED')), 'New input must receive a real recorded answer on the same PM');
      assert.equal(launches, 2); assert.equal(pm.lastError, null);
      assert.equal(pm.history().filter(e => e.role === 'user').length, 2);
      assert.ok(!pm.history().some(e => e.role === 'assistant' && e.text.includes('FAILED_INPUT_MUST_NOT_REPLAY')), 'Failed input must not be replayed');
    } finally { pm.close(); await running; }
  });

}
