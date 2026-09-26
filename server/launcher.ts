// What remains of the session launcher (epic #157, D7). The propose-a-session flow and its
// `/api/launch*` routes were removed: the Coordinator starts Leads, and the New session dialog
// keeps only the manual form. The native session identities the launcher reserved for its own
// proposal queries are still read from `launcher-sessions.json`, so those old native rows stay
// hidden from the fleet (they are neither user sessions nor projects). It also relays agent launch
// decisions to the Lead that asked (below).
import { readFileSync } from 'node:fs';
import { retireSupersededOnApproval } from './lead-tools.ts';
import { redactSecrets } from '../shared/redact.ts';
import { isLeadKey, normalizeLeadKey, type AgentSessionService } from '../shared/roles.ts';
import type { LaunchDecisionEvent, Source } from './session-service.ts';

export class Launcher {
  private nativeIds = new Set<string>();
  constructor(options: { identityFile?: string } = {}) {
    if (!options.identityFile) return;
    try {
      const ids = JSON.parse(readFileSync(options.identityFile, 'utf8'));
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))) throw new Error('Invalid launcher session identities');
      this.nativeIds = new Set(ids);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  /** True for a native Claude session the old launcher started for a proposal (hidden from the fleet). */
  ownsSession(session: { provider: string; session_id: string }): boolean { return session.provider === 'claude' && this.nativeIds.has(session.session_id); }
}

// --- Agent launch decisions (epic #157) ----------------------------------------------------------
// SessionService emits `launch_decision` when a held Bypass launch is decided (CL-04). A Lead that
// requested the launch is told in its own session, once per decision: the message id is unique to
// the approval and the decision, and a failed delivery is logged, never retried or replayed. Every
// decision also goes to `retireSupersededOnApproval` (CL-05), which retires the predecessor of an
// approved Lead and does nothing otherwise.


/** The sender of Foreman's own messages into a session (not a peer; no chain). */
export const FOREMAN_SENDER: Source = { sender: 'foreman', chain: [] };

export function launchDecisionText(event: LaunchDecisionEvent): string {
  const what = `the Bypass launch of your ${event.role} ${event.name} (${event.session_key})`;
  switch (event.decision) {
    case 'approved': return `Foreman: the developer approved ${what}. It is starting with Bypass.`;
    case 'denied': return `Foreman: the developer denied ${what}. Nothing ran. Do not request it again with Bypass unless the developer asks; continue with Auto or ask the developer.`;
    case 'expired': return `Foreman: ${what} expired because Foreman restarted while it waited for approval. Nothing was launched.`;
    default: return `Foreman: ${what} was retired while it waited for approval. Nothing ran.`;
  }
}
export const launchDecisionMessageId = (event: LaunchDecisionEvent) => `foreman-launch:${event.approval_id}:${event.decision}`;

type DecisionSessions = AgentSessionService & { send(id: string, text: string, messageId: string, source: Source): unknown };
const errorText = (error: unknown) => redactSecrets(String((error as any)?.message ?? error)).slice(0, 300);

/** Handles one `launch_decision` event. Resolves once the supersede check is done; never rejects. */
export async function relayLaunchDecision(sessions: DecisionSessions, event: LaunchDecisionEvent, log: (...args: unknown[]) => void = console.error): Promise<void> {
  if (isLeadKey(event.requested_by)) {
    const lead = normalizeLeadKey(event.requested_by);
    try { sessions.send(lead, launchDecisionText(event), launchDecisionMessageId(event), FOREMAN_SENDER); }
    catch (error) { log('foreman: could not tell the Lead about a launch decision:', JSON.stringify({ lead, decision: event.decision, session: event.session_key, error: errorText(error) })); }
  }
  try {
    const outcome = await retireSupersededOnApproval(sessions, event);
    if (outcome.retired === false || outcome.error) log('foreman: superseded Lead not retired on approval:', JSON.stringify(outcome));
  } catch (error) { log('foreman: retire on approval failed:', errorText(error)); }
}
