import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HOST, isIsoTimestamp, NOTIFY_KINDS, PUSH_KINDS, DEFAULT_PUSH_KINDS, MAX_NOTIFY_FRAME, MAX_PUSH_PAYLOAD,
  parseNotifyFrame, cleanDisplayName, notifyId, buildPushPayload, parseDeepLink, pushUrlIsSafe,
  sessionUrl, utf8Length, type NotifyFrame, type NotifyKind, type PushPayload,
} from '../shared/notify.ts';

const AT = '2026-09-24T12:34:56.789Z';
const KEY = 'fm:3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21';

function frame(kind: NotifyKind, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = { type: 'notify', id: notifyId(kind, 'host-a', KEY, '1'), kind, host: 'hong-mbp', at: AT };
  if (kind !== 'pm_failed') { base.session_key = KEY; base.session_name = 'fix-login'; }
  return { ...base, ...extra };
}

test('kind lists match the contract', () => {
  assert.deepEqual([...NOTIFY_KINDS], ['approval_requested', 'question_asked', 'session_failed', 'pm_failed']);
  assert.deepEqual([...PUSH_KINDS], [...NOTIFY_KINDS, 'host_offline']);
  assert.deepEqual([...DEFAULT_PUSH_KINDS], [...PUSH_KINDS]);
  assert.equal((PUSH_KINDS as readonly string[]).includes('test'), false);
});

test('parseNotifyFrame accepts a good frame of each kind and returns a copy', () => {
  for (const kind of NOTIFY_KINDS) {
    const raw = frame(kind);
    const parsed = parseNotifyFrame(raw);
    assert.deepEqual(parsed, raw, kind);
    assert.notEqual(parsed, raw);
  }
  // session_name is optional
  const noName = frame('session_failed'); delete noName.session_name;
  assert.deepEqual(parseNotifyFrame(noName), noName);
  // timezone offsets and no fractional seconds are valid ISO
  assert.ok(parseNotifyFrame(frame('pm_failed', { at: '2026-09-24T12:34:56+09:30' })));
});

test('parseNotifyFrame rejects malformed frames', () => {
  const rejects: [string, unknown][] = [
    ['unknown kind', frame('approval_requested', { kind: 'bogus' })],
    ['turn_finished', frame('approval_requested', { kind: 'turn_finished' })],
    ['host_offline is not a frame kind', frame('pm_failed', { kind: 'host_offline' })],
    ['wrong type', frame('pm_failed', { type: 'request' })],
    ['extra key', frame('approval_requested', { text: 'rm -rf /' })],
    ['extra undefined key', frame('approval_requested', { input: undefined })],
    ['missing session_key (approval)', frame('approval_requested', { session_key: undefined })],
    ['missing session_key (question)', (() => { const f = frame('question_asked'); delete f.session_key; return f; })()],
    ['missing session_key (failed)', (() => { const f = frame('session_failed'); delete f.session_key; return f; })()],
    ['session_key on pm_failed', frame('pm_failed', { session_key: KEY })],
    ['empty session_key', frame('approval_requested', { session_key: '' })],
    ['session_key too long', frame('approval_requested', { session_key: 'k'.repeat(301) })],
    ['session_key with space', frame('approval_requested', { session_key: 'fm: x' })],
    ['non-string session_name', frame('approval_requested', { session_name: 5 })],
    ['oversize', frame('approval_requested', { session_name: 'x'.repeat(MAX_NOTIFY_FRAME) })],
    ['oversize multibyte', frame('approval_requested', { session_name: '\u00e9'.repeat(1000) })],
    ['bad id charset', frame('pm_failed', { id: 'pm failed!' })],
    ['id with slash', frame('pm_failed', { id: 'a/b' })],
    ['empty id', frame('pm_failed', { id: '' })],
    ['id too long', frame('pm_failed', { id: 'a'.repeat(101) })],
    ['empty host', frame('pm_failed', { host: '' })],
    ['host too long', frame('pm_failed', { host: 'h'.repeat(101) })],
    ['non-ISO at', frame('pm_failed', { at: 'Thu Sep 24 2026' })],
    ['date-only at', frame('pm_failed', { at: '2026-09-24' })],
    ['impossible date', frame('pm_failed', { at: '2026-02-30T00:00:00Z' })],
    ['numeric at', frame('pm_failed', { at: Date.now() })],
    ['null', null],
    ['string', JSON.stringify(frame('pm_failed'))],
    ['array', [frame('pm_failed')]],
    ['number', 42],
  ];
  for (const [label, raw] of rejects) assert.equal(parseNotifyFrame(raw), null, label);
  // A frame just under the limit still passes, so the size check is not rejecting everything.
  const probe = frame('approval_requested', { session_name: '' });
  const room = MAX_NOTIFY_FRAME - utf8Length(JSON.stringify(probe));
  assert.ok(parseNotifyFrame(frame('approval_requested', { session_name: 'x'.repeat(room) })));
  assert.equal(parseNotifyFrame(frame('approval_requested', { session_name: 'x'.repeat(room + 1) })), null);
});

test('parseNotifyFrame never throws on hostile getters', () => {
  const raw = frame('pm_failed');
  Object.defineProperty(raw, 'at', { enumerable: true, get() { throw new Error('boom'); } });
  assert.equal(parseNotifyFrame(raw), null);
});

test('cleanDisplayName strips controls and bidi overrides, collapses whitespace, truncates', () => {
  assert.equal(cleanDisplayName('  fix\n\tlogin\r\n  flow  '), 'fix login flow');
  assert.equal(cleanDisplayName('evil\u202egnp.exe\u2066x\u2069\u200b\u0007'), 'evilgnp.exex');
  assert.equal(cleanDisplayName('a\u2028b\u2029c'), 'a b c');
  const long = cleanDisplayName('x'.repeat(200));
  assert.equal(Array.from(long).length, 80);
  assert.ok(long.endsWith('\u2026'));
  assert.equal(cleanDisplayName('abcdef', 4), 'abc\u2026');
  assert.equal(cleanDisplayName('\u{1F600}'.repeat(5), 3), '\u{1F600}\u{1F600}\u2026');
  assert.equal(cleanDisplayName('short'), 'short');
});

test('notifyId is deterministic, bounded, and well-formed', () => {
  const a = notifyId('approval_requested', 'host', KEY, 'req-1');
  assert.equal(a, notifyId('approval_requested', 'host', KEY, 'req-1'));
  assert.notEqual(a, notifyId('approval_requested', 'host', KEY, 'req-2'));
  assert.notEqual(notifyId('pm_failed', 'a', 'bc'), notifyId('pm_failed', 'ab', 'c'));
  assert.notEqual(notifyId('pm_failed', 'x'), notifyId('session_failed', 'x'));
  assert.ok(a.startsWith('approval_requested:'));
  const big = notifyId('session_failed', 'x'.repeat(10_000), '\u{1F600}');
  assert.match(big, /^[A-Za-z0-9:_-]{1,100}$/);
  assert.ok(parseNotifyFrame(frame('session_failed', { id: big })));
});

test('buildPushPayload renders each kind exactly as specified', () => {
  const cases: [Parameters<typeof buildPushPayload>[0], Omit<PushPayload, 'v' | 'at'>][] = [
    [frame('approval_requested') as unknown as NotifyFrame, { kind: 'approval_requested', host: 'hong-mbp', session_key: KEY, session_name: 'fix-login', tag: `session:${KEY}`, url: `/?session=${encodeURIComponent(KEY)}`, title: 'Approval needed', body: 'fix-login is waiting for your approval' }],
    [frame('question_asked') as unknown as NotifyFrame, { kind: 'question_asked', host: 'hong-mbp', session_key: KEY, session_name: 'fix-login', tag: `session:${KEY}`, url: `/?session=${encodeURIComponent(KEY)}`, title: 'Question from fix-login', body: 'fix-login has a question for you' }],
    [frame('session_failed') as unknown as NotifyFrame, { kind: 'session_failed', host: 'hong-mbp', session_key: KEY, session_name: 'fix-login', tag: `session:${KEY}`, url: `/?session=${encodeURIComponent(KEY)}`, title: 'Session failed', body: 'fix-login stopped with an error. Open Foreman for details.' }],
    [frame('pm_failed') as unknown as NotifyFrame, { kind: 'pm_failed', host: 'hong-mbp', tag: 'pm', url: '/?view=pm', title: 'PM needs attention', body: 'The project manager hit an error. Open Foreman for details.' }],
    [{ kind: 'host_offline', host: 'hong-mbp', at: AT }, { kind: 'host_offline', host: 'hong-mbp', tag: 'host', url: '/', title: 'Mac offline', body: 'hong-mbp has been disconnected for over 5 minutes.' }],
    [{ kind: 'test', host: 'hong-mbp', at: AT }, { kind: 'test', host: 'hong-mbp', tag: 'test', url: '/', title: 'Foreman notifications are on', body: 'You will be notified when a session needs you.' }],
  ];
  for (const [event, expected] of cases) {
    const payload = buildPushPayload(event);
    assert.deepEqual(payload, { v: 1, at: AT, ...expected }, expected.kind);
    assert.ok(pushUrlIsSafe(payload.url));
  }
});

test('buildPushPayload uses "A session" when the name is missing or blank', () => {
  for (const session_name of [undefined, '', ' \n\u202e ']) {
    const f = frame('approval_requested', { session_name }) as unknown as NotifyFrame;
    const p = buildPushPayload(f);
    assert.equal(p.body, 'A session is waiting for your approval');
    assert.equal('session_name' in p, false);
    assert.equal(buildPushPayload({ ...f, kind: 'question_asked' }).title, 'Question from A session');
    assert.equal(buildPushPayload({ ...f, kind: 'session_failed' }).body, 'A session stopped with an error. Open Foreman for details.');
  }
});

test('buildPushPayload never leaks hostile content', () => {
  const path = '/Users/hong/secret-project/services/billing/deploy/credentials/production/aws/SECRET_TAIL_MARKER.env';
  assert.ok(path.length > 80);
  const toolInput = '\n{"command":"cat ~/.ssh/id_rsa"}\nTOOL_INPUT_MARKER';
  const transcript = 'TRANSCRIPT_MARKER '.repeat(600); // ~10 KB
  assert.ok(transcript.length >= 10_000);
  const hostile = {
    ...frame('approval_requested'),
    session_name: `${path}${toolInput}\u0000\u001b[31m\u202e${transcript}`,
    text: 'TEXT_MARKER', input: { command: 'INPUT_MARKER' }, error: 'ERROR_MARKER',
    transcript_path: '/tmp/TRANSCRIPT_PATH_MARKER.jsonl', cwd: '/CWD_MARKER', last_message: 'LAST_MESSAGE_MARKER',
  };
  for (const kind of [...NOTIFY_KINDS, 'host_offline', 'test'] as const) {
    const payload = buildPushPayload({ ...hostile, kind } as unknown as NotifyFrame);
    const json = JSON.stringify(payload);
    assert.ok(utf8Length(json) <= MAX_PUSH_PAYLOAD, kind);
    assert.doesNotMatch(json, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/, kind);
    assert.doesNotMatch(json, /\\[nrtbfu]/, kind); // no escaped control characters either
    for (const marker of ['TOOL_INPUT_MARKER', 'id_rsa', 'TRANSCRIPT_MARKER TRANSCRIPT_MARKER', 'TEXT_MARKER', 'INPUT_MARKER', 'ERROR_MARKER', 'TRANSCRIPT_PATH_MARKER', 'CWD_MARKER', 'LAST_MESSAGE_MARKER'])
      assert.equal(json.includes(marker), false, `${kind} leaked ${marker}`);
    assert.deepEqual(Object.keys(payload).filter((k) => !['v', 'kind', 'host', 'session_key', 'session_name', 'at', 'tag', 'title', 'body', 'url'].includes(k)), []);
    if (kind === 'approval_requested' || kind === 'question_asked' || kind === 'session_failed') {
      // Only the cleaned, 80-code-point name survives: the path is cut off inside it.
      assert.equal(Array.from(payload.session_name!).length, 80);
      assert.equal(payload.session_name, cleanDisplayName(hostile.session_name));
      assert.equal(payload.session_name, `${path.slice(0, 79)}\u2026`);
    } else {
      assert.equal(json.includes(path.slice(0, 40)), false, kind);
    }
    assert.equal(json.includes('SECRET_TAIL_MARKER'), false, kind);
    assert.equal(json.includes(path.slice(79)), false, kind);
  }
});

test('buildPushPayload stays within MAX_PUSH_PAYLOAD for worst-case field sizes', () => {
  const worst = {
    ...frame('question_asked'),
    host: '\u{1F600}'.repeat(100),
    session_key: '"\\'.repeat(150),
    session_name: '\u{1F600}'.repeat(500),
  } as unknown as NotifyFrame;
  for (const kind of [...NOTIFY_KINDS, 'host_offline', 'test'] as const) {
    const payload = buildPushPayload({ ...worst, kind } as NotifyFrame);
    assert.ok(utf8Length(JSON.stringify(payload)) <= MAX_PUSH_PAYLOAD, kind);
    assert.ok(pushUrlIsSafe(payload.url));
  }
});

test('#126: buildPushPayload throws on an unknown kind instead of rendering a test notification', () => {
  const unknown: unknown[] = [
    { ...frame('approval_requested'), kind: 'bogus_SECRET' },
    { ...frame('approval_requested'), kind: undefined },
    { ...frame('approval_requested'), kind: 'turn_finished' },
    { host: 'hong-mbp', at: AT },
    null, 'approval_requested', [],
  ];
  for (const event of unknown) {
    assert.throws(() => buildPushPayload(event as NotifyFrame), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal((error as Error).message.includes('SECRET'), false, 'the error names nothing from the input');
      return true;
    });
  }
  // The known kinds, including the relay's own host_offline and test, still render.
  for (const kind of [...NOTIFY_KINDS, 'host_offline', 'test'] as const) assert.equal(buildPushPayload({ ...frame('approval_requested'), kind } as unknown as NotifyFrame).kind, kind);
});

test('#126: the host is cleaned and bounded in every payload', () => {
  const dirty = '  hong’s\n\tMac‮​book\u0007  ';
  for (const kind of [...NOTIFY_KINDS, 'host_offline', 'test'] as const) {
    const payload = buildPushPayload({ ...frame('approval_requested'), host: dirty, kind } as unknown as NotifyFrame);
    assert.equal(payload.host, 'hong’s Macbook', kind);
    const long = buildPushPayload({ ...frame('approval_requested'), host: 'h'.repeat(300), kind } as unknown as NotifyFrame);
    assert.equal(Array.from(long.host).length, MAX_HOST, kind);
    assert.ok(long.host.endsWith('…'), kind);
  }
  assert.equal(buildPushPayload({ kind: 'host_offline', host: dirty, at: AT }).body, 'hong’s Macbook has been disconnected for over 5 minutes.');
  // A host that cleans to nothing (or is not a string) falls back to generic wording.
  assert.equal(buildPushPayload({ kind: 'host_offline', host: '​⁦\u0000 ', at: AT }).body, 'Your Mac has been disconnected for over 5 minutes.');
  assert.equal(buildPushPayload({ kind: 'host_offline', host: 42 as unknown as string, at: AT }).host, '');
});

test('#126: lone surrogates are stripped; valid pairs survive', () => {
  assert.equal(cleanDisplayName('a\ud800b'), 'ab', 'lone high surrogate');
  assert.equal(cleanDisplayName('a\udc00b'), 'ab', 'lone low surrogate');
  assert.equal(cleanDisplayName('\udc00\ud800'), '', 'reversed pair is two lone surrogates');
  assert.equal(cleanDisplayName('x\ud83d'), 'x', 'trailing high surrogate');
  // (built with fromCharCode: the TypeScript stripper rejects '\ud83d' written just before '\u{...}')
  assert.equal(cleanDisplayName('\u{1F600}' + String.fromCharCode(0xd83d) + '\u{1F680}'), '\u{1F600}\u{1F680}');
  const payload = buildPushPayload(frame('approval_requested', { session_name: 'fix\ud800-login\udfff', host: 'mac\udbff' }) as unknown as NotifyFrame);
  assert.equal(payload.session_name, 'fix-login');
  assert.equal(payload.host, 'mac');
  // The payload is well-formed UTF-16, so TextEncoder never substitutes U+FFFD.
  const json = JSON.stringify(payload);
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(json)), json);
  assert.equal(utf8Length('\ud800'), 3);
  assert.equal(utf8Length('\u{1F600}'), 4);
});

test('#126: timestamp offsets must be in range', () => {
  for (const ok of ['2026-09-24T12:34:56+23:59', '2026-09-24T12:34:56-23:59', '2026-09-24T12:34:56+00:00', '2026-09-24T12:34:56.1-05:30', '2026-02-28T00:00:00Z'])
    assert.equal(isIsoTimestamp(ok), true, ok);
  for (const bad of ['2026-09-24T12:34:56+24:00', '2026-09-24T12:34:56-24:00', '2026-09-24T12:34:56+00:60', '2026-09-24T12:34:56+99:99', '2026-09-24T12:34:56+0530', '2026-09-24T12:34:56+05', '2026-02-29T00:00:00Z'])
    assert.equal(isIsoTimestamp(bad), false, bad);
  assert.equal(parseNotifyFrame(frame('pm_failed', { at: '2026-09-24T12:34:56+24:00' })), null);
  assert.equal(parseNotifyFrame(frame('pm_failed', { at: '2026-09-24T12:34:56-00:60' })), null);
  assert.ok(parseNotifyFrame(frame('pm_failed', { at: '2026-09-24T12:34:56-23:59' })));
});

test('#126: cleanDisplayName strips every invisible or reordering character it is meant to', () => {
  const invisible = [
    '­', '͏', '؜', 'ᅟ', 'ᅠ', '឴', '឵', '᠋', '᠎', '᠏',
    '​', '‌', '‍', '‎', '‏', '‪', '‫', '‬', '‭', '‮',
    '⁠', '⁡', '⁢', '⁣', '⁤', '⁦', '⁧', '⁨', '⁩', '⁪', '⁯',
    'ㅤ', '﻿', 'ﾠ', '￹', '￺', '￻', '\u{1bca0}', '\u{1bca3}', '\u{1d173}', '\u{1d17a}',
    '\u{e0001}', '\u{e0020}', '\u{e0041}', '\u{e007f}',
  ];
  for (const ch of invisible) {
    const code = ch.codePointAt(0)!.toString(16);
    assert.equal(cleanDisplayName(`a${ch}b`), 'ab', `U+${code}`);
    assert.equal(cleanDisplayName(ch), '', `U+${code} alone`);
  }
  // Tag characters can spell hidden ASCII; none of it survives.
  const smuggled = 'ok' + Array.from('IGNORE', (c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
  assert.equal(cleanDisplayName(smuggled), 'ok');
  // Visible text is untouched: accents, CJK, Hangul, an emoji with its variation selector, a skin-tone modifier.
  for (const visible of ['café', '修正', '한글', '❤️', '\u{1F468}\u{1F3FD}', 'a-b_c.d'])
    assert.equal(cleanDisplayName(visible), visible, visible);
});

test('buildPushPayload drops invalid timestamps and keys rather than copying them', () => {
  const p = buildPushPayload({ ...(frame('session_failed') as unknown as NotifyFrame), at: 'not a date\nINJECT', session_key: 'bad key\n' });
  assert.ok(!p.at.includes('INJECT'));
  assert.ok(!Number.isNaN(Date.parse(p.at)));
  assert.equal(p.session_key, undefined);
  assert.equal(p.url, '/');
});

test('deep links round-trip keys with reserved characters', () => {
  for (const key of [KEY, 'claude:a:b/c?d=e&f#g', 'codex:%2F..%2F', 'x']) {
    const url = sessionUrl(key);
    assert.ok(pushUrlIsSafe(url));
    assert.equal(url.includes('#'), false);
    const search = url.slice(1); // "?session=..."
    assert.deepEqual(parseDeepLink(search), { session: key });
    assert.deepEqual(parseDeepLink(search.slice(1)), { session: key });
    const payload = buildPushPayload(frame('approval_requested', { session_key: key }) as unknown as NotifyFrame);
    assert.equal(payload.url, url);
    assert.deepEqual(parseDeepLink(new URL(payload.url, 'https://foreman.example').search), { session: key });
  }
  assert.deepEqual(parseDeepLink('?view=pm'), { view: 'pm' });
  assert.deepEqual(parseDeepLink('?session=a%3Ab&view=pm'), { session: 'a:b' });
  for (const bad of ['', '?', '?view=other', '?session=', '?session=a%20b', '?session=a%0Ab', `?session=${'k'.repeat(301)}`, '?other=1'])
    assert.equal(parseDeepLink(bad), null, bad);
});

test('pushUrlIsSafe accepts relative paths and rejects everything else', () => {
  for (const ok of ['/', '/?view=pm', `/?session=${encodeURIComponent('a:b/c')}`]) assert.equal(pushUrlIsSafe(ok), true, ok);
  for (const bad of ['https://evil', '//evil', '/\\evil', '\\\\evil', 'javascript:alert(1)', 'javascript:', 'data:text/html,x', 'evil', '', ' /', '/\nfoo', '/\tfoo', 'http:/evil', '/'.padEnd(3000, 'a')])
    assert.equal(pushUrlIsSafe(bad), false, JSON.stringify(bad));
  assert.equal(pushUrlIsSafe(undefined as unknown as string), false);
});
