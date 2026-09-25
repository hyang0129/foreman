// Host notifier: turns SessionService and ProjectManager state into edge-triggered `notify`
// frames (shared/notify.ts contract A) for the cloud relay. It only reads what those services
// already expose (`session` / `change` / `event` emissions, `approvals()`, `list()`, `lastError`)
// and never changes their behaviour.
//
// Reads are cheap: SessionService.changed() emits `session` ({ id }) and then `change` with the
// full row list it has just built. The notifier marks the id dirty on `session` and, on `change`,
// takes each dirty session's row from that list and its pending approvals from `approvals(id)`,
// so it never copies history or receipts (`detail()`).
//
// Edges, all de-duplicated by state rather than timers:
// - approval_requested / question_asked: once per approval id that is newly pending on a managed
//   (Foreman-owned) session. kind 'question' -> question_asked; 'permission' and 'unsupported' ->
//   approval_requested. Ids already pending when the notifier starts never fire, and an id
//   re-observed on later changes never fires again. Observed (unmanaged) sessions never fire.
//   The per-session memory is exactly the set of ids pending at the last observation: an id is
//   forgotten only once it is no longer pending, so memory is bounded by what the provider holds
//   and a still-pending id is never evicted (and re-notified).
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
  approvals(id: string): ApprovalLike[];
}
export interface NotifierPm extends Pick<EventEmitter, 'on' | 'off'> { lastError: string | null }
export interface NotifierOptions {
  sessions: NotifierSessions;
  pm?: NotifierPm;
  send: (frame: NotifyFrame) => void;
  host?: string;
}

const FAILED_STATE = 'unknown';

export class Notifier {
  private options: NotifierOptions;
  private host: string;
  private seen = new Map<string, Set<string>>();
  private failed = new Map<string, boolean>();
  private pmFailed = false;
  private started = false;
  private closed = false;
  private dirty = new Set<string>();
  private onSession = (event: unknown) => this.guard('session', () => {
    const id = (event as { id?: unknown } | null)?.id;
    if (typeof id === 'string') this.dirty.add(id);
  });
  private onChange = (rows: unknown) => this.guard('change', () => {
    if (!this.dirty.size) return;
    const keys = [...this.dirty]; this.dirty.clear();
    const list = Array.isArray(rows) ? rows as SessionLike[] : this.options.sessions.list();
    const byKey = new Map(list.filter((row) => row && typeof row.session_key === 'string').map((row) => [row.session_key, row]));
    for (const key of keys) this.guard('session', () => this.observeSession(key, byKey.get(key)));
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
        try { this.seen.set(row.session_key, new Set(this.options.sessions.approvals(row.session_key).map((a) => String(a.id)))); } catch {}
      }
      this.pmFailed = this.options.pm?.lastError != null;
    });
    this.options.sessions.on('session', this.onSession);
    this.options.sessions.on('change', this.onChange);
    this.options.pm?.on('event', this.onPm);
    return this;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.options.sessions.off('session', this.onSession);
    this.options.sessions.off('change', this.onChange);
    this.dirty.clear();
    this.options.pm?.off('event', this.onPm);
  }

  // EventEmitter rethrows listener exceptions into the emitter's caller: never let one escape.
  private guard(where: string, action: () => void) {
    if (this.closed && where !== 'baseline') return;
    try { action(); }
    catch { try { console.error('foreman: notifier failed', JSON.stringify({ where })); } catch {} }
  }

  private observeSession(key: string, row: SessionLike | undefined) {
    if (!row || row.managed !== true || row.session_key !== key) return;
    const name = typeof row.name === 'string' ? cleanDisplayName(row.name) : '';
    // A failed read skips only the approval edges (the memory is kept); the failure edge below
    // still runs from the row.
    let approvals: ApprovalLike[] | null = null;
    try { approvals = this.options.sessions.approvals(key) ?? []; }
    catch { try { console.error('foreman: notifier failed', JSON.stringify({ where: 'approvals' })); } catch {} }
    if (approvals) this.observeApprovals(key, name, approvals);

    const failed = row.state === FAILED_STATE;
    const wasFailed = this.failed.get(key) ?? false;
    this.failed.set(key, failed);
    if (failed && !wasFailed) {
      // Unavailable is terminal for a managed session: nothing more can become pending on it.
      this.seen.delete(key);
      this.emit('session_failed', [key, 'unavailable'], key, name);
    }
  }

  // Remember exactly the ids pending now: ids no longer pending are forgotten, still-pending ids
  // are kept however many there are.
  private observeApprovals(key: string, name: string, approvals: ApprovalLike[]) {
    const seen = this.seen.get(key) ?? new Set<string>();
    const pending = new Set<string>();
    const fresh: ApprovalLike[] = [];
    for (const approval of approvals) {
      const approvalId = String(approval.id);
      if (pending.has(approvalId)) continue;
      pending.add(approvalId);
      if (!seen.has(approvalId)) fresh.push(approval);
    }
    this.seen.set(key, pending);
    for (const approval of fresh) {
      this.emit(approval.kind === 'question' ? 'question_asked' : 'approval_requested', [key, String(approval.id)], key, name);
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
