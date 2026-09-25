// The project manager: a disposable Claude Agent SDK session in streaming-input mode (epic #26).
// Tool access is enforced here (canUseTool), not just prompted.
//
// Lifecycle (PMM-05, #83):
// - The PM keeps no transcript and never resumes a provider session. Every provider start is a fresh
//   session whose memory block is read from the PM state store (`HostPmStore`: the relay DO, or
//   pm/state.json in local-only mode). This file writes nothing to disk.
// - The current conversation is an in-memory list (≤ MAX_PM_HISTORY entries) scoped to the PM's
//   activation: empty on daemon start and whenever this machine becomes the active PM host. An
//   in-process provider restart keeps it and appends a neutral "fresh session" entry.
// - Every input is recorded write-ahead (`store.beginTurn`) before it is dispatched, and tracked
//   individually (turn id, dispatch time, whether the provider took it). A result settles exactly
//   the inputs it names (the SDK echoes each input's uuid in `user_message_uuids`); a result that
//   names none settles nothing during a peer turn and otherwise resolves the oldest taken input as
//   uncertain, never completed. Nothing is ever replayed or retried automatically.
// - #62: when inputs are outstanding and the provider has been silent for ≥ the hung threshold,
//   the next explicit send marks each outstanding input uncertain, retires the provider, starts a
//   fresh session and dispatches only the new input. Nothing is timer-driven.
import { query, type SDKUserMessage, type Query, type HookCallback, type TerminalReason, type SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import { normalizeModel } from "./models.ts";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { homedir } from "node:os";
import type { Fleet } from "./fleet.ts";
import type { ProjectRegistry } from "./projects.ts";
import { makeFleetServer, type ManagedFleetService } from "./tools.ts";
import { makePeerMcpServer, PEER_ALLOWED_TOOLS, PEER_INSTRUCTIONS } from "./peer-tools.ts";
import { FOREMAN_HOME, HOST, REPO_ROOT } from "./paths.ts";
import { PmStoreError, type HostPmStore } from "./pm-store.ts";
import { redactSecrets } from "../shared/redact.ts";
import {
  MAX_PM_HISTORY, PM_HUNG_DEFAULT_MS, PM_MEMORY_TOOLS,
  type Doc, type HostUncertainReason, type LogEntry, type PmAssignment, type TurnOutcome, type UncertainTurn,
} from "../shared/pm-state.ts";

export type PmEvent =
  | { type: "turn_start"; ts: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "assistant_text"; text: string }
  | { type: "turn_end"; ts: string; cost_usd: number; is_error: boolean; subtype: string }
  | { type: "status"; text: string }
  | { type: "peer"; text: string };

/** One entry of the current conversation (the `/api/pm/history` shape). */
export interface PmEntry { role: 'user' | 'assistant' | 'system' | 'tool' | 'peer'; ts: string; text?: string; error?: true; name?: string; summary?: string }

/** The part of the host bridge the PM reads: the latest `pm_assignment` on the current connection. */
export type PmAssignmentSource = { currentAssignment(): PmAssignment | null };

export interface ProjectManagerOptions {
  sessions?: ManagedFleetService;
  projects?: ProjectRegistry;
  /** This machine's display name (names the host in uncertain entries). Default HOST. */
  machineName?: string;
  /** Injectable clock (epoch ms) for the hung rule and timestamps. */
  now?: () => number;
  /** #62 threshold. Default FOREMAN_PM_HUNG_MS, else PM_HUNG_DEFAULT_MS. */
  hungMs?: number;
}

export interface PmAttachOptions {
  /** Relay mode: the bridge, to tell "awaiting this connection's assignment" from "moved away". */
  bridge?: PmAssignmentSource | null;
  /** Start the provider as soon as the PM is active (default true). Otherwise the first send starts it. */
  autoStart?: boolean;
}

/** A fresh provider session in the same conversation (not an error). */
export const FRESH_SESSION_NOTICE = 'Started a fresh PM session. It answers from memory, not from the messages above.';
export const RELAY_UNREACHABLE_MESSAGE = 'The cloud relay is unreachable; the PM is unavailable on this machine.';

export type PmStoreChoice = { mode: 'relay' | 'local' } | { mode: 'unavailable'; reason: string };
/**
 * Which PM state store this daemon may use (epic #26: never two PMs). Local-only mode applies only
 * when no relay is configured at all (`readRelayConfig` returns null: no cloud.json, no relay env).
 * A relay that is configured but invalid, or whose bridge did not start, means the relay holds the
 * PM: this machine runs no PM rather than a local one built from its own files.
 */
export function choosePmStore(readRelayConfig: () => unknown, hasBridge: boolean, env: NodeJS.ProcessEnv = process.env): PmStoreChoice {
  let config: unknown;
  try { config = readRelayConfig(); }
  catch (error) {
    const cause = safe(errorText(error), 300);
    const source = env.FOREMAN_RELAY_URL || env.FOREMAN_HOST_TOKEN ? 'the relay configuration (FOREMAN_RELAY_URL/FOREMAN_HOST_TOKEN)' : 'cloud.json';
    return { mode: 'unavailable', reason: `${source} is invalid (${cause}); the PM is unavailable on this machine` };
  }
  if (hasBridge) return { mode: 'relay' };
  if (config === null || config === undefined) return { mode: 'local' };
  return { mode: 'unavailable', reason: 'the cloud relay is configured but its connection could not be started; the PM is unavailable on this machine' };
}

// Human text for each uncertain reason, used in "could not be confirmed (<reason>)".
export const UNCERTAIN_REASON_TEXT: Readonly<Record<HostUncertainReason, string>> = {
  restarted: 'Foreman restarted',
  reassigned: 'the PM was moved',
  host_lost: 'machine went offline',
  hung: 'the PM stopped responding',
};
const UNMATCHED_REPLY = 'the reply could not be matched to your message';

/** "2026-09-24 12:00 UTC" for an ISO timestamp (the input unchanged if it does not parse). */
export function sendTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
export function uncertainText(acceptedAt: string, host: string, reason: string): string {
  return `Your message sent at ${sendTime(acceptedAt)} to the PM on ${host} could not be confirmed (${reason}). It was not replayed.`;
}
function undeliveredText(acceptedAt: string, host: string, reason: string): string {
  return `Your message sent at ${sendTime(acceptedAt)} to the PM on ${host} was not delivered (${reason}). It was not replayed.`;
}

const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$|^(readme|changelog|contributing|license|todo|roadmap)$/i;

const home = homedir();
const under = (p: string, dir: string) => { const a = resolve(p); const d = resolve(dir); return a === d || a.startsWith(d + sep); };
const expand = (p: string) => (p === '~' ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
const canonical = (p: string) => realpathSync(resolve(FOREMAN_HOME, p));

// The SDK's own abort reasons. Typed against the installed SDK so a typo or an SDK rename
// fails `npm run typecheck` instead of silently turning a Stop into a failure (or vice versa).
const SDK_ABORT_REASONS = ['aborted_streaming', 'aborted_tools'] as const satisfies readonly TerminalReason[];
const isAbortReason = (reason: unknown): boolean => (SDK_ABORT_REASONS as readonly unknown[]).includes(reason);
// The diagnostic an error result carries: primarily the text the SDK's exit echo uses (errors[]
// for an error subtype, `result` for an is_error success). Unlike the SDK, it falls back to the
// other field when the primary one is empty; the echo then differs, so it never suppresses one.
const resultDiagnostic = (m: any): string => {
  const errors = Array.isArray(m.errors) ? m.errors.map((e: unknown) => String(e).trim()).filter(Boolean).join('; ') : '';
  const result = typeof m.result === 'string' ? m.result : '';
  return (m.subtype === 'success' ? result || errors : errors || result);
};
const errorText = (error: unknown): string => String((error as any)?.message ?? error);
// Provider- or store-derived text that is logged, emitted or stored: redacted, then bounded.
const safe = (text: string, max: number): string => redactSecrets(text).slice(0, max);
// When the CLI exits after an error result, the SDK throws this echo of the result's diagnostic.
const sdkErrorResultEcho = (diagnostic: string) => `Claude Code returned an error result: ${diagnostic}`;
// The SDK's typed assistant error code (`SDKAssistantMessage['error']`, e.g. 'authentication_failed').
// Only a plain identifier is kept, so a malformed value cannot smuggle text into the diagnostic.
const assistantErrorCode = (value: unknown): SDKAssistantMessageError | null =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(value) ? value as SDKAssistantMessageError : null;
// Failure text for an assistant API error: the code and the human prose together, code first
// (`authentication_failed: OAuth session expired`), and not repeated when the prose names it.
const codedDiagnostic = (code: string | null, prose: string): string => {
  if (!code) return prose || 'Provider rejected the turn';
  if (!prose) return `${code}: provider returned no message`;
  return prose.includes(code) ? prose : `${code}: ${prose}`;
};
// The client uuids a result says its turn consumed (SDK ≥ the `user_message_uuids` echo), or null
// when it names none (a peer or system turn, a zeroed crash result, or an older producer).
function echoedInputs(m: any): string[] | null {
  if (Array.isArray(m.user_message_uuids)) {
    const ids = m.user_message_uuids.filter((id: unknown): id is string => typeof id === 'string');
    if (ids.length) return ids;
  }
  return typeof m.user_message_uuid === 'string' && m.user_message_uuid ? [m.user_message_uuid] : null;
}

/** One accepted input: recorded in the store, then dispatched to the provider. */
interface PmInput { turnId: string; acceptedAt: string; dispatchedAt: number; taken: boolean }

class Inbox {
  delivered = 0;
  private q: SDKUserMessage[] = [];
  private waiters: (() => void)[] = [];
  private generation = 0;
  private onTake: (turnId: string) => void;
  constructor(onTake: (turnId: string) => void = () => {}) { this.onTake = onTake; }
  // The input's turn id is also its SDK uuid, which the CLI echoes on the result that answers it.
  push(text: string, sessionId: string, turnId: string) {
    this.q.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: sessionId, uuid: turnId } as SDKUserMessage);
    this.notify();
  }
  private notify() { const waiters = this.waiters; this.waiters = []; for (const wake of waiters) wake(); }
  // Opening a stream retires every earlier stream at once, so an abandoned provider can never
  // consume input meant for its replacement. Each message handed to the reader is reported taken
  // (the SDK reads eagerly, so "taken" is not "processed").
  open(): AsyncGenerator<SDKUserMessage> {
    const generation = ++this.generation;
    this.notify();
    const inbox = this;
    return (async function* () {
      while (generation === inbox.generation) {
        if (inbox.q.length) {
          const message = inbox.q.shift()!;
          inbox.delivered++;
          if (typeof message.uuid === 'string') inbox.onTake(message.uuid);
          yield message;
          continue;
        }
        await new Promise<void>((r) => inbox.waiters.push(r));
      }
    })();
  }
  // End every open stream: a reader parked on it wakes and its stream completes.
  retire() { this.generation++; this.notify(); }
}

export class ProjectManager extends EventEmitter {
  private inbox: Inbox;
  private q: Query | null = null;
  private queryFactory = query;
  lastError: string | null = null;
  sessionId: string | null = null;
  busy = false;
  tools: string[] = [];
  model: string | undefined;
  private running = false;
  private closed = false;
  // Cancellation is bound to a turn: `dispatched` counts inputs accepted by send(), and an
  // interrupt remembers the count it was raised at, so any later input invalidates it.
  private dispatched = 0;
  private interruptedAt: number | null = null;
  // Set when the still-running provider rejected a turn; the next explicit send restarts it.
  private providerFailed = false;
  // Each start() owns one generation; a retired run must not touch shared state.
  private generation = 0;
  private changingModel = false;
  // A provider launch (or its memory read) that failed while send() was starting it: send()
  // rejects with this cause instead of accepting input no run can read.
  private launchFailure: string | null = null;
  private launched: Promise<void> = Promise.resolve();
  // Per-input tracking (#62), in dispatch order, for the current provider.
  private outstanding: PmInput[] = [];
  private lastFrameAt = 0;
  private conversation: PmEntry[] = [];
  private freshStarts = 0;
  // The assignment epoch this PM is active for, or null while this machine is not the PM host.
  private activeEpoch: number | null = null;
  private shownUncertain = new Set<string>();
  private store: HostPmStore | null = null;
  private bridge: PmAssignmentSource | null = null;
  private autoStart = true;
  private detach: (() => void) | null = null;
  private readonly machineName: string;
  private readonly now: () => number;
  private readonly hungMs: number;
  get modelBusy() { return this.busy || this.outstanding.length > 0 || this.changingModel; }

  private fleet: Fleet;
  private sessions?: ManagedFleetService;
  private projects?: ProjectRegistry;
  constructor(fleet: Fleet, options: ProjectManagerOptions = {}) {
    super();
    this.fleet = fleet; this.sessions = options.sessions; this.projects = options.projects;
    this.machineName = options.machineName ?? HOST;
    this.now = options.now ?? (() => Date.now());
    const envHung = Number(process.env.FOREMAN_PM_HUNG_MS);
    this.hungMs = options.hungMs ?? (Number.isFinite(envHung) && envHung > 0 ? envHung : PM_HUNG_DEFAULT_MS);
    this.inbox = this.newInbox();
  }
  private newInbox() {
    return new Inbox((turnId) => { const input = this.outstanding.find((i) => i.turnId === turnId); if (input) input.taken = true; });
  }

  /** The current conversation (in memory only, ≤ MAX_PM_HISTORY entries). */
  history(): PmEntry[] { return this.conversation.map((entry) => ({ ...entry })); }
  /** Turn ids of inputs dispatched and not yet settled. */
  outstandingTurnIds(): string[] { return this.outstanding.map((input) => input.turnId); }

  // --- Activation ------------------------------------------------------------------------------

  /**
   * Binds the PM to its state store: it runs only while the store reports this machine as the
   * active PM host. Returns an unsubscribe. In relay mode pass the bridge, so a new connection that
   * has not yet received its assignment is not mistaken for a move.
   */
  attach(store: HostPmStore, options: PmAttachOptions = {}): () => void {
    this.detach?.();
    this.store = store; this.bridge = options.bridge ?? null; this.autoStart = options.autoStart ?? true;
    const current = store.assignment();
    if (current.active) this.assignmentChanged(current, store.uncertainTurns());
    const off = store.onAssignment((assignment, uncertain) => this.assignmentChanged(assignment, uncertain));
    this.detach = off;
    return off;
  }

  private assignmentChanged(a: ReturnType<HostPmStore['assignment']>, uncertain: UncertainTurn[]) {
    if (this.closed || !this.store) return;
    if (a.active) {
      if (this.activeEpoch !== a.epoch) this.activate(a.epoch, uncertain);
      else this.reportUncertain(uncertain);
      return;
    }
    if (this.activeEpoch === null) return;
    // Disconnected: the PM keeps running (a turn in flight may finish) and the store refuses new
    // sends until the relay is back. The same holds on a new connection until its assignment arrives.
    if (!a.connected) return;
    if (this.store.mode === 'relay' && this.bridge && this.bridge.currentAssignment() === null) return;
    // An assignment on this connection names another machine, or the relay fenced this one.
    this.deactivate(a.activeHost);
  }

  private activate(epoch: number, uncertain: UncertainTurn[]) {
    // A new epoch while this PM was still active means the relay already reconciled its turns.
    if (this.activeEpoch !== null || this.running) this.retire();
    this.activeEpoch = epoch;
    this.conversation = []; this.freshStarts = 0; this.lastError = null; this.sessionId = null; this.tools = [];
    this.reportUncertain(uncertain);
    if (this.autoStart) void this.start();
  }

  // This machine is no longer the PM host: close the provider. Outstanding inputs are left to the
  // relay's reconciliation (reassigned or host_lost), never reported here as completed.
  private deactivate(activeHost: string | null) {
    this.retire();
    this.activeEpoch = null;
    const other = activeHost && activeHost !== this.machineName ? activeHost : null;
    const text = other ? `The PM now runs on ${other}. This machine no longer runs it; messages sent here are refused.` : 'This machine is no longer the PM host; messages sent here are refused.';
    this.record({ role: 'system', text });
    this.emitEvent({ type: 'status', text });
  }

  // Each uncertain turn is shown once per process (the store re-sends the list on every connection
  // or assignment change), then acknowledged.
  private reportUncertain(turns: UncertainTurn[]) {
    for (const turn of turns) {
      if (this.shownUncertain.has(turn.turn_id)) continue;
      this.shownUncertain.add(turn.turn_id);
      this.reportFailureEntry(uncertainText(turn.accepted_at, turn.host, UNCERTAIN_REASON_TEXT[turn.reason] ?? turn.reason));
    }
    if (turns.length && this.store) {
      this.store.ackUncertain(turns.map((turn) => turn.turn_id)).catch((error) => this.diagnostic('foreman: pm uncertain ack failed', { error: errorText(error) }));
    }
  }

  // --- Model -----------------------------------------------------------------------------------

  async setModel(value: unknown) {
    const model = normalizeModel(value);
    if (this.modelBusy) throw new Error('Wait for the project manager to finish before changing its model');
    if (this.closed) throw this.unavailable(' (closed)');
    const q = this.q, store = this.store;
    if (!q || !this.running || !store) throw this.unavailable();
    this.changingModel = true;
    const previous = this.model;
    try {
      await q.setModel(model);
      try {
        await store.setModel(model ?? null);
        this.model = model;
      } catch (error) {
        // If persistence fails, restore the previous live selection before accepting more messages.
        try { await q.setModel(previous); }
        catch (restoreError) {
          // The live model no longer matches the saved one, so the PM closes. Keep both causes
          // as the PM's error, so this rejection and every later one carries them.
          const reason = `the model change could not be saved (${errorText(error).slice(0, 600)}) and restoring the previous model failed (${errorText(restoreError).slice(0, 600)})`;
          this.fail(reason, 'The project manager was closed so it does not run with an unsaved model; restart Foreman to recover.');
          this.close();
          throw new Error(this.lastError!);
        }
        throw error;
      }
    } finally { this.changingModel = false; }
  }

  // --- Reporting -------------------------------------------------------------------------------

  private record(entry: Omit<PmEntry, 'ts'>) {
    this.conversation.push({ ts: new Date(this.now()).toISOString(), ...entry } as PmEntry);
    if (this.conversation.length > MAX_PM_HISTORY) this.conversation.splice(0, this.conversation.length - MAX_PM_HISTORY);
  }
  private diagnostic(label: string, detail: Record<string, unknown>) {
    const redacted = Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === 'string' ? safe(v, 1500) : v]));
    try { console.error(label, JSON.stringify(redacted)); } catch { /* never let logging fail the PM */ }
  }
  // 'event' listeners must never replace a provider cause or skip lifecycle state: EventEmitter.emit
  // rethrows a listener's exception synchronously. A failure is logged on its own.
  private emitEvent(event: PmEvent) {
    try { this.emit("event", event); }
    catch (error: any) { this.diagnostic('foreman: pm reporting failed', { kind: 'event', detail: event.type, error: String(error?.message ?? error).slice(0, 500) }); }
  }
  // A system entry the developer must see: error entry, current PM error, status event.
  private reportFailureEntry(text: string) {
    this.lastError = text;
    this.record({ role: 'system', text, error: true });
    this.emitEvent({ type: 'status', text });
  }

  // A rejection that carries the PM's current error, so the caller never gets only generic text.
  private unavailable(detail = '') { return new Error(`Project manager is unavailable${detail}${this.lastError ? `: ${this.lastError}` : ''}`); }
  private static failureText(reason: string, next = 'Your message was not completed; after resolving the error, send a new message to retry. Failed messages are not replayed.') {
    return `Project manager failed: ${safe(reason, 1500)}. ${next}`;
  }
  /** Reports a PM failure that is not about one input (e.g. a missing machine identity). */
  failUnavailable(reason: string) { this.fail(reason, 'The project manager cannot run on this machine until this is fixed.'); }
  // `code` is the SDK's typed assistant error code behind the failure (null when there was none);
  // `subtype` is the failed result's subtype when the failure came from a result.
  private fail(reason: string, next?: string, detail: { code?: string | null; subtype?: string | null } = {}) {
    const text = ProjectManager.failureText(reason, next);
    const duplicateRejection = this.inbox.delivered === 0 && this.lastError === text;
    this.lastError = text;
    this.diagnostic('foreman: pm failure', { session_id: this.sessionId, outstanding: this.outstanding.length, code: detail.code ?? null, subtype: detail.subtype ?? null, error: reason.slice(0, 1500) });
    if (!duplicateRejection) {
      this.record({ role: "system", text, error: true });
      this.emitEvent({ type: "status", text });
    }
  }

  // --- Turns -----------------------------------------------------------------------------------

  private endTurn(input: PmInput, outcome: TurnOutcome) {
    this.store?.endTurn(input.turnId, outcome).catch((error) => this.diagnostic('foreman: pm turn end failed', { outcome, error: errorText(error) }));
  }
  private settle(input: PmInput, outcome: TurnOutcome) {
    const at = this.outstanding.indexOf(input);
    if (at >= 0) this.outstanding.splice(at, 1);
    this.endTurn(input, outcome);
  }
  private settleUncertain(input: PmInput, reason: string) {
    this.reportFailureEntry(uncertainText(input.acceptedAt, this.machineName, reason));
    this.settle(input, 'uncertain');
  }
  // A result settles exactly the inputs it names. One that names none is not attributable: during a
  // peer-initiated turn it settles nothing; otherwise the oldest input the provider took becomes
  // uncertain (ambiguity never resolves to completed).
  private settleResult(m: any, outcome: TurnOutcome, peerTurn: boolean) {
    const echoed = echoedInputs(m);
    if (echoed) {
      for (const input of this.outstanding.filter((i) => echoed.includes(i.turnId))) this.settle(input, outcome);
      return;
    }
    if (peerTurn) return;
    const oldest = this.outstanding.find((i) => i.taken);
    if (oldest) this.settleUncertain(oldest, UNMATCHED_REPLY);
  }
  // The provider stopped with inputs still owed: one entry per input. Input the provider took may
  // have been processed (uncertain); input it never read was not delivered (failed).
  private settleOrphans(cause: string) {
    const reason = `the PM stopped: ${safe(cause, 300)}`;
    for (const input of this.outstanding.splice(0)) {
      if (input.taken) { this.reportFailureEntry(uncertainText(input.acceptedAt, this.machineName, reason)); this.endTurn(input, 'uncertain'); }
      else { this.reportFailureEntry(undeliveredText(input.acceptedAt, this.machineName, reason)); this.endTurn(input, 'failed'); }
    }
  }
  private isHung(): boolean {
    const oldest = this.outstanding[0];
    if (!oldest) return false;
    return this.now() - Math.max(this.lastFrameAt, oldest.dispatchedAt) >= this.hungMs;
  }

  // Why new input cannot be accepted right now, or null. Carries the specific cause.
  private sendRejection(): Error | null {
    if (this.changingModel) return new Error('Model change in progress; retry your message');
    if (this.closed) return this.unavailable(' (closed)');
    const store = this.store;
    if (!store) return this.unavailable();
    if (this.activeEpoch === null) {
      const a = store.assignment();
      if (store.mode === 'relay' && !a.connected) return new Error(RELAY_UNREACHABLE_MESSAGE);
      if (!a.active) return new Error(a.activeHost && a.activeHost !== this.machineName ? `The PM runs on ${a.activeHost}.` : 'This machine is not the PM host.');
      return this.unavailable(' (starting)');
    }
    return null;
  }
  // #115: the PM moved while a send was in progress. The input was not dispatched anywhere.
  private movedError(): Error {
    const host = this.store?.assignment().activeHost;
    const other = host && host !== this.machineName ? host : null;
    return new Error(other
      ? `The PM was moved to ${other} while your message was being sent. It was not delivered; send it again there.`
      : 'The PM was moved while your message was being sent. It was not delivered; send it again.');
  }
  // #62: a provider that owes input and has been silent past the threshold is retired, by an
  // explicit send only; each input it owed is reported once as uncertain. A provider that rejected
  // a turn but stayed alive is restarted once it has settled every input it accepted, so only new
  // input reaches the new process. Starts a provider if none runs; true when it started one.
  private readyProvider(): boolean {
    if (this.running && this.isHung()) {
      for (const owed of [...this.outstanding]) this.settleUncertain(owed, UNCERTAIN_REASON_TEXT.hung);
      this.retire();
    }
    if (this.running && this.providerFailed && !this.outstanding.length && !this.busy) this.retire();
    if (this.running) return false;
    void this.start();
    return true;
  }

  /**
   * Accepts one input. Resolves only after the store durably recorded its turn and the input was
   * dispatched; rejects (with the cause, nothing dispatched) otherwise.
   */
  async send(text: string): Promise<void> {
    const early = this.sendRejection();
    if (early) throw early;
    const store = this.store!;
    // #115: the epoch this send is for. A move (even A→B→A) while it is being recorded or launched
    // means it is not dispatched: the relay has already reconciled any turn recorded for it.
    const epoch = this.activeEpoch;
    // The provider is readied before the turn is recorded, so on this path no await separates the
    // record's ack from dispatch and a move cannot land between them on this host. (Only while the
    // store is usable: otherwise beginTurn below rejects with the store's own cause.)
    if (store.assignment().active) {
      this.readyProvider();
      await this.launched;
      if (this.activeEpoch !== epoch) throw this.movedError();
      const unready = this.sendRejection() ?? (this.launchFailure !== null ? new Error(ProjectManager.failureText(this.launchFailure)) : null);
      if (unready) throw unready;
    }
    const input: PmInput = { turnId: randomUUID(), acceptedAt: new Date(this.now()).toISOString(), dispatchedAt: 0, taken: false };
    try { await store.beginTurn(input.turnId, input.acceptedAt); }
    catch (error) {
      if (this.activeEpoch !== epoch) throw this.movedError();
      if (error instanceof PmStoreError && error.code === 'disconnected') throw new Error(RELAY_UNREACHABLE_MESSAGE);
      if (error instanceof PmStoreError && error.code === 'not_active') throw new Error(safe(error.message, 300));
      throw new Error(`The PM could not record your message, so it was not sent: ${safe(errorText(error), 600)}`);
    }
    // Best-effort and fenced by the store: after a move the relay already marked this turn, so the
    // end changes nothing there (a stale epoch is refused; turn.end removes only an open record).
    const abandon = (error: Error) => { this.endTurn(input, 'failed'); return error; };
    if (this.activeEpoch !== epoch) throw abandon(this.movedError());
    const late = this.sendRejection();
    if (late) throw abandon(late);
    // Normally already running (readied above); started here only if it stopped meanwhile.
    if (this.readyProvider()) {
      await this.launched;
      if (this.activeEpoch !== epoch) throw abandon(this.movedError());
    }
    const afterLaunch = this.sendRejection();
    if (afterLaunch) throw abandon(afterLaunch);
    if (this.launchFailure !== null) throw abandon(new Error(ProjectManager.failureText(this.launchFailure)));
    if (!this.running) throw abandon(this.unavailable());
    input.dispatchedAt = this.now();
    this.outstanding.push(input);
    this.dispatched++;
    this.record({ role: "user", text });
    this.inbox.push(text, this.sessionId ?? "", input.turnId);
  }
  async interrupt() {
    if (!this.q || !this.modelBusy) return;
    const token = this.dispatched;
    this.interruptedAt = token;
    try { await this.q.interrupt(); } catch (error) { if (this.interruptedAt === token) this.interruptedAt = null; throw error; }
  }
  // Detach the current run: close its provider and reset per-run state. Its start() keeps
  // unwinding in the background but no longer owns any PM state. Inputs still tracked are dropped
  // without an outcome here: callers settle them first, or leave them to the store's reconciliation.
  private retire() {
    const q = this.q;
    this.generation++;
    this.q = null; this.running = false; this.busy = false; this.outstanding = [];
    this.interruptedAt = null; this.providerFailed = false;
    this.inbox.retire(); this.inbox = this.newInbox(); // release the old provider's parked input reader
    try { q?.close(); } catch (error) { this.diagnostic('foreman: pm provider close failed', { error: errorText(error) }); }
  }
  /** Permanent (daemon shutdown). Open turns stay open in the store, which reconciles them. */
  close() { this.closed = true; this.detach?.(); this.detach = null; const q = this.q; this.q = null; try { q?.close(); } catch { /* closing */ } }

  private memoryBlock(memory: { projects: Doc; preferences: Doc; log: LogEntry[] }): string {
    const doc = (d: Doc) => d.content.trim() || '(empty)';
    const log = memory.log.slice(-40).map((e) => `- ${e.at} ${e.text}`).join('\n') || '(empty)';
    return `\n\n# Memory (portable PM memory, read from the PM state store at the start of this session)\n\n## projects (version ${memory.projects.version})\n${doc(memory.projects)}\n\n## preferences (version ${memory.preferences.version})\n${doc(memory.preferences)}\n\n## log (newest ${Math.min(40, memory.log.length)} entries)\n${log}\n`;
  }

  private canUseTool = async (name: string, input: Record<string, any>) => {
    const allow = () => ({ behavior: "allow" as const, updatedInput: input });
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const delegate = "Denied: the project manager does not touch code. Brief a session agent with spawn_session instead.";
    // A model may propose a preset, but only the developer approves an elevated
    // launch. Do not auto-allow this via the broad fleet-tool rule below.
    if (name === 'mcp__fleet__spawn_session' && ['bypass', 'bypassPermissions'].includes(input.permission_mode))
      return deny('Bypass must be launched by the developer in the New session dialog. Propose the settings in your reply; you cannot grant an elevated policy.');
    if (name.startsWith("mcp__fleet__") || PEER_ALLOWED_TOOLS.includes(name) || ["ListAgents", "SendMessage", "WebFetch", "WebSearch", "TodoWrite", "TaskCreate", "TaskList", "TaskUpdate", "TaskGet"].includes(name)) return allow();
    if (name === "Read") {
      const p = expand(String(input.file_path ?? ""));
      if (!p) return deny("Read needs a file_path.");
      try {
        const actual = canonical(p);
        if (!statSync(actual).isFile()) return deny('Read requires an existing document file.');
        if (under(actual, canonical(FOREMAN_HOME))) return deny('Use session tools for session history and the memory tools for PM memory. Foreman configuration and credentials are unavailable to the PM.');
        if (DOC_FILE.test(basename(actual))) return allow();
      } catch { return deny('Read requires an existing document file.'); }
      return deny(`${delegate} (Read is limited to document files.)`);
    }
    if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit")
      return deny(`${delegate} (The PM writes nothing on disk; use memory_write, memory_edit and log_note for PM memory.)`);
    if (["Bash", "Glob", "Grep"].includes(name)) return deny(`${delegate} (Use the fleet and peer tools to inspect sessions, and Read for a specific document.)`);
    if (name === "Agent") return deny("Denied: no subagents for the PM; spawn a tracked session with spawn_session so the user can see it.");
    return deny(`Denied: ${name} is not available to the project manager.`);
  };

  // Permission callbacks alone can be bypassed by provider defaults or user allow rules.
  // Enforce the PM role before every tool invocation, including auto-approved reads.
  private enforceToolBoundary: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decision = await this.canUseTool(input.tool_name, (input.tool_input ?? {}) as Record<string, any>);
    return decision.behavior === 'deny'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.message } }
      : {};
  };

  /** Starts a fresh provider session (never a resume) while this machine is the active PM host. Resolves when that run ends. */
  async start(): Promise<void> {
    if (this.running || this.closed || this.activeEpoch === null || !this.store) return;
    const store = this.store;
    this.running = true;
    this.providerFailed = false;
    this.launchFailure = null;
    this.lastFrameAt = 0;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const inbox = this.inbox;
    let launched!: () => void;
    this.launched = new Promise<void>((resolve) => { launched = resolve; });
    let q: Query | null = null;
    // The SDK's error echo of a failed result this run already reported, while that result is
    // still the latest frame: the CLI exiting on it must not report it twice.
    let reported: string | undefined;
    // The latest turn failure this start() reported, until a later turn succeeds. A process error
    // or stream end after it is reported together with it, so it never replaces that cause.
    let turnFailure: string | undefined;
    const run = async () => {
      // Memory is read at every fresh start; the one-time import must have settled first.
      let memory: Awaited<ReturnType<HostPmStore['read']>>;
      try {
        await store.ensureImported();
        memory = await store.read();
      } catch (error) {
        if (current()) this.launchFailure = `PM memory could not be read, so the PM did not start: ${errorText(error)}`;
        throw new Error(`PM memory could not be read, so the PM did not start: ${errorText(error)}`);
      }
      if (!current()) return;
      let provider: Query;
      try {
        this.model = normalizeModel(memory.model ?? process.env.FOREMAN_PM_MODEL);
        const base = readFileSync(join(REPO_ROOT, "agents", "pm-system-prompt.md"), "utf8");
        provider = q = this.q = this.queryFactory({
          prompt: inbox.open(),
          options: {
            cwd: FOREMAN_HOME,
            systemPrompt: { type: "preset", preset: "claude_code", append: base + '\nUse list_projects and resolve_project for project references; ask when ambiguous or missing. When the developer gives a name or alias for their current known project, register_project records it. Never invent directories.' + this.memoryBlock(memory) + (this.sessions ? '\n\n' + PEER_INSTRUCTIONS + '\nFor Foreman-managed sessions, use peer tools to request updates and read outcomes. Native SendMessage subscriptions apply only to legacy Claude background sessions. You still must not read or edit source code or bypass your PM tool restrictions.' : '') },
            settingSources: ["user"],
            permissionMode: "default",
            canUseTool: this.canUseTool,
            hooks: { PreToolUse: [{ hooks: [this.enforceToolBoundary] }] },
            includePartialMessages: true,
            mcpServers: { fleet: makeFleetServer(this.fleet, this.sessions, this.projects, store), ...(this.sessions ? { peers: makePeerMcpServer(this.sessions, 'foreman-pm') } : {}) },
            allowedTools: ["mcp__fleet__list_projects", "mcp__fleet__resolve_project", "mcp__fleet__register_project", "mcp__fleet__list_sessions", "mcp__fleet__list_models", "mcp__fleet__session_tail", ...PM_MEMORY_TOOLS, "ListAgents", "WebFetch", "WebSearch", ...(this.sessions ? PEER_ALLOWED_TOOLS : [])],
            disallowedTools: ["Agent", "Bash", "Glob", "Grep"],
            extraArgs: { name: "foreman-pm" },
            maxTurns: 60,
            effort: (process.env.FOREMAN_PM_EFFORT as any) || "medium",
            ...(this.model ? { model: this.model } : {}),
            stderr: (chunk: string) => { if (current() && /error|warn/i.test(chunk)) this.emitEvent({ type: "status", text: safe(chunk.trim(), 300) }); },
          },
        });
      } catch (error) {
        // Still before this start's `launched` resolved: the send that started it rejects with it.
        if (current()) this.launchFailure = errorText(error);
        throw error;
      }
      if (this.freshStarts++ > 0 && this.conversation.length) this.record({ role: 'system', text: FRESH_SESSION_NOTICE });
      launched();
      let text = "", completeText = "", turnError = "", turnErrorCode: string | null = null;
      // A peer message starts a turn send() never dispatched; its result names none of our inputs.
      let peerTurn = false;
      for await (const m of provider as any) {
        if (!current()) break; // retired by an explicit send; the replacement owns all state now
        this.lastFrameAt = this.now();
        reported = undefined;
        if (m.type === "system" && m.subtype === "init") {
          this.sessionId = m.session_id;
          this.tools = m.tools ?? [];
          this.emitEvent({ type: "status", text: `PM session ${String(m.session_id).slice(0, 8)} ready (${this.tools.length} tools${this.tools.includes("SendMessage") ? ", cross-session messaging on" : ""})` });
        } else if (m.type === "stream_event") {
          const ev = m.event;
          if (ev?.type === "message_start") { if (!this.busy) { this.busy = true; this.emitEvent({ type: "turn_start", ts: new Date(this.now()).toISOString() }); } }
          if (ev?.type === "content_block_start" && ev.content_block?.type === "text" && text && !text.endsWith("\n")) { text += "\n\n"; this.emitEvent({ type: "delta", text: "\n\n" }); }
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") { text += ev.delta.text; this.emitEvent({ type: "delta", text: ev.delta.text }); }
        } else if (m.type === "assistant") {
          const content = (m.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
          if (m.error || m.isApiErrorMessage) {
            // The typed code stays with the prose of the same message (the latest error wins).
            turnErrorCode = assistantErrorCode(m.error);
            turnError = codedDiagnostic(turnErrorCode, content);
          } else if (content) completeText += (completeText ? '\n\n' : '') + content;
          for (const b of m.message?.content ?? []) {
            if (b.type === "tool_use") {
              const summary = safe(b.name === "mcp__fleet__spawn_session" ? `${b.input?.name} in ${b.input?.cwd}` : b.name === "SendMessage" ? `→ ${b.input?.to}${b.input?.notify_when_idle ? " (notify when idle)" : ""}` : JSON.stringify(b.input ?? {}), 160);
              this.emitEvent({ type: "tool", name: b.name.replace(/^mcp__fleet__/, "fleet."), summary });
              this.record({ role: "tool", name: b.name, summary });
            }
          }
        } else if (m.type === "user") {
          const c = m.message?.content;
          const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
          if (/Cross-session (idle notice|message)|<cross-session-message/i.test(txt.slice(0, 200))) {
            // A peer message starts a turn send() never dispatched: no pending Stop applies to it.
            this.interruptedAt = null;
            peerTurn = true;
            this.record({ role: "peer", text: txt.slice(0, 600) });
            this.emitEvent({ type: "peer", text: txt.slice(0, 600) });
          }
        } else if (m.type === "result") {
          // Fail closed: an SDK abort reason is authoritative; otherwise cancellation is inferred
          // only for a result with no terminal_reason, after an interrupt raised against the turn
          // in flight with no newer input since. Any other terminal_reason is never a Stop.
          const reason: TerminalReason | undefined = m.terminal_reason;
          const cancelled = isAbortReason(reason) || (reason == null && this.interruptedAt !== null && this.interruptedAt === this.dispatched);
          const failed = !!m.is_error && !cancelled;
          text = text.trim() ? text : completeText || (!failed && !cancelled && typeof m.result === 'string' ? m.result : '');
          // A partial answer must precede its terminal explanation.
          if (text.trim()) this.record({ role: "assistant", text });
          if (failed) {
            this.providerFailed = true;
            const failure = turnError || (m.errors ?? []).join('; ') || m.result || `Provider returned ${m.subtype || 'an error'} without a diagnostic`;
            this.fail(failure, undefined, { code: turnError ? turnErrorCode : null, subtype: typeof m.subtype === 'string' ? m.subtype : null });
            turnFailure = failure;
            // Suppress the SDK's exit echo only when its diagnostic is already fully in what was
            // recorded (fail() keeps the first 1500 chars). Otherwise the echo is the only carrier
            // of this result's own diagnostic, so it must surface as its own failure entry.
            const echoed = resultDiagnostic(m);
            if (echoed && failure.slice(0, 1500).includes(echoed)) reported = sdkErrorResultEcho(echoed);
          } else {
            turnFailure = undefined;
            this.providerFailed = false;
            this.lastError = null;
            if (cancelled) {
              const message = 'Project manager stopped at your request. Message was not replayed.';
              this.record({ role: 'system', text: message });
              this.emitEvent({ type: 'status', text: message });
            }
          }
          this.interruptedAt = null; // an interrupt is spent by the first result after it
          this.settleResult(m, failed ? 'failed' : cancelled ? 'cancelled' : 'completed', peerTurn);
          peerTurn = false;
          this.busy = false;
          this.emitEvent({ type: "assistant_text", text });
          this.emitEvent({ type: "turn_end", ts: new Date(this.now()).toISOString(), cost_usd: m.total_cost_usd ?? 0, is_error: failed, subtype: m.subtype });
          text = ""; completeText = ""; turnError = ""; turnErrorCode = null;
        }
      }
      if (current() && !this.closed && (!this.lastError || this.outstanding.length)) throw new Error('Provider stream ended unexpectedly');
    };
    try {
      await run();
    } catch (error: any) {
      // The SDK's exit error that only echoes the failed result already reported is not a
      // second failure of the same run.
      const message = errorText(error);
      const echo = reported !== undefined && message === reported;
      // A process error or stream end after a reported turn failure keeps that failure as cause.
      const cause = turnFailure && !message.includes(turnFailure) ? ` (after the provider failure: ${turnFailure.slice(0, 700)})` : '';
      if (current() && !this.closed) {
        // Every input the provider still owed gets its own entry before the run's failure.
        this.settleOrphans(message);
        if (!echo) this.fail(cause ? message.slice(0, 800) + cause : message);
      }
    } finally {
      launched();
      // Reset lifecycle state before closing, so nothing close() throws can skip it.
      const owned = current() ? this.q : (q as Query | null);
      if (current()) { this.q = null; this.running = false; this.busy = false; this.outstanding = []; this.interruptedAt = null; this.providerFailed = false; this.inbox.retire(); this.inbox = this.newInbox(); }
      try { owned?.close(); }
      catch (error: any) { this.diagnostic('foreman: pm provider close failed', { error: String(error?.message ?? error) }); }
    }
  }
}
