// Host notifier: turns SessionService and ProjectManager state into edge-triggered `notify`
// frames (shared/notify.ts contract A) for the cloud relay. It only reads what those services
// already expose (`session` / `event` emissions, `detail()`, `list()`, `lastError`) and never
// changes their behaviour.
//
// Edges, all de-duplicated by state rather than timers:
// - approval_requested / question_asked: once per approval id that is newly pending on a managed
//   (Foreman-owned) session. kind 'question' -> question_asked; 'permission' and 'unsupported' ->
//   approval_requested. Ids already pending when the notifier starts never fire, and an id
//   re-observed on later changes never fires again. Observed (unmanaged) sessions never fire.
// - session_failed: a managed session entering SessionService's unavailable state
//   (state 'unknown' - its provider process ended or failed, Codex disconnected or its thread
//   closed, the provider could not start, or delivery became uncertain) from any other state.
//   A managed session never leaves that state, so this fires at most once per session.
//   Deliberately excluded: a single failed turn on a session that stays usable (the public
//   surface cannot tell a failed Claude turn from a user interrupt - both are a failed receipt
//   with no reason), user interrupts, normal completion ('turn_finished'), sessions already
//   unavailable when the notifier starts (e.g. restored after a Foreman restart), and Foreman's
//   own shutdown (the notifier is closed before SessionService.close()).
// - pm_failed: `ProjectManager.lastError` going from null to non-null (the PM failure the web
//   UI surfaces, #28/#42). It fires once per edge; a further failure while still failed does not
//   fire again, and only a successful turn (which clears lastError) re-arms it.
//
// Frames carry only kind, host, session key, cleaned session name, id and timestamp: never
// approval input, tool names, message text, paths or errors.
import type { EventEmitter } from 'node:events';
import { cleanDisplayName, notifyId, parseNotifyFrame, type NotifyFrame, type NotifyKind } from '../shared/notify.ts';
import { HOST } from './paths.ts';

interface ApprovalLike { id: string; kind: string }
interface SessionLike { session_key: string; name?: string | null; state?: string | null; managed?: boolean }
export interface NotifierSessions extends Pick<EventEmitter, 'on' | 'off'> {
  list(): SessionLike[];
  detail(id: string): { session: SessionLike; approvals: ApprovalLike[] };
}
export interface NotifierPm extends Pick<EventEmitter, 'on' | 'off'> { lastError: string | null }
export interface NotifierOptions {
  sessions: NotifierSessions;
  pm?: NotifierPm;
  send: (frame: NotifyFrame) => void;
  host?: string;
}

const MAX_SEEN_PER_SESSION = 1000;
const FAILED_STATE = 'unknown';

export class Notifier {
  private options: NotifierOptions;
  private host: string;
  private seen = new Map<string, Set<string>>();
  private failed = new Map<string, boolean>();
  private pmFailed = false;
  private started = false;
  private closed = false;
  private onSession = (event: unknown) => this.guard('session', () => {
    const id = (event as { id?: unknown } | null)?.id;
    if (typeof id === 'string') this.observeSession(id);
  });
  private onPm = () => this.guard('pm', () => this.observePm());

  constructor(options: NotifierOptions) {
    this.options = options;
    this.host = options.host ?? HOST;
  }

  // Record the current state as the baseline (nothing already pending or failed fires), then
  // subscribe.
  start(): this {
    if (this.started || this.closed) return this;
    this.started = true;
    this.guard('baseline', () => {
      for (const row of this.options.sessions.list()) {
        if (!row.managed) continue;
        this.failed.set(row.session_key, row.state === FAILED_STATE);
        try { this.seen.set(row.session_key, new Set(this.options.sessions.detail(row.session_key).approvals.map((a) => String(a.id)))); } catch {}
      }
      this.pmFailed = this.options.pm?.lastError != null;
    });
    this.options.sessions.on('session', this.onSession);
    this.options.pm?.on('event', this.onPm);
    return this;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.options.sessions.off('session', this.onSession);
    this.options.pm?.off('event', this.onPm);
  }

  // EventEmitter rethrows listener exceptions into the emitter's caller: never let one escape.
  private guard(where: string, action: () => void) {
    if (this.closed && where !== 'baseline') return;
    try { action(); }
    catch { try { console.error('foreman: notifier failed', JSON.stringify({ where })); } catch {} }
  }

  private observeSession(key: string) {
    let detail: ReturnType<NotifierSessions['detail']>;
    try { detail = this.options.sessions.detail(key); } catch { return; }
    const row = detail.session;
    if (!row || row.managed !== true || row.session_key !== key) return;
    const name = typeof row.name === 'string' ? cleanDisplayName(row.name) : '';

    let seen = this.seen.get(key);
    if (!seen) this.seen.set(key, seen = new Set());
    for (const approval of detail.approvals ?? []) {
      const approvalId = String(approval.id);
      if (seen.has(approvalId)) continue;
      seen.add(approvalId);
      if (seen.size > MAX_SEEN_PER_SESSION) seen.delete(seen.values().next().value!);
      this.emit(approval.kind === 'question' ? 'question_asked' : 'approval_requested', [key, approvalId], key, name);
    }

    const failed = row.state === FAILED_STATE;
    const wasFailed = this.failed.get(key) ?? false;
    this.failed.set(key, failed);
    if (failed && !wasFailed) {
      // Unavailable is terminal for a managed session: nothing more can become pending on it.
      this.seen.delete(key);
      this.emit('session_failed', [key, 'unavailable'], key, name);
    }
  }

  private observePm() {
    const failed = this.options.pm?.lastError != null;
    const was = this.pmFailed;
    this.pmFailed = failed;
    if (!failed || was) return;
    // Each failure edge is a distinct notification, so its id carries the edge's timestamp.
    const at = new Date().toISOString();
    this.emit('pm_failed', [this.host, at], undefined, undefined, at);
  }

  private emit(kind: NotifyKind, parts: string[], key?: string, name?: string, at = new Date().toISOString()) {
    const frame: NotifyFrame = { type: 'notify', id: notifyId(kind, ...parts), kind, host: this.host, at };
    if (key !== undefined) frame.session_key = key;
    if (name) frame.session_name = name;
    const valid = parseNotifyFrame(frame);
    if (!valid) { console.error('foreman: notifier built an invalid frame', JSON.stringify({ kind })); return; }
    try { this.options.send(valid); }
    catch { console.error('foreman: notify delivery failed', JSON.stringify({ kind })); }
  }
}
