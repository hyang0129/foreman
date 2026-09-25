import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PM_OPS, PM_ERROR_CODES, UNCERTAIN_REASONS, HOST_UNCERTAIN_REASONS, TURN_OUTCOMES, PM_MEMORY_TOOLS, PM_HUNG_DEFAULT_MS,
  MAX_PM_FRAME, MAX_PM_IMPORT_FRAME, MAX_PM_RESULT_FRAME, PM_DOC_LIMITS, MAX_PROJECTS_DOC, MAX_PREFERENCES_DOC,
  MIN_LOG_ENTRY, MAX_LOG_ENTRY, MAX_LOG_KEPT, MAX_LOG_READ, MAX_OPEN_TURNS, MAX_TURN_ID, MAX_MACHINES, MAX_MACHINE_NAME,
  MAX_PM_ERROR_MESSAGE, MAX_PM_HISTORY, PM_HISTORY_KEYS, PM_HISTORY_SUMMARY_KEYS, MEMORY_KEYS, PM_DO_SCHEMA,
  PM_HOST_LOCAL_ONLY_ERROR, pmHostOfflineMessage,
  parseMachineIdentity, parseHello, isHelloV2, parsePmRpc, parsePmOpArgs, parsePmRpcResult, parsePmOpResult,
  parsePmAssignment, parsePmHostMoveRequest, pmRpcError, pmRpcOk, boundedReason,
  type PmOp, type PmRpc, type TypedPmRpc, type PmStateStore, type PmMemory, type PmHostResponse, type PmHostMoveResponse,
  type HostStatusResponse, type MemoryResponse, type PmAssignment,
} from '../shared/pm-state.ts';
import { utf8Length } from '../shared/notify.ts';

const MID = '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21';
const MID2 = 'a9b8c7d6-1234-4abc-8def-0123456789ab';
const AT = '2026-09-24T12:34:56.789Z';

test('constants match the sprint contract', () => {
  assert.deepEqual([...PM_OPS], ['memory.get', 'memory.put', 'memory.edit', 'memory.log', 'memory.import', 'settings.put', 'turn.begin', 'turn.end', 'turn.ack_uncertain']);
  assert.deepEqual([...PM_ERROR_CODES], ['stale_epoch', 'not_active', 'version_conflict', 'too_large', 'invalid', 'already_initialized', 'unavailable']);
  assert.deepEqual([...UNCERTAIN_REASONS], ['restarted', 'reassigned', 'host_lost']);
  assert.deepEqual([...HOST_UNCERTAIN_REASONS], ['restarted', 'reassigned', 'host_lost', 'hung']);
  assert.deepEqual([...TURN_OUTCOMES], ['completed', 'failed', 'cancelled', 'uncertain']);
  assert.deepEqual([...PM_MEMORY_TOOLS], ['mcp__fleet__memory_read', 'mcp__fleet__memory_write', 'mcp__fleet__memory_edit', 'mcp__fleet__log_note']);
  assert.equal(PM_HUNG_DEFAULT_MS, 300_000);
  assert.equal(MAX_PM_FRAME, 65536);
  assert.equal(MAX_PM_RESULT_FRAME, 1_048_576);
  assert.equal(MAX_PM_IMPORT_FRAME, 1_048_576);
  assert.equal(MAX_PM_IMPORT_FRAME, MAX_PM_RESULT_FRAME);
  assert.deepEqual({ ...PM_DOC_LIMITS }, { projects: 32768, preferences: 8192 });
  assert.equal(MAX_PROJECTS_DOC, 32768); assert.equal(MAX_PREFERENCES_DOC, 8192);
  assert.equal(MIN_LOG_ENTRY, 3); assert.equal(MAX_LOG_ENTRY, 500); assert.equal(MAX_LOG_KEPT, 2000); assert.equal(MAX_LOG_READ, 200);
  assert.equal(MAX_OPEN_TURNS, 64); assert.equal(MAX_TURN_ID, 100); assert.equal(MAX_MACHINES, 16); assert.equal(MAX_MACHINE_NAME, 80);
  assert.equal(MAX_PM_ERROR_MESSAGE, 300); assert.equal(MAX_PM_HISTORY, 200);
  assert.deepEqual([...PM_HISTORY_KEYS], ['history', 'error', 'busy', 'model', 'session_id']);
  assert.deepEqual([...PM_HISTORY_SUMMARY_KEYS], ['error', 'busy']);
  assert.deepEqual([...MEMORY_KEYS], ['projects', 'log', 'preferences']);
  assert.equal(PM_DO_SCHEMA.length, 7);
  for (const table of ['machines', 'pm_assignment', 'pm_docs', 'pm_log', 'pm_settings', 'pm_meta', 'pm_turns']) {
    assert.ok(PM_DO_SCHEMA.some((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`)), table);
  }
  assert.equal(PM_HOST_LOCAL_ONLY_ERROR, 'Reassignment needs the cloud relay');
  assert.equal(pmHostOfflineMessage('machine-b'), "Your PM's machine (machine-b) is offline.");
});

// ----- A. machine identity and hello -----

test('machine identity: accepts the machine.json shape and rejects malformed ones', () => {
  assert.deepEqual(parseMachineIdentity({ machine_id: MID, name: 'hong-mbp' }), { ok: true, value: { machine_id: MID, name: 'hong-mbp' } });
  assert.deepEqual(parseMachineIdentity({ machine_id: MID.toUpperCase(), name: 'x' }), { ok: true, value: { machine_id: MID, name: 'x' } });
  for (const bad of [
    null, [], 'x', {}, { machine_id: MID }, { name: 'x' },
    { machine_id: 'not-a-uuid', name: 'x' },
    { machine_id: '3f1c2b1e-8e0a-1f3c-9b2a-0d6f5c4e3a21', name: 'x' }, // v1, not v4
    { machine_id: MID, name: '' }, { machine_id: MID, name: '   ' }, { machine_id: MID, name: 'a'.repeat(81) },
    { machine_id: MID, name: 'a\nb' }, { machine_id: MID, name: 5 }, { machine_id: MID, name: 'x', extra: 1 },
  ]) assert.equal(parseMachineIdentity(bad).ok, false, JSON.stringify(bad));
  assert.equal(parseMachineIdentity({ machine_id: MID, name: 'a'.repeat(80) }).ok, true);
});

const hello = (extra: Record<string, unknown> = {}) => ({ type: 'hello', protocol: 2, machine_id: MID, host: 'machine-a', platform: 'darwin', pm_open_turns: [], ...extra });

test('hello v2: accepts valid frames', () => {
  const r = parseHello(hello());
  assert.ok(r.ok);
  assert.deepEqual(r.value, hello());
  assert.ok(isHelloV2(r.value));
  const turns = Array.from({ length: 64 }, (_, i) => `turn-${i}`);
  const full = parseHello(hello({ pm_open_turns: turns, platform: 'linux', host: 'h'.repeat(80) }));
  assert.ok(full.ok);
  assert.deepEqual((full.value as any).pm_open_turns, turns);
  const upper = parseHello(hello({ machine_id: MID.toUpperCase() }));
  assert.ok(upper.ok && isHelloV2(upper.value) && upper.value.machine_id === MID);
});

test('hello: a legacy hello stays valid and is never v2', () => {
  for (const [raw, host] of [[{ type: 'hello', host: 'hong-mbp' }, 'hong-mbp'], [{ type: 'hello' }, null], [{ type: 'hello', host: 'x'.repeat(150) }, 'x'.repeat(100)], [{ type: 'hello', host: 'h', other: 1 }, 'h']] as const) {
    const r = parseHello(raw);
    assert.ok(r.ok, JSON.stringify(raw));
    assert.equal(isHelloV2(r.value), false);
    assert.equal(r.value.host, host);
  }
});

test('hello v2: rejects malformed, over-limit and oversize frames', () => {
  const rejects: [string, unknown][] = [
    ['not an object', 'hello'],
    ['wrong type', hello({ type: 'ping' })],
    ['protocol 3', hello({ protocol: 3 })],
    ['protocol string', hello({ protocol: '2' })],
    ['missing machine_id', (() => { const h: any = hello(); delete h.machine_id; return h; })()],
    ['bad machine_id', hello({ machine_id: 'abc' })],
    ['empty host', hello({ host: '' })],
    ['host too long', hello({ host: 'h'.repeat(81) })],
    ['host control char', hello({ host: 'a\u0007b' })],
    ['missing platform', hello({ platform: undefined })],
    ['bad platform', hello({ platform: 'dar win' })],
    ['platform too long', hello({ platform: 'p'.repeat(33) })],
    ['pm_open_turns not array', hello({ pm_open_turns: 'turn-1' })],
    ['65 open turns', hello({ pm_open_turns: Array.from({ length: 65 }, (_, i) => `t${i}`) })],
    ['duplicate turn ids', hello({ pm_open_turns: ['t1', 't1'] })],
    ['turn id too long', hello({ pm_open_turns: ['t'.repeat(101)] })],
    ['turn id bad charset', hello({ pm_open_turns: ['t 1'] })],
    ['extra key', hello({ text: 'hi' })],
  ];
  for (const [label, raw] of rejects) assert.equal(parseHello(raw).ok, false, label);
});

// ----- B. pm_rpc -----

const rpc = (op: string, args: unknown, extra: Record<string, unknown> = {}) => ({ type: 'pm_rpc', id: 'rpc-1', epoch: 3, op, args, ...extra });

// Every valid example from the plan (section B).
const VALID_ARGS: [PmOp, unknown][] = [
  ['memory.get', {}],
  ['memory.put', { doc: 'projects', content: '## foreman\nGoal: ship #26', expected_version: 0 }],
  ['memory.put', { doc: 'preferences', content: '', expected_version: 7 }],
  ['memory.put', { doc: 'projects', content: 'x'.repeat(32 * 1024), expected_version: 1 }],
  ['memory.put', { doc: 'preferences', content: 'p'.repeat(8 * 1024), expected_version: 1 }],
  ['memory.edit', { doc: 'projects', old_text: 'blocked', new_text: 'unblocked', expected_version: 2 }],
  ['memory.edit', { doc: 'preferences', old_text: 'terse', new_text: '', expected_version: 2 }],
  ['memory.log', { text: 'foreman: PMM-01 landed' }],
  ['memory.log', { text: 'abc' }],
  ['memory.log', { text: 'x'.repeat(500) }],
  ['memory.import', { projects: '## foreman\n- state: planning', log: ['2026-09-01 started', '2026-09-02 planned'], model: 'claude-opus-4-1', source_machine: MID }],
  ['memory.import', { projects: '', log: [], model: null, source_machine: MID }],
  ['memory.import', { projects: 'x'.repeat(32 * 1024), log: Array.from({ length: 2000 }, (_, i) => `entry ${i} `.padEnd(100, '.')), model: 'opus[1m]', source_machine: MID }],
  ['settings.put', { model: 'claude-sonnet-4-5' }],
  ['settings.put', { model: null }],
  ['turn.begin', { turn_id: 'turn-01J8Z', accepted_at: AT }],
  ['turn.begin', { turn_id: 'fm:3f1c2b1e_x', accepted_at: '2026-09-24T12:34:56+09:30' }],
  ...TURN_OUTCOMES.map((outcome) => ['turn.end', { turn_id: 'turn-1', outcome }] as [PmOp, unknown]),
  ['turn.ack_uncertain', { turn_ids: ['turn-1'] }],
  ['turn.ack_uncertain', { turn_ids: Array.from({ length: 64 }, (_, i) => `t${i}`) }],
];

test('pm_rpc: accepts every valid example and returns a typed copy', () => {
  for (const [op, args] of VALID_ARGS) {
    const raw = rpc(op, args);
    const r = parsePmRpc(raw);
    assert.ok(r.ok, `${op} ${JSON.stringify(r)}`);
    assert.deepEqual(r.value, raw, op);
    assert.notEqual(r.value.args, args);
    const contract: PmRpc = r.value; // a typed rpc is assignable to the contract interface
    assert.equal(contract.op, op);
  }
  assert.ok(parsePmRpc(rpc('memory.get', {}, { epoch: 0 })).ok);
  assert.ok(parsePmRpc(rpc('memory.get', {}, { id: 'a'.repeat(100) })).ok);
  // machine ids are normalized
  const imp = parsePmRpc(rpc('memory.import', { projects: '', log: [], model: null, source_machine: MID.toUpperCase() }));
  assert.ok(imp.ok && imp.value.op === 'memory.import' && imp.value.args.source_machine === MID);
});

test('pm_rpc: narrowing by op gives typed args', () => {
  const r = parsePmRpc(rpc('memory.put', { doc: 'projects', content: 'c', expected_version: 1 }));
  assert.ok(r.ok);
  const v: TypedPmRpc = r.value;
  if (v.op === 'memory.put') assert.equal(v.args.expected_version, 1);
  else assert.fail('op');
});

test('pm_rpc: rejects unknown ops, wrong types and bad envelopes with code invalid', () => {
  const rejects: [string, unknown, string | null][] = [
    ['not an object', 'pm_rpc', null],
    ['wrong type', rpc('memory.get', {}, { type: 'notify' }), null],
    ['unknown op', rpc('memory.delete', {}), 'rpc-1'],
    ['op not a string', rpc(5 as any, {}), 'rpc-1'],
    ['missing id', rpc('memory.get', {}, { id: undefined }), null],
    ['bad id', rpc('memory.get', {}, { id: 'a b' }), null],
    ['id too long', rpc('memory.get', {}, { id: 'a'.repeat(101) }), null],
    ['extra key', rpc('memory.get', {}, { text: 'secret' }), 'rpc-1'],
    ['negative epoch', rpc('memory.get', {}, { epoch: -1 }), 'rpc-1'],
    ['fractional epoch', rpc('memory.get', {}, { epoch: 1.5 }), 'rpc-1'],
    ['string epoch', rpc('memory.get', {}, { epoch: '3' }), 'rpc-1'],
    ['args array', rpc('memory.get', []), 'rpc-1'],
    ['args null', rpc('memory.get', null), 'rpc-1'],
    ['get with keys', rpc('memory.get', { doc: 'projects' }), 'rpc-1'],
    ['put bad doc', rpc('memory.put', { doc: 'log', content: '', expected_version: 0 }), 'rpc-1'],
    ['put content number', rpc('memory.put', { doc: 'projects', content: 5, expected_version: 0 }), 'rpc-1'],
    ['put missing version', rpc('memory.put', { doc: 'projects', content: '' }), 'rpc-1'],
    ['put negative version', rpc('memory.put', { doc: 'projects', content: '', expected_version: -1 }), 'rpc-1'],
    ['put extra key', rpc('memory.put', { doc: 'projects', content: '', expected_version: 0, path: '/Users' }), 'rpc-1'],
    ['edit empty old_text', rpc('memory.edit', { doc: 'projects', old_text: '', new_text: 'x', expected_version: 0 }), 'rpc-1'],
    ['edit new_text null', rpc('memory.edit', { doc: 'projects', old_text: 'a', new_text: null, expected_version: 0 }), 'rpc-1'],
    ['log too short', rpc('memory.log', { text: 'ab' }), 'rpc-1'],
    ['log blank', rpc('memory.log', { text: '      ' }), 'rpc-1'],
    ['log number', rpc('memory.log', { text: 12345 }), 'rpc-1'],
    ['import bad log item', rpc('memory.import', { projects: '', log: ['ok entry', 5], model: null, source_machine: MID }), 'rpc-1'],
    ['import short log item', rpc('memory.import', { projects: '', log: ['x'], model: null, source_machine: MID }), 'rpc-1'],
    ['import missing model', rpc('memory.import', { projects: '', log: [], source_machine: MID }), 'rpc-1'],
    ['import bad source', rpc('memory.import', { projects: '', log: [], model: null, source_machine: 'machine-a' }), 'rpc-1'],
    ['settings missing model', rpc('settings.put', {}), 'rpc-1'],
    ['settings bad model', rpc('settings.put', { model: 'bad model!' }), 'rpc-1'],
    ['settings empty model', rpc('settings.put', { model: '' }), 'rpc-1'],
    ['begin bad turn id', rpc('turn.begin', { turn_id: 't/1', accepted_at: AT }), 'rpc-1'],
    ['begin long turn id', rpc('turn.begin', { turn_id: 't'.repeat(101), accepted_at: AT }), 'rpc-1'],
    ['begin bad time', rpc('turn.begin', { turn_id: 't1', accepted_at: 'yesterday' }), 'rpc-1'],
    ['begin with message text', rpc('turn.begin', { turn_id: 't1', accepted_at: AT, text: 'hello pm' }), 'rpc-1'],
    ['end bad outcome', rpc('turn.end', { turn_id: 't1', outcome: 'done' }), 'rpc-1'],
    ['end with error text', rpc('turn.end', { turn_id: 't1', outcome: 'failed', error: 'boom' }), 'rpc-1'],
    ['ack empty', rpc('turn.ack_uncertain', { turn_ids: [] }), 'rpc-1'],
    ['ack 65', rpc('turn.ack_uncertain', { turn_ids: Array.from({ length: 65 }, (_, i) => `t${i}`) }), 'rpc-1'],
    ['ack duplicate', rpc('turn.ack_uncertain', { turn_ids: ['t1', 't1'] }), 'rpc-1'],
  ];
  for (const [label, raw, id] of rejects) {
    const r = parsePmRpc(raw);
    assert.equal(r.ok, false, label);
    if (!r.ok) { assert.equal(r.code, 'invalid', label); assert.equal(r.id, id, label); assert.equal(typeof r.error, 'string'); }
  }
});

test('pm_rpc: over-limit content and oversize frames get code too_large', () => {
  const rejects: [string, unknown][] = [
    ['projects > 32 KiB', rpc('memory.put', { doc: 'projects', content: 'x'.repeat(32 * 1024 + 1), expected_version: 0 })],
    ['projects > 32 KiB multibyte', rpc('memory.put', { doc: 'projects', content: 'é'.repeat(16 * 1024 + 1), expected_version: 0 })],
    ['preferences > 8 KiB', rpc('memory.put', { doc: 'preferences', content: 'p'.repeat(8 * 1024 + 1), expected_version: 0 })],
    ['edit text > doc limit', rpc('memory.edit', { doc: 'preferences', old_text: 'a', new_text: 'p'.repeat(8 * 1024 + 1), expected_version: 0 })],
    ['log > 500', rpc('memory.log', { text: 'x'.repeat(501) })],
    ['import projects > 32 KiB', rpc('memory.import', { projects: 'x'.repeat(32 * 1024 + 1), log: [], model: null, source_machine: MID })],
    ['import > 2000 log entries', rpc('memory.import', { projects: '', log: Array.from({ length: 2001 }, () => 'entry'), model: null, source_machine: MID })],
    ['import log entry > 500', rpc('memory.import', { projects: '', log: ['x'.repeat(501)], model: null, source_machine: MID })],
    ['frame > 64 KiB', rpc('memory.put', { doc: 'projects', content: '"'.repeat(32 * 1024), expected_version: 0 })],
    ['frame > 64 KiB (junk arg)', rpc('memory.log', { text: 'ok text', junk: 'x'.repeat(MAX_PM_FRAME) })],
    ['import frame > import bound', rpc('memory.import', { projects: '', log: Array.from({ length: 2000 }, () => '\u0001'.repeat(500)), model: null, source_machine: MID })],
  ];
  for (const [label, raw] of rejects) {
    assert.ok(utf8Length(JSON.stringify(raw)) > 0);
    const r = parsePmRpc(raw);
    assert.equal(r.ok, false, label);
    if (!r.ok) { assert.equal(r.code, 'too_large', `${label}: ${r.error}`); assert.equal(r.id, 'rpc-1'); }
  }
});

test('memory.import: the frame bound is 1 MiB and the host trims the oldest log lines to fit', () => {
  // A full-size import (32 KiB projects + 2000 × 500-char lines) exceeds 1 MiB once the lines are
  // multibyte (ASCII-only it is ~1.01 MB and fits), and is too_large.
  const full = Array.from({ length: 2000 }, (_, i) => `${i}:`.padEnd(500, 'é'));
  const frame = (projects: string, log: string[]) => rpc('memory.import', { projects, log, model: null, source_machine: MID });
  const size = (raw: unknown) => utf8Length(JSON.stringify(raw));
  assert.ok(size(frame('x'.repeat(32 * 1024), full)) > MAX_PM_IMPORT_FRAME);
  const over = parsePmRpc(frame('x'.repeat(32 * 1024), full));
  assert.ok(!over.ok && over.code === 'too_large' && over.id === 'rpc-1');
  // Dropping the oldest lines until it fits yields an accepted frame that keeps the newest lines.
  const base = 'x'.repeat(30 * 1024);
  let log = full;
  while (size(frame(base, log)) > MAX_PM_IMPORT_FRAME) log = log.slice(1);
  assert.ok(log.length > 900 && log.length < 1100, String(log.length));
  assert.equal(log[log.length - 1], full[full.length - 1]);
  assert.ok(parsePmRpc(frame(base, log)).ok);
  // Exactly at the bound is accepted; one byte over is too_large (every field individually valid).
  const slack = MAX_PM_IMPORT_FRAME - size(frame(base, log));
  assert.ok(slack >= 0 && slack < 2048, String(slack));
  const atBound = frame(base + 'x'.repeat(slack), log);
  assert.equal(size(atBound), MAX_PM_IMPORT_FRAME);
  assert.ok(parsePmRpc(atBound).ok);
  const oneOver = parsePmRpc(frame(base + 'x'.repeat(slack + 1), log));
  assert.ok(!oneOver.ok && oneOver.code === 'too_large', JSON.stringify(oneOver));
});

test('parsePmOpArgs never throws on hostile input', () => {
  const hostile = Object.create({ inherited: 1 });
  const getter = { get doc() { throw new Error('boom'); } };
  for (const op of PM_OPS) {
    for (const args of [undefined, null, 1, 'x', [], hostile, getter, new Map()]) {
      const r = parsePmOpArgs(op, args);
      assert.equal(r.ok, false, `${op} ${String(args)}`);
    }
  }
  assert.equal(parsePmOpArgs('nope' as PmOp, {}).ok, false);
});

// ----- B. pm_rpc_result -----

test('pm_rpc_result: envelopes and per-op results', () => {
  const ok = { type: 'pm_rpc_result', id: 'rpc-1', ok: true, result: { version: 4 } };
  assert.deepEqual(parsePmRpcResult(ok), { ok: true, value: ok });
  const err = { type: 'pm_rpc_result', id: 'rpc-1', ok: false, code: 'stale_epoch', message: 'epoch 3 is stale; active epoch is 4' };
  assert.deepEqual(parsePmRpcResult(err), { ok: true, value: err });
  for (const code of PM_ERROR_CODES) assert.ok(parsePmRpcResult({ ...err, code }).ok, code);
  for (const [label, bad] of [
    ['unknown code', { ...err, code: 'nope' }],
    ['message too long', { ...err, message: 'x'.repeat(301) }],
    ['ok not boolean', { ...ok, ok: 'true' }],
    ['missing result', { type: 'pm_rpc_result', id: 'rpc-1', ok: true }],
    ['error with result', { ...err, result: {} }],
    ['bad id', { ...ok, id: '' }],
    ['wrong type', { ...ok, type: 'pm_rpc' }],
    ['oversize', { ...ok, result: 'x'.repeat(MAX_PM_RESULT_FRAME) }],
  ] as [string, unknown][]) assert.equal(parsePmRpcResult(bad).ok, false, label);

  const doc = (content: string, version = 1) => ({ content, version, updated_at: AT });
  const memory = {
    initialized: true,
    docs: { projects: doc('x'.repeat(32 * 1024)), preferences: doc('p'.repeat(8 * 1024)) },
    log: Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, at: AT, text: 'e'.repeat(500) })),
    settings: { model: 'claude-opus-4-1' },
  };
  assert.deepEqual(parsePmOpResult('memory.get', memory), { ok: true, value: memory });
  // the largest memory.get result fits the result frame bound
  assert.ok(utf8Length(JSON.stringify({ type: 'pm_rpc_result', id: 'r'.repeat(100), ok: true, result: memory })) < MAX_PM_RESULT_FRAME);
  const empty = { initialized: false, docs: { projects: { content: '', version: 0, updated_at: '' }, preferences: { content: '', version: 0, updated_at: '' } }, log: [], settings: { model: null } };
  assert.ok(parsePmOpResult('memory.get', empty).ok);
  assert.equal(parsePmOpResult('memory.get', { ...memory, log: [...memory.log, memory.log[0]] }).ok, false, '201 log entries');
  assert.equal(parsePmOpResult('memory.get', { ...memory, docs: { ...memory.docs, projects: doc('x'.repeat(32 * 1024 + 1)) } }).ok, false, 'projects too large');
  assert.equal(parsePmOpResult('memory.get', { ...memory, docs: { ...memory.docs, projects: { content: 'x', version: 1, updated_at: '' } } }).ok, false, 'written doc without time');
  assert.equal(parsePmOpResult('memory.get', { ...memory, settings: {} }).ok, false, 'settings without model');
  assert.equal(parsePmOpResult('memory.get', { ...memory, transcript: [] }).ok, false, 'extra key');
  assert.deepEqual(parsePmOpResult('memory.put', { version: 2 }), { ok: true, value: { version: 2 } });
  assert.deepEqual(parsePmOpResult('memory.edit', { version: 3 }), { ok: true, value: { version: 3 } });
  assert.deepEqual(parsePmOpResult('memory.log', { seq: 9 }), { ok: true, value: { seq: 9 } });
  assert.deepEqual(parsePmOpResult('memory.import', { imported: true }), { ok: true, value: { imported: true } });
  for (const op of ['settings.put', 'turn.begin', 'turn.end', 'turn.ack_uncertain'] as const) {
    assert.deepEqual(parsePmOpResult(op, {}), { ok: true, value: {} });
    assert.equal(parsePmOpResult(op, { x: 1 }).ok, false);
  }
  assert.equal(parsePmOpResult('memory.put', { version: -1 }).ok, false);
  assert.equal(parsePmOpResult('memory.import', { imported: false }).ok, false);
});

test('pmRpcError redacts and bounds the message; pmRpcOk builds a result', () => {
  const e = pmRpcError('rpc-1', 'invalid', `rejected Authorization: Basic dXNlcjpwYXNz ${'x'.repeat(400)}`);
  assert.equal(e.ok, false);
  if (!e.ok) {
    assert.ok(!e.message.includes('dXNlcjpwYXNz'));
    assert.ok(e.message.includes('Basic [REDACTED]'));
    assert.equal(Array.from(e.message).length, 300);
  }
  assert.ok(parsePmRpcResult(e).ok);
  assert.deepEqual(pmRpcOk('rpc-2', 'memory.log', { seq: 1 }), { type: 'pm_rpc_result', id: 'rpc-2', ok: true, result: { seq: 1 } });
  assert.equal(boundedReason('Authorization: required'), 'Authorization: required');
});

// ----- B. pm_assignment -----

test('pm_assignment: accepts active, standby and unassigned frames', () => {
  const active: PmAssignment = {
    type: 'pm_assignment', active: true, epoch: 4, active_machine: { machine_id: MID, host: 'machine-a' },
    uncertain_turns: UNCERTAIN_REASONS.map((reason, i) => ({ turn_id: `turn-${i}`, accepted_at: AT, host: 'machine-b', reason })),
  };
  assert.deepEqual(parsePmAssignment(active), { ok: true, value: active });
  const standby = { type: 'pm_assignment', active: false, epoch: 4, active_machine: { machine_id: MID2, host: 'machine-b' }, uncertain_turns: [] };
  assert.deepEqual(parsePmAssignment(standby), { ok: true, value: standby });
  const none = { type: 'pm_assignment', active: false, epoch: 0, active_machine: null, uncertain_turns: [] };
  assert.deepEqual(parsePmAssignment(none), { ok: true, value: none });
});

test('pm_assignment: rejects malformed frames', () => {
  const base = { type: 'pm_assignment', active: true, epoch: 1, active_machine: { machine_id: MID, host: 'a' }, uncertain_turns: [] as unknown[] };
  const turn = { turn_id: 't1', accepted_at: AT, host: 'a', reason: 'restarted' };
  for (const [label, bad] of [
    ['active without machine', { ...base, active_machine: null }],
    ['uncertain to a standby', { ...base, active: false, uncertain_turns: [turn] }],
    ['hung is host-only', { ...base, uncertain_turns: [{ ...turn, reason: 'hung' }] }],
    ['unknown reason', { ...base, uncertain_turns: [{ ...turn, reason: 'lost' }] }],
    ['turn with text', { ...base, uncertain_turns: [{ ...turn, text: 'the message' }] }],
    ['65 uncertain', { ...base, uncertain_turns: Array.from({ length: 65 }, (_, i) => ({ ...turn, turn_id: `t${i}` })) }],
    ['bad epoch', { ...base, epoch: -1 }],
    ['bad machine id', { ...base, active_machine: { machine_id: 'x', host: 'a' } }],
    ['extra key', { ...base, transcript: [] }],
    ['active not boolean', { ...base, active: 1 }],
  ] as [string, unknown][]) assert.equal(parsePmAssignment(bad).ok, false, label);
});

// ----- D. HTTP -----

test('POST /api/pm/host body validation', () => {
  assert.deepEqual(parsePmHostMoveRequest({ machine_id: MID2, expected_epoch: 4 }), { ok: true, value: { machine_id: MID2, expected_epoch: 4 } });
  for (const bad of [null, {}, { machine_id: MID2 }, { expected_epoch: 1 }, { machine_id: 'machine-b', expected_epoch: 1 }, { machine_id: MID2, expected_epoch: '1' }, { machine_id: MID2, expected_epoch: 1, force: true }]) {
    assert.equal(parsePmHostMoveRequest(bad).ok, false, JSON.stringify(bad));
  }
});

test('HTTP and store types describe the plan shapes', () => {
  // Compile-time checks: these literals must type-check against the contract.
  const host: PmHostResponse = {
    active: { machine_id: MID, name: 'machine-a', online: true, epoch: 1, assigned_at: 1, assigned_by: 'bootstrap' },
    machines: [{ machine_id: MID, name: 'machine-a', platform: 'darwin', online: true, last_seen: 1, active: true }],
    open_turns: 0, uncertain_turns: 0, mode: 'relay',
  };
  const moved: PmHostMoveResponse = { active: { ...host.active!, assigned_by: 'developer', epoch: 2 }, epoch: 2 };
  const status: HostStatusResponse = { online: true, host: 'machine-a', machine_id: MID, standby_online: false };
  const memory: MemoryResponse = { projects: '', log: '', preferences: '' };
  assert.deepEqual(Object.keys(memory), [...MEMORY_KEYS]);
  assert.equal(moved.epoch, 2);
  assert.equal(status.online, true);
  const noop = async () => {};
  const doc = { content: '', version: 0, updated_at: '' };
  const store: PmStateStore = {
    mode: 'local',
    read: async () => ({ initialized: false, projects: doc, preferences: doc, log: [], model: null }),
    write: async () => ({ version: 1 }), edit: async () => ({ version: 1 }), log: noop,
    assignment: () => ({ active: true, connected: true, epoch: 0, activeHost: null }),
    onAssignment: () => () => {}, setModel: noop, beginTurn: noop, endTurn: noop, ackUncertain: noop,
  };
  const memoryOnly: PmMemory = store;
  assert.equal(memoryOnly === store, true);
});
