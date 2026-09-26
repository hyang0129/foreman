const POLICY_LABEL = { native: 'Native', bypass: '⚠ Bypass · no permission prompts', auto: 'Auto · Claude decides routine permissions' };
const POLICY_DESCRIPTION = {
  native: 'Use the provider’s normal permissions and approval prompts. Claude and Codex have different native boundaries. Foreman adds no credential deny list.',
  bypass: '⚠ Commands, network, credentials, and files outside the project without permission prompts. Foreman adds no sandbox or credential protection.',
};
// Coordinator and Project Lead contracts (epic #157). Plain-JS mirror of shared/roles.ts; web/ is
// static and cannot import it. `/api/pm/*`, `?view=pm` and the `foreman-pm` session name keep the
// old wire names (D8): only what the developer reads says "Coordinator".
const LAUNCH_APPROVAL_TOOL = "foreman.launch_bypass";
const HELD_LAUNCH_REASON = "awaiting_bypass_approval";
const LAUNCH_DENIED = "Bypass launch denied by developer; nothing ran";
const LAUNCH_EXPIRED = "Launch approval expired; nothing was launched";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const ROLE_DEFAULTS = { coordinator: { model: "opus[1m]", effort: "medium" }, lead: { model: "opus[1m]", effort: "medium" }, investigator: { model: "opus", effort: "low" } };
const DEFAULT_BYPASS_GRANTS = [{ role: "coordinator", project: "*", allow: true }, { role: "lead", project: "*", allow: true }];
const PM_SESSION_NAME = "foreman-pm";
const roleOf = (s) => (["session", "lead", "worker"].includes(s?.role) ? s.role : "session");
const launchedBy = (s) => (typeof s?.launched_by === "string" && s.launched_by ? s.launched_by : "developer");
const agentLaunched = (s) => launchedBy(s) !== "developer";
const sameKey = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
// `standing:<role>/<project|*>` or `approved:<approval id>`.
function grantLabel(ref) {
  if (typeof ref !== "string") return "";
  if (ref.startsWith("approved:")) return "approved";
  return ref.startsWith("standing:") ? "standing" : "";
}
function grantDescription(ref) {
  if (typeof ref !== "string") return "";
  if (ref.startsWith("approved:")) return "you approved this launch";
  const m = /^standing:(coordinator|lead)\/(.+)$/.exec(ref);
  if (!m) return "";
  return `standing grant for ${m[1] === "coordinator" ? "the Coordinator" : "Leads"}${m[2] === "*" ? " on every project" : ` on ${m[2]}`}`;
}
// The short policy tag for a chat row: agent-launched sessions only (⚠ Bypass or Auto).
function policyTag(s) {
  if (!agentLaunched(s)) return "";
  if (s.permission_mode === "bypass") { const grant = grantLabel(s.bypass_grant); return grant ? `⚠ Bypass · ${grant}` : "⚠ Bypass"; }
  if (s.permission_mode === "auto") return "Auto";
  return "";
}
const policyLabel = (session) => {
  const label = POLICY_LABEL[session.permission_mode] || (session.permission_mode ? `Legacy policy: ${session.permission_mode}` : session.reason === HELD_LAUNCH_REASON ? "Waiting for your Bypass approval" : 'Policy unknown');
  const grant = session.permission_mode === "bypass" ? grantDescription(session.bypass_grant) : "";
  return grant ? `${label} · ${grant}` : label;
};
// A held Bypass launch that never ran: denied, or expired by a restart.
function launchOutcome(s) {
  const reason = String(s?.end_reason || "");
  if (reason === LAUNCH_DENIED || /^Bypass launch denied/i.test(reason)) return "Bypass launch denied; nothing ran.";
  if (reason === LAUNCH_EXPIRED || /^Launch approval expired/i.test(reason)) return "Launch approval expired; nothing was launched.";
  return "";
}
// Authoritative JSON polling keeps authentication tokens out of URLs and reconnects simple.
// Firebase browser-module setup: https://firebase.google.com/docs/web/alt-setup
const $ = (selector) => document.querySelector(selector);
const ui = {
  app: $("#app"),
  authScreen: $("#auth-screen"),
  authStatus: $("#auth-status"),
  signIn: $("#sign-in"),
  signOut: $("#sign-out"),
  list: $("#session-list"),
  search: $("#search"),
  title: $("#conversation-title"),
  subtitle: $("#conversation-subtitle"),
  provider: $("#provider"),
  timeline: $("#timeline"),
  messages: $("#messages"),
  latest: $("#jump-latest"),
  approvals: $("#approvals"),
  input: $("#message-input"),
  send: $("#send"),
  interrupt: $("#interrupt"),
  newButton: $("#new-session"),
  note: $("#control-note"),
  dialog: $("#new-dialog"),
  newForm: $("#new-form"),
  moveDialog: $("#move-pm-dialog"),
  infoDialog: $("#info-dialog"),
  settingsDialog: $("#settings-dialog"),
  menu: $("#conversation-menu"),
  messageMenu: $("#message-menu"),
};
const LABEL = {
  needs_input: "Needs you",
  working: "Working",
  turn_finished: "Ready",
  idle: "Idle",
  unknown: "Untracked",
  ended: "Ended",
  dead: "Stopped",
  failed: "Failed",
};
const GROUPS = [
  ["needs_input", "Needs you"],
  ["working", "Working"],
  ["turn_finished", "Ready for you"],
  ["idle", "Idle"],
  ["unknown", "Untracked"],
  ["failed", "Failed"],
  ["ended", "Ended"],
  ["dead", "Stopped"],
];
// Deep links (epic #43 contract D): /?session=<key> and /?view=pm. Plain-JS mirror of
// parseDeepLink in shared/notify.ts; web/ is static and cannot import it.
const SESSION_KEY_PATTERN = /^[\x21-\x7e]{1,300}$/;
function parseDeepLink(search) {
  if (typeof search !== "string" || search.length > 4096) return null;
  let params;
  try { params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search); } catch { return null; }
  const session = params.get("session");
  if (session !== null && SESSION_KEY_PATTERN.test(session)) return { session };
  if (params.get("view") === "pm") return { view: "pm" };
  return null;
}
// The URL is the only record of the open conversation, so reload keeps the view. The PM is
// the home view: it lives at "/" ("/?view=pm" still opens it), and every other conversation
// sits one Back step above it.
function viewUrl(key) {
  return key && key !== "pm" ? `/?session=${encodeURIComponent(key)}` : "/";
}
const initialLink = parseDeepLink(location.search);
// "pm" is the PM sentinel, never a session key; a session link naming it is unknown.
const unknownInitialLink = initialLink?.session === "pm" || (!initialLink && new URLSearchParams(location.search).has("session"));
let selected = initialLink?.session && initialLink.session !== "pm" ? initialLink.session : "pm";
// A deep-linked session opens optimistically and is checked against the host's list once.
let deepLinkPending = selected && selected !== "pm" ? selected : null, initialNoticeShown = false;
const UNKNOWN_LINK_NOTICE = "That conversation isn’t available on the execution host. Showing the Coordinator.";
let sessions = [],
  detail = null,
  host = { online: false },
  // GET /api/pm/host (epic #26 contract D): which machine runs the PM. null until read, or
  // when the host or relay does not serve the route.
  pmHost = null,
  // Whether /api/pm/host has answered since sign-in (the PM view shows a placeholder until then),
  // and a relay-mode local daemon's own view of the assignment (its 404 body), shown instead.
  pmHostChecked = false,
  pmHostView = null,
  hostError = "",
  authorized = false,
  authRequired = false,
  localAuthMode = false,
  firebaseAuth,
  authSDK;
let pollTimer,
  polling = false,
  pollAgain = false,
  // Conversations with a send in flight. Per conversation: a pending session send must not
  // disable the PM's composer or its Interrupt.
  sending = new Set(),
  creating = false,
  authEpoch = 0,
  selectionEpoch = 0;
let messageSignature = "",
  approvalSignature = "",
  creationAttempt,
  pmBusy = false;
let pmModel = "", pmModelSaving = false, pmModelLoading = false, pmModelReady = false,
  pmModelLoaded = false, modelRevision = 0, newModelRequest = 0;
// GET /api/leads (epic #157): the Lead registry, answered by the relay even while the host is
// offline (host-local in the local UI). null until read, or when the route is not served.
let leads = null, leadsMode = null, leadsRetryAt = 0;
// GET /api/settings: the developer's role models, standing Bypass grants and "ask before each
// Bypass launch", plus whether this app may change them (`writable`, false in the local UI).
let settingsView = null, settingsError = "", settingsLoading = false, settingsBusy = false, settingsRequest = 0;
let askBusy = false;
let projectRows = [], projectResolution = null, projectSelection = null, projectRevision = 0, projectPending = false;
const projectName = (s) => s.project_name || (s.cwd || "").split("/").filter(Boolean).at(-1) || "Project unavailable";
const drafts = new Map(),
  sendAttempts = new Map();
// Unsent composer text per conversation, kept on this device across reloads and offline
// round trips. Bounded, best effort, and erased on sign-out.
const DRAFT_STORAGE = "foreman:drafts", DRAFT_LIMIT = 20, DRAFT_MAX = 60000;
let draftTimer;
function loadDrafts() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_STORAGE) || "[]");
    if (!Array.isArray(saved)) return;
    for (const entry of saved.slice(-DRAFT_LIMIT))
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].length <= 300 && typeof entry[1] === "string" && entry[1])
        drafts.set(entry[0], entry[1].slice(0, DRAFT_MAX));
  } catch { /* Unreadable or unavailable storage starts with no drafts. */ }
}
function saveDrafts() {
  clearTimeout(draftTimer);
  draftTimer = undefined;
  try {
    const entries = [...drafts].filter(([, text]) => text.trim()).slice(-DRAFT_LIMIT)
      .map(([key, text]) => [key, text.slice(0, DRAFT_MAX)]);
    if (entries.length) localStorage.setItem(DRAFT_STORAGE, JSON.stringify(entries));
    else localStorage.removeItem(DRAFT_STORAGE);
  } catch { /* Drafts stay in memory when storage is full or unavailable. */ }
}
// Most recently edited last, so the oldest drafts are the ones dropped at the limit.
function setDraft(key, text) {
  if (!key) return;
  drafts.delete(key);
  if (text) drafts.set(key, text);
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDrafts, 300);
}
function flushDrafts() {
  if (draftTimer !== undefined) saveDrafts();
}
function clearDrafts() {
  drafts.clear();
  clearTimeout(draftTimer);
  draftTimer = undefined;
  try { localStorage.removeItem(DRAFT_STORAGE); } catch { /* optional */ }
}
loadDrafts();
window.addEventListener("pagehide", flushDrafts);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushDrafts(); });
const actionFeedback = new Map(), approvalFeedback = new Map();
let conversationLoading = false, hostChecked = false, sessionsLoaded = false;
let timelineEntries = [], nextEntryKey = 0, newMessages = false;
const copyStates = new Map();
function nearLatest() {
  return ui.timeline.scrollHeight - ui.timeline.scrollTop - ui.timeline.clientHeight < 100;
}
function updateLatest() {
  if (nearLatest()) newMessages = false;
  ui.latest.hidden = !selected || conversationLoading || nearLatest();
  const label = newMessages ? "New messages ↓" : "Jump to latest";
  if (ui.latest.textContent !== label) ui.latest.textContent = label;
}
function resetLatest() {
  pinnedToLatest = true;
  seenScrollTop = ui.timeline.scrollTop;
  for (const state of copyStates.values()) { clearTimeout(state.timer); state.render = () => {}; }
  copyStates.clear();
  timelineEntries = [];
  newMessages = false;
  ui.latest.hidden = true;
}
// Whether the reader is at the latest message. Kept from scroll events, so a resize (the keyboard
// opening, a banner appearing) that shrinks the timeline keeps the latest message in view, as a
// messaging app does. The resize itself changes no scroll position, so it cannot clear this.
// `seenScrollTop` is the position `pinnedToLatest` was taken at: a scroll whose event has not
// arrived yet (it is dispatched on the next frame) must not be mistaken for staying pinned.
let pinnedToLatest = true, seenScrollTop = 0;
ui.timeline.addEventListener("scroll", () => { pinnedToLatest = nearLatest(); seenScrollTop = ui.timeline.scrollTop; updateLatest(); }, { passive: true });
function stillPinned() {
  return nearLatest() || (pinnedToLatest && ui.timeline.scrollTop === seenScrollTop);
}
function keepLatestInView() {
  if (stillPinned()) { ui.timeline.scrollTop = ui.timeline.scrollHeight; pinnedToLatest = true; seenScrollTop = ui.timeline.scrollTop; }
  updateLatest();
}
if ("ResizeObserver" in window) new ResizeObserver(keepLatestInView).observe(ui.timeline);
ui.latest.addEventListener("click", () => {
  newMessages = false;
  // Keep keyboard focus in the history when the button disappears at the bottom.
  ui.timeline.focus({ preventScroll: true });
  ui.timeline.scrollTo({ top: ui.timeline.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  updateLatest();
});

function setActionFeedback(key, action, text, error = false) {
  const feedback = actionFeedback.get(key) || {};
  feedback[action] = { text, error };
  actionFeedback.set(key, feedback);
  if (key === selected) renderActionFeedback();
}
function renderActionFeedback() {
  for (const action of ["send", "interrupt"]) {
    const target = $(`#${action}-feedback`);
    const feedback = actionFeedback.get(selected)?.[action];
    const text = feedback?.text || "";
    if (target.textContent !== text) target.textContent = text;
    target.classList.toggle("error", !!feedback?.error);
    target.hidden = !text;
  }
}
function showConversationLoading(message = "Opening conversation…", failed = false) {
  conversationLoading = true;
  let loading = $("#conversation-loading");
  if (!loading) {
    loading = node("div", "loading-state");
    loading.id = "conversation-loading";
    loading.setAttribute("role", "status");
    ui.messages.replaceChildren(loading);
  }
  if (loading.dataset.message === message) return;
  loading.dataset.message = message;
  const symbol = node("span", failed ? "" : "activity-symbol", failed ? "!" : "");
  symbol.setAttribute("aria-hidden", "true");
  loading.replaceChildren(symbol, node("span", "", message));
}
function showRefreshError(error) {
  if (conversationLoading) showConversationLoading(`Could not open conversation. ${errorMessage(error)} Retrying automatically.`, true);
  else showError(error);
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = String(text);
  return el;
}
function errorMessage(error) {
  return error?.message || String(error);
}
function showError(error) {
  $("#error-text").textContent = errorMessage(error);
  $("#error-banner").hidden = false;
}
function clearError() {
  $("#error-banner").hidden = true;
}
function ago(value) {
  if (!value) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  return seconds < 60
    ? "now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h`
        : `${Math.floor(seconds / 86400)}d`;
}
function shortPath(value) {
  return String(value || "").replace(/^\/Users\/[^/]+/, "~");
}
function sourceLabel(source) {
  if (!source || source === "user" || source === "human") return null;
  return typeof source === "string"
    ? source
    : source.name ||
        source.sender ||
        source.session_key ||
        source.session ||
        source.kind ||
        "Peer";
}
async function api(path, options = {}, retry = true) {
  const epoch = authEpoch;
  const headers = { ...options.headers };
  if (options.body) headers["content-type"] = "application/json";
  if (authRequired && !localAuthMode) {
    if (!firebaseAuth?.currentUser) throw new Error("Sign in to continue.");
    headers.Authorization = `Bearer ${await firebaseAuth.currentUser.getIdToken()}`;
  }
  const response = await fetch(path, {
    ...options,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });
  if (epoch !== authEpoch)
    throw new Error("Your sign-in changed. Please try again.");
  if (
    response.status === 401 &&
    retry &&
    authRequired &&
    firebaseAuth?.currentUser
  ) {
    await firebaseAuth.currentUser.getIdToken(true);
    return api(path, options, false);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      `The server returned an unreadable response (${response.status}).`,
    );
  }
  if (!response.ok) {
    if (authRequired && (response.status === 401 || response.status === 403)) {
      const reason = localAuthMode ? "Enter your local API token to unlock Foreman." :
        response.status === 403
          ? "This Google account does not have access to Foreman. Sign in with the authorized account."
          : "Your sign-in expired. Sign in again to continue.";
      revokeAccess(reason);
    }
    const error = new Error(
      result.error || `Request failed (${response.status}).`,
    );
    error.status = response.status;
    error.body = result;
    throw error;
  }
  return result;
}
function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

function revokeAccess(message) {
  authEpoch++;
  // Nothing the previous identity read or typed outlives sign-out: the Lead registry, the
  // settings, and the text of an unsent "Ask the Coordinator".
  leads = null; leadsMode = null; leadsRetryAt = 0;
  settingsView = null; settingsError = ""; settingsLoading = false; settingsBusy = false; settingsRequest++;
  askBusy = false; $("#ask-coordinator").value = ""; askStatus("");
  $("#settings-dialog").close();
  authorized = false;
  pmModel = ""; pmModelLoaded = false; pmModelReady = false;
  sending.clear(); creating = false; pmModelSaving = false; pmModelLoading = false;
  newModelRequest++;
  projectRevision++; projectRows = []; projectResolution = null; projectSelection = null; projectPending = false;
  $("#project-choices").replaceChildren(); $("#project-status").textContent = ""; $("#project-feedback").textContent = "";
  ui.interrupt.dataset.busy = "false";
  $("#create-session").textContent = "Start session";
  $("#pm-model-hint").textContent = PM_MODEL_HINT;
  modelOptions($("#pm-model"), []);
  clearTimeout(pollTimer);
  sessions = [];
  hostChecked = false;
  sessionsLoaded = false;
  detail = null;
  host = { online: false };
  pmHost = null; pmHostChecked = false; pmHostView = null; hostError = "";
  renderPmHost();
  ui.moveDialog.close();
  ui.infoDialog.close();
  closeMenus();
  // Nothing of the previous identity's messages outlives sign-out.
  copyStatus("");
  messageMenuText = "";
  messageMenuTarget = null;
  shownHistory = []; shownReceipts = []; hiddenSteps = 0; showSteps = false;
  clearDrafts();
  // A PM failure seen by the previous identity is not shown to the next one.
  polledPmError = null;
  setPmRailError(null);
  // Push feedback belongs to the previous identity; the state is re-read on the next sign-in.
  pushFeedback();
  hideNotice();
  sendAttempts.clear();
  actionFeedback.clear();
  approvalFeedback.clear();
  conversationLoading = false;
  renderActionFeedback();
  messageSignature = "";
  resetLatest();
  approvalSignature = "";
  ui.messages.replaceChildren();
  ui.approvals.replaceChildren();
  ui.input.value = "";
  ui.list.replaceChildren();
  ui.dialog.close();
  ui.newForm.reset();
  creationAttempt = undefined;
  ui.app.hidden = true;
  ui.authScreen.hidden = false;
  ui.authStatus.textContent = message;
  ui.signIn.hidden = localAuthMode;
  ui.signIn.disabled = false;
  const localForm = $("#local-auth-form");
  if (localForm) localForm.hidden = false;
  updateControls();
}
function setNav(open) {
  ui.app.classList.toggle("nav-open", open);
  $("#nav-backdrop").hidden = !open;
  $("#open-nav").setAttribute("aria-expanded", String(open));
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  $("#rail").inert = mobile && !open;
  $(".conversation").inert = mobile && open;
  if (open) $("#close-nav").focus();
}
// History model (Android Back). The stack is at most [PM, conversation, drawer, dialog] (or
// [PM, conversation, info, Move PM or Settings] for the info screen):
// opening a conversation from the PM pushes an entry, switching conversations replaces it,
// and the drawer and the new-session dialog each push an overlay entry. Back therefore closes
// the dialog, then the drawer, then returns to the PM, then leaves the app. Every entry
// carries { foreman: 1, view, overlay? } so popstate can restore the matching screen; the PM
// home entry records view null.
let ownBack = null, ownBackDone = null;
function historyState(view, overlay) {
  const home = !view || view === "pm";
  return overlay ? { foreman: 1, view: home ? null : view, overlay } : { foreman: 1, view: home ? null : view };
}
// history.back() is asynchronous; later history changes wait for its popstate so they never
// race it. The popstate of our own back is not treated as a user navigation.
function historyBack() {
  if (ownBack) return;
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const timer = setTimeout(() => ownBack?.(), 1000);
  ownBack = () => { clearTimeout(timer); ownBack = null; ownBackDone = null; release(); };
  ownBackDone = done;
  history.back();
}
function afterHistory(run) {
  if (ownBackDone) ownBackDone.then(run);
  else run();
}
function recordView(key) {
  if (key === "pm") key = null;
  afterHistory(() => {
    const state = history.state;
    if (state?.foreman && state.overlay) {
      // A conversation opened from the drawer or dialog replaces neither; pop them first.
      historyBack();
      afterHistory(() => recordView(key));
      return;
    }
    if (state?.foreman && state.view === (key || null)) return;
    if (!key) {
      // Our conversation entries always sit directly above the PM home entry.
      if (state?.foreman && state.view) historyBack();
      else history.replaceState(historyState(null), "", "/");
    } else if (state?.foreman && state.view) history.replaceState(historyState(key), "", viewUrl(key));
    else history.pushState(historyState(key), "", viewUrl(key));
  });
}
function pushOverlay(kind, isOpen) {
  afterHistory(() => {
    if (!isOpen() || history.state?.overlay === kind) return;
    history.pushState(historyState(selected, kind), "", location.href);
  });
}
function popOverlay(kind) {
  afterHistory(() => {
    if (history.state?.foreman && history.state.overlay === kind) historyBack();
  });
}
const navOpen = () => ui.app.classList.contains("nav-open");
function openNav() {
  setNav(true);
  pushOverlay("nav", navOpen);
}
function closeNav() {
  setNav(false);
  popOverlay("nav");
}
// An overlay entry whose layer is gone (the page was reloaded with the drawer or a dialog open,
// or Forward/Back reached it after the layer closed). Every overlay entry sits directly above an
// entry for the same view, so stepping back onto it removes the dead layer without leaving two
// identical entries behind (which made the next Back appear to do nothing). `budget` bounds the
// steps (the stack holds at most two overlays); if it runs out, the entry is kept as a plain view.
function deadOverlay(state) {
  return (state?.overlay === "nav" && !navOpen()) || (state?.overlay === "dialog" && !ui.dialog.open) || (state?.overlay === "move" && !ui.moveDialog.open)
    || (state?.overlay === "info" && !ui.infoDialog.open) || (state?.overlay === "settings" && !ui.settingsDialog.open);
}
function dropDeadOverlay(budget = 3) {
  afterHistory(() => {
    const state = history.state;
    if (!state?.foreman || !deadOverlay(state)) return;
    if (budget <= 0) {
      history.replaceState(historyState(state.view), "", location.href);
      return;
    }
    historyBack();
    dropDeadOverlay(budget - 1);
  });
}
function initHistory() {
  const url = viewUrl(selected);
  const state = history.state;
  if (state?.foreman && (state.view || "pm") === selected) {
    // A reload or restore of an entry this app created keeps its stack; an overlay that
    // no longer exists after the reload is stepped off (see dropDeadOverlay).
    if (state.overlay) dropDeadOverlay();
    else if (location.pathname + location.search !== url) history.replaceState(historyState(selected), "", url);
  } else if (selected !== "pm") {
    // A fresh deep link: put the PM beneath it, so Back returns to the PM, not out.
    history.replaceState(historyState(null), "", "/");
    history.pushState(historyState(selected), "", url);
  } else history.replaceState(historyState(null), "", "/");
}
window.addEventListener("popstate", (event) => {
  if (ownBack) { ownBack(); return; }
  const state = event.state?.foreman ? event.state : historyState(parseDeepLinkKey(location.search));
  // Back closes the top-most layer first: the dialog, then the drawer, then the conversation.
  if (ui.dialog.open && state.overlay !== "dialog") ui.dialog.close();
  if (ui.moveDialog.open && state.overlay !== "move") ui.moveDialog.close();
  if (ui.settingsDialog.open && state.overlay !== "settings") ui.settingsDialog.close();
  // Move Coordinator and Settings open on top of the info screen, so Back from them returns to it.
  if (ui.infoDialog.open && !["info", "move", "settings"].includes(state.overlay)) ui.infoDialog.close();
  closeMenus();
  if (navOpen() && !state.overlay) {
    setNav(false);
    $("#open-nav").focus({ preventScroll: true });
  }
  // Forward into an overlay entry whose layer is gone: step back off it (same view beneath).
  if (event.state?.foreman && deadOverlay(state)) dropDeadOverlay();
  const view = state.view || "pm";
  if (view === selected) return;
  // Forward onto a deep link that was rejected: the same neutral PM fallback, not the
  // conversation's error, unless the host has since listed that session. Before the first
  // session list (right after a reload) that is not known yet, so the entry opens as a deep link
  // does at load and the next list decides.
  if (view !== "pm" && state.rejected && !sessions.some((s) => s.session_key === view)) {
    if (!sessionsLoaded) {
      void selectSession(view, false);
      deepLinkPending = view;
      return;
    }
    showInbox();
    showNotice(UNKNOWN_LINK_NOTICE);
    historyBack();
    return;
  }
  void selectSession(view, false);
});
function parseDeepLinkKey(search) {
  const link = parseDeepLink(search);
  return link?.view === "pm" ? "pm" : link?.session && link.session !== "pm" ? link.session : null;
}
let noticeTimer;
function showNotice(text) {
  const notice = $("#app-notice");
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideNotice, 10000);
}
function hideNotice() {
  clearTimeout(noticeTimer);
  $("#app-notice").hidden = true;
}
// GET /api/host names the machine this app talks to (the PM's machine with the relay). Its name
// when known, never an assumed platform.
function hostName(fallback) {
  return typeof host.host === "string" && host.host.trim() ? host.host.trim() : fallback;
}
function renderHost() {
  $("#host-dot").className = `dot ${host.online ? "online" : "offline"}`;
  $("#host-status").textContent = !hostChecked ? "Connecting to execution host…" : host.online
    ? `${hostName("Execution host")} · online`
    : hostName("") ? `${hostName("")} · offline` : "Execution host offline";
  renderConnectionBanner();
  updateControls();
  if (ui.messages.querySelector(".empty-state") && !conversationLoading) renderMessages(shownHistory, shownReceipts);
}
function renderConnectionBanner() {
  const banner = $("#connection-banner");
  const text = hostError ? `Cannot reach the execution host. ${hostError} Retrying automatically.`
    : `${hostName("The execution host")} is disconnected. Showing the last available state. Messages and approvals will be available when it reconnects.`;
  if (banner.textContent !== text) banner.textContent = text;
  // In the PM view the machine line already says the PM's machine is offline.
  const saidByPmLine = selected === "pm" && !$("#pm-host-offline").hidden;
  banner.hidden = !!host.online || !hostChecked || (!hostError && saidByPmLine);
}
// The Lead a worker belongs to, or a Lead by its session key: its display name when known.
function leadEntry(key) {
  return Array.isArray(leads) ? leads.find((lead) => sameKey(lead.lead, key)) || null : null;
}
function leadName(key) {
  if (typeof key !== "string" || !key) return "";
  return sessions.find((s) => sameKey(s.session_key, key))?.name || leadEntry(key)?.name || key;
}
function requesterName(value) {
  if (value === "coordinator") return "the Coordinator";
  if (value === "developer" || !value) return "you";
  return leadName(value);
}
// A superseded or ended Lead: kept readable under Archived.
function archivedLead(s) {
  return roleOf(s) === "lead" && (!!s.superseded_by || ["ended", "dead"].includes(s.state) || leadEntry(s.session_key)?.ended === true);
}
// Workers are not chats of their own: they are listed on their Lead's info screen, and surface in
// the list only while they need you (or while one is open, or matches a search).
function workerSurfaces(s, query) {
  return s.state === "needs_input" || selected === s.session_key || !!query;
}
function rowSummary(s) {
  if (s.state === "needs_input") return s.reason === HELD_LAUNCH_REASON ? "Launch with Bypass? Waiting for your approval" : s.reason || "Waiting for your response";
  if (s.state === "working") return s.current_tool ? stepPhrase({ name: baseToolName(s.current_tool), detail: "" }) : "Working on your task";
  return launchOutcome(s) || s.last_message || projectName(s);
}
let archivedOpen = false;
function sessionRow(s) {
  const known = new Set(GROUPS.map(([state]) => state));
  const row = node("button", `session-row${selected === s.session_key ? " selected" : ""}`);
  row.title = s.cwd || "";
  const role = roleOf(s);
  const via = role === "worker" && s.parent ? leadName(s.parent) : "";
  const tag = policyTag(s);
  row.setAttribute("aria-description", [role === "lead" ? "Project Lead" : role === "worker" ? "Worker" : "", projectName(s), LABEL[s.state] || "Unknown state", !host.online ? "Last known" : ""].filter(Boolean).join(" · "));
  row.type = "button";
  row.dataset.session = s.session_key;
  row.dataset.state = s.state || "";
  row.dataset.role = role;
  row.setAttribute("aria-pressed", String(selected === s.session_key));
  const dot = node("span", `dot ${known.has(s.state) ? s.state : "unknown"}`);
  dot.setAttribute("aria-hidden", "true");
  const name = node("span", "session-name", s.name || s.session_id?.slice(0, 8) || "Session");
  if (via) name.append(node("span", "session-via", ` · via ${via}`));
  // A space keeps the tags separate words for screen readers (and in the row's accessible name).
  if (role === "lead") name.append(" ", node("span", "role-tag", "Lead"));
  if (tag) name.append(" ", node("span", `policy-tag${s.permission_mode === "bypass" ? " is-bypass" : ""}`, tag));
  row.append(dot, name, node("span", "session-age", ago(s.updated_at || s.started_at)));
  row.append(node("span", "session-sub", rowSummary(s)));
  if (s.state === "needs_input") row.append(node("span", "attention-badge", "Needs you"));
  row.addEventListener("click", () => selectSession(s.session_key));
  return row;
}
function renderRail() {
  const focusedKey = document.activeElement?.dataset?.session;
  const focusedClear = document.activeElement?.hasAttribute("data-clear-search");
  const focusedArchive = document.activeElement?.hasAttribute("data-archived-summary");
  ui.list.replaceChildren();
  const query = ui.search.value.trim().toLowerCase();
  const visible = sessions.filter(
    (s) =>
      s.name !== PM_SESSION_NAME &&
      (roleOf(s) !== "worker" || workerSurfaces(s, query)) &&
      (!query ||
        `${s.name} ${s.cwd} ${s.project_name || ""} ${s.provider}`.toLowerCase().includes(query)),
  );
  $("#session-count").textContent = String(
    sessions.filter((s) => s.name !== PM_SESSION_NAME).length,
  );
  $("#select-pm").classList.toggle("selected", selected === "pm");
  $("#select-pm").setAttribute("aria-pressed", String(selected === "pm"));
  // A chat list: the Coordinator pinned above it, then Leads and your sessions, those that need
  // you first, then the most recently active. Each row is the name, the time, a one-line preview,
  // and a badge when the session needs you. Superseded and ended Leads go under Archived.
  const recent = (a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  const archived = visible.filter(archivedLead).sort(recent);
  const rows = visible.filter((s) => !archivedLead(s)).sort((a, b) =>
    Number(b.state === "needs_input") - Number(a.state === "needs_input") || recent(a, b));
  for (const s of rows) ui.list.append(sessionRow(s));
  if (archived.length) {
    const group = node("details", "archived-group");
    // A search, or an open archived chat, shows the group open.
    group.open = archivedOpen || !!query || archived.some((s) => s.session_key === selected);
    const summary = node("summary", "archived-summary", `Archived · ${archived.length}`);
    summary.dataset.archivedSummary = "true";
    group.append(summary);
    for (const s of archived) group.append(sessionRow(s));
    group.addEventListener("toggle", () => { if (!query) archivedOpen = group.open; });
    ui.list.append(group);
  }
  if (!visible.length) {
    const empty = node("div", "rail-empty");
    const noMatches = !!query && sessionsLoaded;
    empty.append(node("p", "", noMatches ? "No sessions match your search."
      : !hostChecked || (host.online && !sessionsLoaded) ? "Loading sessions…"
      : !host.online ? `${hostName("The execution host")} is offline. Reconnect to see sessions.`
      : "No sessions yet. Start a session above."));
    if (noMatches) {
      const clear = node("button", "btn ghost", "Clear search");
      clear.type = "button";
      clear.dataset.clearSearch = "true";
      clear.addEventListener("click", () => { ui.search.value = ""; renderRail(); ui.search.focus(); });
      empty.append(clear);
    }
    ui.list.append(empty);
  }
  if (focusedClear) ui.list.querySelector("[data-clear-search]")?.focus({ preventScroll: true });
  if (focusedArchive) ui.list.querySelector("[data-archived-summary]")?.focus({ preventScroll: true });
  if (focusedKey)
    [...ui.list.querySelectorAll("button")]
      .find((button) => button.dataset.session === focusedKey)
      ?.focus({ preventScroll: true });
}
function updateControls() {
  const isPm = selected === "pm";
  const session = detail?.session;
  const canMessage =
    authorized && host.online && ((isPm && !pmModelSaving) || (!isPm && !!session?.capabilities?.message));
  $("#pm-model-control").hidden = !isPm;
  $("#pm-model").disabled = !authorized || !host.online || !pmModelReady || pmBusy || pmModelSaving || pmModelLoading;
  ui.newButton.disabled = !authorized || !host.online || creating;
  ui.messages.querySelectorAll("[data-new-session]").forEach((button) => {
    button.disabled = !authorized || !host.online;
  });
  $("#create-session").disabled = !authorized || !host.online || creating || projectPending || !projectResolution;
  $("#send-to-coordinator").disabled = !authorized || !host.online || askBusy || !$("#ask-coordinator").value.trim();
  $("#send-to-coordinator").textContent = askBusy ? "Asking…" : "Ask the Coordinator";
  const sendingHere = sending.has(selected);
  ui.input.disabled = !canMessage || sendingHere;
  ui.send.disabled = !canMessage || sendingHere || !ui.input.value.trim();
  ui.send.firstChild.textContent = sendingHere ? "Sending… " : "Send ";
  ui.interrupt.disabled =
    !authorized ||
    !host.online ||
    (isPm ? !pmBusy : !session?.capabilities?.interrupt) ||
    // Until a PM send's 202 arrives its turn is not dispatched yet, so Stop could not reach it.
    (isPm && sendingHere) ||
    ui.interrupt.dataset.busy === "true";
  ui.interrupt.textContent = ui.interrupt.dataset.busy === "true" ? "Interrupting…" : "Interrupt";
  // Interrupt shows only while a turn is running (or a request to stop one is in flight).
  const running = isPm ? pmBusy : !!session?.capabilities?.interrupt && ["working", "needs_input"].includes(session?.state);
  const hideInterrupt = !running && ui.interrupt.dataset.busy !== "true";
  // A keyboard user who pressed Interrupt keeps focus in the conversation when it goes away.
  if (hideInterrupt && !ui.interrupt.hidden && document.activeElement === ui.interrupt) ui.timeline.focus({ preventScroll: true });
  ui.interrupt.hidden = hideInterrupt;
  renderActionFeedback();
  ui.input.placeholder = !selected
    ? "Choose a session to start a conversation"
    : !host.online
      ? `Reconnect ${hostName("the execution host")} to send a message`
      : !canMessage
        ? "This session is available for monitoring"
        : isPm
          ? "What are we working on?"
          : `Message ${session?.name || "this session"}…`;
  ui.note.textContent = !selected
    ? ""
    : !host.online
      ? "Displayed activity may be out of date."
      : isPm
        ? "Your Coordinator keeps track of the work and delegates to session agents."
        : !canMessage
          ? session?.control_reason ||
            "Monitoring only. This session was started outside Foreman; use its original terminal to continue."
          : "Follow-ups are queued while the agent is working.";
  ui.approvals
    .querySelectorAll("button, input, select, textarea")
    .forEach((control) => {
      control.disabled =
        !host.online || control.closest("form")?.dataset.busy === "true";
    });
}
const HANDOFF_STATUS = { in_progress: "In progress", blocked: "Blocked", waiting_on_developer: "Waiting on you", done: "Done", abandoned: "Abandoned" };
const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
function whenText(ms) {
  const date = typeof ms === "number" ? new Date(ms) : new Date(Date.parse(ms));
  return Number.isNaN(date.getTime()) ? "an unknown time" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function agoText(value) {
  const age = ago(typeof value === "number" ? new Date(value).toISOString() : value);
  return !age ? "" : age === "now" ? "just now" : `${age} ago`;
}
// The machine a Lead runs on, from the Lead registry (GET /api/leads).
function leadMachine(entry) {
  if (!entry) return "";
  return entry.machine_online ? `${entry.machine_name} · online`
    : `${entry.machine_name} · machine offline · last known state at ${whenText(entry.reported_at)}`;
}
// A Lead's workers: the registry's list, plus any worker session on this host that names it.
function leadWorkers(s, entry) {
  const workers = new Map();
  for (const w of Array.isArray(entry?.workers) ? entry.workers : []) {
    if (typeof w?.session_key !== "string" || !w.session_key) continue;
    workers.set(w.session_key.toLowerCase(), { key: w.session_key, name: typeof w.name === "string" && w.name ? w.name : w.session_key, state: w.state, permission_mode: w.permission_mode });
  }
  for (const row of sessions) {
    if (roleOf(row) !== "worker" || typeof row.session_key !== "string" || !sameKey(row.parent, s.session_key)) continue;
    workers.set(row.session_key.toLowerCase(), { key: row.session_key, name: row.name || row.session_key, state: row.state, permission_mode: row.permission_mode, row });
  }
  return [...workers.values()];
}
let leadInfoSignature = "";
function renderLeadInfo(s) {
  const lead = !!s && roleOf(s) === "lead";
  $("#lead-handoff").hidden = !lead;
  $("#lead-workers").hidden = !lead;
  if (!lead) { leadInfoSignature = ""; return; }
  const entry = leadEntry(s.session_key);
  const handoff = entry?.last_handoff;
  const workers = leadWorkers(s, entry);
  const signature = JSON.stringify([s.session_key, handoff, workers.map(({ row, ...w }) => ({ ...w, listed: !!row })), leads === null, Math.floor(Date.now() / 60000)]);
  if (signature === leadInfoSignature) return;
  leadInfoSignature = signature;
  $("#lead-handoff-status").textContent = handoff
    ? [HANDOFF_STATUS[handoff.status] || handoff.status, handoff.kind === "final" ? "final" : "", agoText(handoff.at)].filter(Boolean).join(" · ")
    : leads === null ? "Handoffs are unavailable here." : "No handoff yet.";
  $("#lead-handoff-summary").textContent = handoff?.summary || "";
  const list = $("#lead-worker-list");
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.session : null;
  list.replaceChildren();
  for (const w of workers) {
    const item = node("li", "lead-worker");
    const label = `${w.name} · ${LABEL[w.state] || w.state || "Unknown state"}${w.permission_mode === "bypass" ? " · ⚠ Bypass" : w.permission_mode === "auto" ? " · Auto" : ""}`;
    if (w.row) {
      // Workers are not chats in the list, so their conversations open from here.
      const open = node("button", "lead-worker-open", label);
      open.type = "button";
      open.dataset.session = w.key;
      open.addEventListener("click", () => { ui.infoDialog.close(); void selectSession(w.key); });
      item.append(open);
    } else item.append(node("span", "", label));
    list.append(item);
  }
  if (!workers.length) list.append(node("li", "field-hint", "No workers."));
  if (focused) list.querySelector(`[data-session="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}
// The Coordinator's info screen summarizes the settings it launches with; Settings changes them.
function roleSummary(settings, role) {
  const config = settings?.roles?.[role] || {};
  const model = role === "coordinator" ? null : config.model || `${ROLE_DEFAULTS[role].model} (default)`;
  const effort = config.effort || `${ROLE_DEFAULTS[role].effort}${config.model || role === "coordinator" ? " (default)" : ""}`;
  return model ? `${model} · ${effort}` : effort;
}
function grantSummary(settings, role) {
  const grants = settings?.bypass_grants || DEFAULT_BYPASS_GRANTS;
  const all = grants.find((g) => g.role === role && g.project === "*");
  const overrides = grants.filter((g) => g.role === role && g.project !== "*");
  const base = all?.allow ? "⚠ Bypass on every project" : "Auto (Bypass off)";
  return overrides.length ? `${base} · ${overrides.length} project override${overrides.length === 1 ? "" : "s"}` : base;
}
function renderCoordinatorSettings() {
  const section = $("#coordinator-settings");
  section.hidden = selected !== "pm";
  if (section.hidden) return;
  const settings = settingsView?.settings || null;
  const fields = [
    ["Coordinator effort", roleSummary(settings, "coordinator")],
    ["Leads", roleSummary(settings, "lead")],
    ["Investigators", roleSummary(settings, "investigator")],
    ["Leads it starts", grantSummary(settings, "coordinator")],
    ["Workers Leads start", grantSummary(settings, "lead")],
    ["Before each Bypass launch", settings?.bypass_ask ? "Ask me" : "Don’t ask"],
  ];
  if (!settingsView) fields.push(["Settings", settingsLoading ? "Loading…" : settingsError ? `Unavailable: ${settingsError}` : "Showing defaults"]);
  const summary = $("#coordinator-settings-summary");
  const signature = JSON.stringify(fields);
  if (summary.dataset.signature === signature) return;
  summary.dataset.signature = signature;
  summary.replaceChildren(...fields.flatMap(([label, value]) => [node("dt", "", label), node("dd", "", value)]));
}
// The info screen carries the conversation's full name (and the Project field its full project).
function setTitle(header, full) {
  if (ui.title.textContent !== header) ui.title.textContent = header;
  ui.title.title = header;
  $("#info-title").textContent = full;
}
// The header names what the conversation is, on one row (#176): the agent for the Coordinator, the
// project and role for a Lead or worker, and the chat's own name otherwise. There is no generic
// title; while a chat loads, its name from the list is shown if known.
function chatTitle(s) {
  const role = roleOf(s);
  if (role === "lead" || role === "worker") {
    const project = s.project_name || (role === "lead" ? leadEntry(s.session_key)?.project : "") || projectName(s);
    return `${project} · ${role === "lead" ? "Lead" : "Worker"}`;
  }
  return s.name || projectName(s);
}
function renderHeading() {
  const model = $("#header-model");
  const isPm = selected === "pm";
  const fields = [];
  let selectedModel = "";
  if (isPm) {
    setTitle("Coordinator", "Claude · Coordinator");
    ui.provider.hidden = true;
    selectedModel = pmModelReady ? pmModel || "Provider default" : "Loading model…";
    fields.push(["Selected model", selectedModel]);
    if (pmModelReady && !pmModel) fields.push(["Model settings", "Provider settings determine the model; Foreman has not verified a concrete model."]);
    fields.push(["Applies to", "The Coordinator’s replies and planning. Newly launched agents have their own model selection."]);
    const machine = pmHost?.active;
    if (machine) fields.push(["Runs on", `${machine.name} · ${machine.online ? "online" : "offline"}${pmHost.mode === "local" ? " · this machine only (no cloud relay)" : ""}`]);
  } else if (detail?.session) {
    const s = detail.session;
    const role = roleOf(s);
    const entry = role === "lead" ? leadEntry(s.session_key) : null;
    setTitle(chatTitle(s), s.name || chatTitle(s));
    ui.provider.hidden = false;
    ui.provider.textContent = s.provider === "codex" ? "Codex" : "Claude";
    selectedModel = s.model || entry?.model || (s.managed ? "Provider default" : "Model not reported");
    const effort = s.effort || entry?.effort;
    fields.push([s.managed ? "Selected model" : "Reported model", effort ? `${selectedModel} · ${effort}` : selectedModel]);
    if (!s.model && !entry?.model && s.managed) fields.push(["Model settings", "Provider settings determine the model; Foreman has not verified a concrete model."]);
    if (role === "lead") fields.push(["Role", "Project Lead"]);
    if (role === "worker") fields.push(["Role", s.parent ? `Worker · via ${leadName(s.parent)}` : "Worker"]);
    if (s.workstream || entry?.workstream) fields.push(["Workstream", s.workstream || entry.workstream]);
    if (agentLaunched(s)) fields.push(["Started by", capitalize(requesterName(launchedBy(s)))]);
    fields.push(["Project", projectName(s)], ["Directory", s.cwd || "Project unavailable"], ["Permissions", s.managed ? policyLabel(s) : "Monitoring only"]);
    if (role === "lead") fields.push(["Machine", entry ? leadMachine(entry) : leads === null ? "Not reported here" : "Not in the Lead registry yet"]);
    if (s.superseded_by) fields.push(["Replaced by", leadName(s.superseded_by)]);
    const outcome = launchOutcome(s);
    if (outcome) fields.push(["Launch", outcome]);
  } else {
    const row = selected ? sessions.find((s) => sameKey(s.session_key, selected)) : null;
    const title = row ? chatTitle(row) : selected ? "Loading…" : "Choose a chat";
    setTitle(title, row?.name || title);
    ui.provider.hidden = true;
  }
  $("#info-eyebrow").textContent = isPm ? "COORDINATOR INFO" : roleOf(detail?.session) === "lead" ? "PROJECT LEAD INFO" : "SESSION INFO";
  $("#open-info").textContent = isPm ? "Coordinator info and model" : roleOf(detail?.session) === "lead" ? "Lead info" : "Session info";
  model.hidden = !selectedModel;
  model.textContent = selectedModel ? `Model · ${selectedModel}` : "";
  model.title = selectedModel;
  const detailSignature = JSON.stringify(fields);
  if (ui.subtitle.dataset.signature !== detailSignature) {
    ui.subtitle.dataset.signature = detailSignature;
    const metadata = node("dl", "header-metadata");
    for (const [label, value] of fields) metadata.append(node("dt", "", label), node("dd", "", value));
    ui.subtitle.replaceChildren(fields.length ? metadata : node("p", "", "Choose a session or start something new."));
  }
  renderLeadInfo(isPm ? null : detail?.session);
  renderCoordinatorSettings();
  renderActivity();
  updateControls();
}
function renderActivity() {
  const status = $("#activity-status"), label = $("#activity-label");
  const state = selected === "pm" ? (pmModelReady ? (pmBusy ? "working" : "turn_finished") : null) : detail?.session?.state;
  const working = state === "working";
  // One line in plain words for the running turn (#201): never a tool name, JSON or a path.
  const doing = working ? workingPhrase(shownHistory, selected !== "pm" ? detail?.session?.current_tool : null) : "";
  const text = state ? `${host.online ? "" : "Last known · "}${working ? doing : LABEL[state] || state}` : "";
  status.hidden = !text;
  // Keep the live region and symbol mounted; only announce actual transitions.
  if (label.textContent !== text) label.textContent = text;
  status.classList.toggle("is-active", working && host.online);
  status.classList.toggle("is-stale", !!state && !host.online);
  status.dataset.state = state || "";
}
function emptyState(title, text, allowCreate = false) {
  const empty = node("div", "empty-state");
  empty.append(
    node("div", "empty-symbol", "◈"),
    node("h2", "", title),
    node("p", "", text),
  );
  if (allowCreate) {
    const button = node("button", "btn", "Start a session");
    button.dataset.newSession = "true";
    button.disabled = !host.online;
    button.addEventListener("click", openNew);
    empty.append(button);
  }
  return empty;
}
function copyControl(text, label, key, entryKey) {
  const group = node("div", "copy-control");
  const button = node("button", "btn ghost copy-button", label);
  button.type = "button";
  button.dataset.copyKey = key;
  const feedback = node("span", "copy-feedback");
  feedback.setAttribute("role", "status");
  const stateKey = `${entryKey}:${key}`;
  const state = copyStates.get(stateKey) || { pending: false, text: "", error: false };
  copyStates.set(stateKey, state);
  // A streaming message may replace its DOM while clipboard permission is open.
  // Completion follows the logical control, but always copies the click's text.
  state.render = () => {
    feedback.textContent = state.text;
    feedback.classList.toggle("error", state.error);
    if (state.pending) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  };
  state.render();
  button.addEventListener("click", async () => {
    if (state.pending) return;
    state.pending = true;
    clearTimeout(state.timer);
    state.text = "";
    state.error = false;
    state.render();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      state.text = "Copied";
      state.timer = setTimeout(() => { state.text = ""; state.render(); }, 2500);
    } catch {
      state.error = true;
      state.text = "Could not copy. Allow clipboard access or select and copy the text manually.";
    } finally {
      state.pending = false;
      state.render();
    }
  });
  group.append(button, feedback);
  return group;
}
function appendContent(container, text, entryKey) {
  // Render plain text and fenced code with DOM nodes. Provider output never enters HTML.
  const parts = String(text || "").split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
  parts.forEach((part, index) => {
    if (!part) return;
    if (index % 2) {
      const pre = node("pre");
      pre.append(node("code", "", part));
      const block = node("div", "code-block");
      block.append(copyControl(part, "Copy code", `code-${index}`, entryKey), pre);
      container.append(block);
    } else container.append(node("div", "message-body", part));
  });
}
function entryDate(entry) {
  const timestamp = entry.at || entry.ts;
  if (typeof timestamp !== "string") return null;
  // History producers use ISO dates. Date alone normalizes impossible days
  // (February 30 becomes March 2), which would invent a transcript date.
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})|)$/.exec(timestamp);
  if (!parts) return null;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}
function localDay(date) {
  return date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : "unknown";
}
function dayLabel(date, now) {
  if (!date) return "Date unavailable";
  if (localDay(date) === localDay(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return localDay(date) === localDay(yesterday) ? "Yesterday" : date.toLocaleDateString([], { dateStyle: "medium" });
}
// #201: conversations read as the user's messages, the agent's prose, approvals and receipts.
// Tool calls, tool results and subagent/peer chatter are hidden; while a turn runs, the header's
// one status line says in plain words what the agent is doing, derived here from the tool entries
// the history already carries (Coordinator: { role: "tool", name, summary }; Codex sessions:
// { role: "tool", text: "<itemType>: <command or tool> (<status>)" }) or from a session's
// current_tool. Sending an investigator, a subagent or a Lead stays visible as one compact line.
const STEP_PHRASES = {
  ToolSearch: "Getting ready…",
  Read: "Reading files…",
  Glob: "Searching the code…",
  Grep: "Searching the code…",
  LS: "Looking through files…",
  Bash: "Running a command…",
  BashOutput: "Checking a command…",
  Edit: "Editing files…",
  MultiEdit: "Editing files…",
  Write: "Editing files…",
  NotebookEdit: "Editing files…",
  WebFetch: "Reading a web page…",
  WebSearch: "Searching the web…",
  TodoWrite: "Planning the work…",
  ListAgents: "Checking running agents…",
  SendMessage: "Sending a message…",
  list_projects: "Checking your projects…",
  resolve_project: "Finding the project…",
  register_project: "Registering a project…",
  list_sessions: "Checking sessions…",
  list_models: "Checking available models…",
  session_tail: "Reading a session…",
  session_state: "Checking a session…",
  spawn_session: "Starting a worker…",
  stop_session: "Stopping a session…",
  memory_read: "Reading its memory…",
  memory_write: "Updating its memory…",
  memory_edit: "Updating its memory…",
  log_note: "Noting a decision…",
  send_message: "Sending a message…",
  request_update: "Asking for an update…",
  message_status: "Checking a message…",
  start_lead: "Starting a Lead…",
  retire_lead: "Retiring a Lead…",
  list_leads: "Checking the Leads…",
  read_handoff: "Reading a Lead's handoff…",
  write_handoff: "Writing a handoff…",
  list_workers: "Checking workers…",
  commandExecution: "Running a command…",
  fileChange: "Editing files…",
};
// A tool's phrase, or null. Own keys only: a tool named "constructor" or "toString" must not reach
// Object.prototype and render a function as the status line.
const stepPhraseFor = (name) => (typeof name === "string" && Object.hasOwn(STEP_PHRASES, name) ? STEP_PHRASES[name] : null);
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
// "mcp__fleet__list_projects", "fleet.list_projects" and "list_projects" name the same tool.
function baseToolName(name) {
  return String(name || "").trim().replace(/^mcp__.+?__/, "").replace(/^(fleet|leads|lead|peers)\./, "");
}
// Model-written text shown to the developer never carries paths or JSON.
function plainWords(text, max = 80) {
  const words = String(text || "")
    .replace(/[{}[\]"`]/g, " ")
    // Any token with a slash or backslash: absolute, relative and Windows paths, and URLs.
    .replace(/\S*[/\\]\S*/g, " ")
    // What JSON leaves behind: punctuation-only tokens, and space before punctuation.
    .replace(/(^|\s)[^\w\s#]+(?=\s|$)/g, " ")
    .replace(/\s+([:;,.])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.:;,]+|[\s.:;,…]+$/g, "");
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words;
}
// A tool entry as { name, detail }: Coordinator entries carry name and summary; Codex entries
// carry "<itemType>: <command or tool> (<status>)" as text.
function toolStep(entry) {
  if (entry.name) return { name: baseToolName(entry.name), detail: String(entry.summary ?? entry.text ?? "") };
  const text = String(entry.text || entry.summary || "");
  const match = /^(\w+):\s*([\s\S]*?)\s*(?:\((\w+)\))?$/.exec(text);
  if (!match) return { name: "", detail: text };
  if (["mcpToolCall", "dynamicToolCall"].includes(match[1])) return { name: baseToolName(match[2]), detail: "" };
  return { name: match[1], detail: match[2] };
}
function subagentParts(detail) {
  // server/pm.ts summarizes an Agent call as "<subagent_type>: <description>".
  const match = /^([\w-]+):\s*([\s\S]*)$/.exec(String(detail || ""));
  const type = match ? match[1] : "";
  return { who: type === "investigator" ? "an investigator" : "a subagent", description: plainWords(match ? match[2] : "") };
}
function stepPhrase({ name, detail }) {
  if (SUBAGENT_TOOLS.has(name)) {
    const { who, description } = subagentParts(detail);
    return description ? `Asking ${who}: ${description}…` : `Asking ${who}…`;
  }
  if (name === "ToolSearch") {
    // Loading tools names what comes next: {"query":"select:mcp__fleet__list_projects,…"}.
    const next = baseToolName(/select:([^,"\s}]+)/.exec(detail)?.[1]);
    if (next && next !== "ToolSearch" && stepPhraseFor(next)) return stepPhraseFor(next);
  }
  if (name === "Read" && /tool-results/.test(detail)) return "Reading the results…";
  if (name === "commandExecution" && /\b(test|tests|vitest|jest|pytest|playwright|typecheck)\b/.test(detail)) return "Running tests…";
  return stepPhraseFor(name) || "Working…";
}
// The one compact line for sending an investigator, a subagent, a Lead or a worker; null otherwise.
function dispatchLine({ name, detail }) {
  if (SUBAGENT_TOOLS.has(name)) {
    const { who, description } = subagentParts(detail);
    // The call is recorded before its permission check, so say what was asked, not that it ran.
    return `Asked for ${who}${description ? `: ${description}` : ""}`;
  }
  if (name === "start_lead") {
    // server/pm.ts summarizes start_lead as "<project> / <workstream>".
    const parts = String(detail).split(" / ").map((part) => plainWords(part, 40)).filter((part) => part && part !== "undefined");
    return parts.length ? `Asked to start Lead ${parts.join(" · ")}` : "Asked to start a Lead";
  }
  if (name === "spawn_session") return "Asked to start a worker";
  return null;
}
// What the agent is doing now: the latest tool step of the running turn, in plain words.
function workingPhrase(history, currentTool) {
  if (currentTool) return stepPhrase({ name: baseToolName(currentTool), detail: "" });
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.role === "user" || entry.role === "peer") break;
    if (entry.role === "tool") return stepPhrase(toolStep(entry));
  }
  return "Working…";
}
// Observed transcripts arrive as one "role (time): text" blob with [tool …] markers. Keep the
// prose; the markers become hidden steps. Other formats pass through unchanged.
const TOOL_MARKER = /\[tool result\]|\[tool [^\]\n]*\]/g;
function splitObservedTail(entry) {
  const steps = [];
  const records = String(entry.text || "")
    .split(/\n\n(?=(?:user|assistant) \([^)\n]*\): )/)
    .flatMap((record) => {
      const match = record.match(/^((user|assistant) \([^)\n]*\): )([\s\S]*)$/);
      const markers = match?.[3].match(TOOL_MARKER);
      if (!markers) return [record];
      steps.push({ id: `observed-step-${steps.length}`, role: "tool", text: `${match[2]} ${markers.join(" ")}`, at: entry.at });
      const prose = match[3].replace(TOOL_MARKER, "").replace(/[ \t]{2,}/g, " ").trim();
      return prose ? [match[1] + prose] : [];
    });
  return { entry: records.length ? { ...entry, text: records.join("\n\n") } : null, steps };
}
// Steps are a debugging aid: off by default, shown from the conversation menu. No per-turn chrome.
let showSteps = false, hiddenSteps = 0, shownHistory = [], shownReceipts = [];
function conversationEntries(history) {
  const out = [];
  let steps = 0;
  const step = (entry) => {
    steps++;
    if (showSteps) out.push({ ...entry, role: "step", stepRole: entry.role });
  };
  for (const entry of history) {
    if (entry.role === "system" && entry.id === "observed-tail") {
      const split = splitObservedTail(entry);
      if (split.entry) out.push(split.entry);
      split.steps.forEach(step);
    } else if (entry.role === "tool") {
      const line = dispatchLine(toolStep(entry));
      if (line) out.push({ ...entry, role: "dispatch", text: line, summary: undefined });
      else step(entry);
    } else if (entry.role === "peer") step(entry);
    else if (entry.role === "assistant" && !String(entry.text || "").trim()) continue;
    else out.push(entry);
  }
  hiddenSteps = steps;
  return out;
}
function dispatchNode(entry) {
  const line = node("p", "dispatch-line");
  const symbol = node("span", "dispatch-symbol", "↗");
  symbol.setAttribute("aria-hidden", "true");
  line.append(symbol, node("span", "dispatch-text", entry.text));
  return line;
}
function stepNode(entry) {
  const row = node("div", "step-line");
  const text = [entry.name, entry.text || entry.summary].filter(Boolean).join(" · ");
  row.append(
    node("span", "step-kind", entry.stepRole === "peer" ? "Message" : "Step"),
    node("span", "step-text", text.length > 600 ? `${text.slice(0, 600)}…` : text),
  );
  return row;
}
// server/pm.ts marks the "Coordinator moved" entry with `marker: "pm_moved"`. Hosts from before the
// marker are recognised by the entry's text.
const PM_MOVED_TEXT = /^(The (PM|Coordinator) now runs on |This machine is no longer the (PM|Coordinator) host)/;
const pmMovedEntry = (entry) => entry.marker === "pm_moved" || (entry.marker == null && PM_MOVED_TEXT.test(String(entry.text || "")));
function messageNode(entry, receipt, entryKey) {
  if (entry.role === "dispatch") return dispatchNode(entry);
  if (entry.role === "step") return stepNode(entry);
  const role = ["user", "assistant", "tool", "system"].includes(entry.role)
    ? entry.role
    : "system";
  const failed = role === "system" && entry.error === true;
  // server/pm.ts records this when the PM moves away from this machine; it explains why sends
  // here are refused, so it stands out from routine system lines.
  const moved = role === "system" && !failed && selected === "pm" && pmMovedEntry(entry);
  const article = node("article", `message ${role}${failed ? " error" : ""}${moved ? " pm-moved" : ""}`);
  if (failed) article.setAttribute("aria-label", failureLabel());
  if (moved) article.setAttribute("aria-label", "The Coordinator moved");
  const sender = sourceLabel(entry.source);
  const label = node(
    "div",
    "message-label",
    failed ? failureLabel() : moved ? "Coordinator moved" : sender
      ? `From ${sender}`
      : role === "user"
        ? "You"
        : role === "assistant"
          ? selected === "pm"
            ? "Coordinator"
            : detail?.session?.provider === "codex"
              ? "Codex"
              : "Claude"
          : role === "tool"
            ? "Activity"
            : "Session",
  );
  const date = entryDate(entry);
  if (date) {
    const time = node("time", "", date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    time.dateTime = date.toISOString();
    const description = date.toLocaleString([], { dateStyle: "full", timeStyle: "long" });
    time.setAttribute("aria-description", description);
    time.title = description;
    label.append(time);
  } else label.append(node("span", "timestamp-unavailable", "Time unavailable"));
  article.append(label);
  appendContent(article, entry.text || entry.summary || "", entryKey);
  // No permanent per-message chrome: copying a message is in its menu (long-press, right-click,
  // or Enter / the context-menu key while the message has focus).
  article.copyText = String(entry.text || entry.summary || "");
  article.tabIndex = 0;
  article.setAttribute("aria-description", "Press Enter for message options");
  // Its own click listener also marks it actionable to screen readers, so TalkBack's double-tap
  // activates it (see messageClick).
  article.addEventListener("click", messageClick);
  renderMessageReceipt(article, receipt);
  return article;
}
function renderMessageReceipt(article, receipt) {
  article.querySelector(".receipt")?.remove();
  if (receipt) {
    const status =
      {
        queued: "Queued",
        running: "Running",
        completed: "Completed",
        failed: "Failed",
        uncertain:
          "Delivery uncertain · Check the session before sending again",
      }[receipt.status] || receipt.status;
    const chip = node("div", `receipt receipt-chip ${["failed", "uncertain"].includes(receipt.status) ? receipt.status : ""}`);
    const symbol = node("span", "receipt-symbol", { queued: "◷", running: "↻", completed: "✓", failed: "!", uncertain: "?" }[receipt.status] || "·");
    symbol.setAttribute("aria-hidden", "true");
    chip.append(symbol, node("span", "receipt-label", status));
    if (receipt.error) chip.append(node("span", "receipt-error", ` · ${receipt.error}`));
    article.append(chip);
  }
}
function renderMessages(history = [], receipts = []) {
  // The observed-session API uses these system sentinels instead of readable history.
  // Match the exact host-owned shape so actual provider/message text is never hidden.
  if (detail?.session?.managed === false && history.length === 1 && history[0].id === "observed-tail" && history[0].role === "system"
    && ["(no transcript available)", "(transcript unavailable)", "(no transcript on disk)", "(no message records found)"].includes(history[0].text)) history = [];
  shownHistory = history; shownReceipts = receipts;
  const now = new Date();
  const signature = JSON.stringify([selected, history, receipts, localDay(now), hostChecked, host.online, sessionsLoaded, sessions.length, detail?.session?.capabilities?.message, showSteps]);
  if (signature === messageSignature) return;
  const wasNearBottom = stillPinned();
  const firstRender = !messageSignature;
  const oldTop = ui.timeline.scrollTop;
  const focusedCopy = ui.messages.contains(document.activeElement) ? document.activeElement : null;
  const focusEntry = focusedCopy?.closest("[data-entry-key]")?.dataset.entryKey;
  // A focused message (not a control inside it) keeps its focus across re-renders too.
  const focusCopy = focusedCopy?.classList.contains("message") ? "message" : focusedCopy?.dataset.copyKey;
  const viewportTop = ui.timeline.getBoundingClientRect().top;
  const anchors = timelineEntries.map((item) => ({ key: item.key, top: item.element.getBoundingClientRect().top - viewportTop, bottom: item.element.getBoundingClientRect().bottom - viewportTop }))
    .filter((item) => item.bottom > 0);
  messageSignature = signature;
  const fragment = document.createDocumentFragment(), used = new Set(), entries = [];
  for (const entry of conversationEntries(history)) {
    const receipt = entry.role === "user"
      ? receipts.find((r) => !used.has(r.id) && (r.id === entry.id || r.text === entry.text)) : null;
    if (receipt) used.add(receipt.id);
    entries.push({ entry, receipt });
  }
  for (const receipt of receipts) {
    if (!used.has(receipt.id)) entries.push({ entry: { ...receipt, role: "user" }, receipt });
  }
  const unmatched = new Set(timelineEntries);
  const textOf = (entry) => String(entry.text || entry.summary || "");
  const identityOf = ({ entry, receipt }) => entry.id || receipt?.id;
  const sameMetadata = (a, b) => a.role === b.role && (a.at || a.ts) === (b.at || b.ts) && JSON.stringify(a.source) === JSON.stringify(b.source);
  // IDs are authoritative when present. Provider history can omit IDs; match its
  // unchanged entries before matching a growing final entry, independent of indices.
  for (const item of entries) {
    const id = identityOf(item);
    const previous = [...unmatched].find((old) => id
      ? identityOf(old) === id
      : !identityOf(old) && sameMetadata(old.entry, item.entry) && textOf(old.entry) === textOf(item.entry));
    if (previous) { item.previous = previous; unmatched.delete(previous); }
  }
  let previousDay;
  for (const item of entries) {
    if (!item.previous && !identityOf(item)) {
      const previous = [...unmatched].find((old) => !identityOf(old) && sameMetadata(old.entry, item.entry)
        && textOf(item.entry).startsWith(textOf(old.entry)) && textOf(old.entry));
      if (previous) { item.previous = previous; unmatched.delete(previous); }
    }
    const previous = item.previous;
    if (!firstRender && !wasNearBottom && (!previous || textOf(previous.entry) !== textOf(item.entry))) newMessages = true;
    item.key = previous?.key || ++nextEntryKey;
    const contentSignature = JSON.stringify([item.entry.role, item.entry.text, item.entry.summary, item.entry.at, item.entry.ts, item.entry.source, item.entry.error === true, item.entry.marker]);
    const receiptSignature = JSON.stringify(item.receipt);
    item.element = previous?.contentSignature === contentSignature ? previous.element : messageNode(item.entry, item.receipt, item.key);
    if (item.element === previous?.element && previous.receiptSignature !== receiptSignature) renderMessageReceipt(item.element, item.receipt);
    item.contentSignature = contentSignature;
    item.receiptSignature = receiptSignature;
    item.element.dataset.entryKey = String(item.key);
    const date = entryDate(item.entry), day = localDay(date);
    if (day !== previousDay) {
      item.separator = previous?.separator || node("p", "date-separator");
      const label = dayLabel(date, now);
      if (item.separator.textContent !== label) item.separator.textContent = label;
      fragment.append(item.separator);
    }
    previousDay = day;
    delete item.previous;
    fragment.append(item.element);
  }
  timelineEntries = entries;
  if (!entries.length) {
    const loading = !hostChecked || (host.online && !sessionsLoaded && !selected);
    const title = loading ? "Loading sessions…" : !host.online ? `${hostName("The execution host")} is offline`
      : selected === "pm" ? "New conversation."
      : selected ? (detail?.session?.capabilities?.message ? "Ready when you are." : "No readable history yet.")
      : sessions.filter((s) => s.name !== PM_SESSION_NAME).length ? "Choose a conversation" : "No sessions yet";
    const text = loading ? "Checking your execution host for sessions."
      : !host.online ? `Reconnect ${hostName("the execution host")} to view sessions and continue work.`
      : selected === "pm" ? "The Coordinator remembers projects, decisions and Leads, not past chats."
      : selected ? (detail?.session?.capabilities?.message ? "Send a task or a follow-up to begin the conversation." : "No readable conversation is available yet. Activity will appear as this session runs.")
      : "Choose an existing conversation or start a Claude or Codex session.";
    fragment.append(emptyState(title, text, !selected && !loading));
  }
  ui.messages.replaceChildren(fragment);
  if (focusEntry && focusCopy) {
    const article = entries.find((item) => String(item.key) === focusEntry)?.element;
    if (focusCopy === "message") article?.focus({ preventScroll: true });
    else [...(article?.querySelectorAll("[data-copy-key]") || [])].find((button) => button.dataset.copyKey === focusCopy)?.focus({ preventScroll: true });
  }
  if (wasNearBottom || firstRender) { ui.timeline.scrollTop = ui.timeline.scrollHeight; pinnedToLatest = true; seenScrollTop = ui.timeline.scrollTop; }
  else {
    const anchor = anchors.find((old) => entries.some((item) => item.key === old.key));
    const element = anchor && entries.find((item) => item.key === anchor.key).element;
    ui.timeline.scrollTop = element ? ui.timeline.scrollTop + element.getBoundingClientRect().top - viewportTop - anchor.top : oldTop;
  }
  updateLatest();
}
function renderApprovals(approvals = []) {
  const outcome = selected !== "pm" ? launchOutcome(detail?.session) : "";
  const signature = JSON.stringify([selected, approvals, outcome]);
  if (signature === approvalSignature) {
    updateControls();
    return;
  }
  const wasNearBottom =
    ui.timeline.scrollHeight - ui.timeline.scrollTop - ui.timeline.clientHeight <
    100;
  // Preserve typed answers when a separate approval arrives or expires during polling.
  const oldAnswers = new Map(
    [...ui.approvals.querySelectorAll("[data-question-key]")].map((input) => [
      input.dataset.questionKey,
      input.value,
    ]),
  );
  const focused = ui.approvals.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.dataset.focusKey;
  const selectionStart = focused?.selectionStart, selectionEnd = focused?.selectionEnd;
  const expanded = new Set([...ui.approvals.querySelectorAll("details[open]")].map((el) => el.dataset.focusKey));
  approvalSignature = signature;
  ui.approvals.replaceChildren();
  for (const approval of approvals) {
    const sessionKey = selected;
    const feedbackKey = JSON.stringify([sessionKey, approval.id]);
    // A held agent launch (epic #157): nothing has run yet; approving launches it in Bypass.
    const launch = approval.kind === "permission" && approval.tool === LAUNCH_APPROVAL_TOOL;
    const form = node("form", `approval${launch ? " launch-approval" : ""}`);
    form.dataset.approvalKey = feedbackKey;
    form.append(
      node(
        "h3",
        "",
        launch
          ? "Launch with Bypass?"
          : approval.kind === "question"
          ? "The agent has a question"
          : approval.kind === "unsupported"
            ? "This request needs attention"
            : `Permission requested · ${approval.tool || "Tool"}`,
      ),
    );
    if (launch) form.append(launchDetails(approval.input || {}));
    else form.append(node("p", "approval-reason", approval.reason || (approval.kind === "question"
      ? "Your answer is needed before the agent can continue."
      : approval.kind === "unsupported" ? "This interaction cannot be answered here."
      : `The agent is requesting permission to use ${approval.tool || "this tool"}.`)));
    const context = launch ? null : approval.input?.command || approval.input?.file_path || approval.input?.path;
    if (typeof context === "string" && context) form.append(node("p", "approval-context", context.length > 180 ? `${context.slice(0, 180)}…` : context));
    if (!launch && approval.input && Object.keys(approval.input).length) {
      const details = node("details");
      details.dataset.focusKey = `${feedbackKey}:details`;
      details.open = expanded.has(details.dataset.focusKey);
      details.append(
        node("summary", "", "Show details"),
        node("pre", "", JSON.stringify(approval.input, null, 2)),
      );
      details.querySelector("summary").dataset.focusKey = `${feedbackKey}:summary`;
      form.append(details);
    }
    if (approval.kind === "unsupported") {
      form.append(
        node(
          "p",
          "",
          "Foreman cannot answer this request yet. Interrupt the session, then ask the agent to continue without this interaction.",
        ),
      );
      ui.approvals.append(form);
      continue;
    }
    const answerInputs = [];
    for (const question of approval.questions || []) {
      const label = node("label", "", question.question);
      const input = node(question.options?.length ? "select" : "input");
      input.required = true;
      if (question.options?.length) {
        const placeholder = node("option", "", "Choose an answer…");
        placeholder.value = "";
        input.append(placeholder);
        for (const value of question.options) {
          const option = node("option", "", value);
          option.value = value;
          input.append(option);
        }
      }
      input.dataset.questionKey = `${approval.id}:${question.id}`;
      input.dataset.focusKey = `${feedbackKey}:question:${question.id}`;
      input.value = oldAnswers.get(input.dataset.questionKey) || "";
      label.append(input);
      form.append(label);
      answerInputs.push([question.id, input]);
    }
    const actions = node("div", "approval-actions");
    const allowLabel = launch ? "Launch with Bypass" : approval.kind === "question" ? "Send answer" : "Allow once";
    const allow = node("button", launch ? "btn bypass-action" : "btn", allowLabel);
    allow.type = "submit";
    allow.dataset.focusKey = `${feedbackKey}:allow`;
    const deny = node(
      "button",
      "btn ghost",
      approval.kind === "question" ? "Decline" : "Deny",
    );
    deny.type = "button";
    deny.dataset.focusKey = `${feedbackKey}:deny`;
    actions.append(allow, deny);
    form.append(actions);
    const feedback = node("p", "form-error");
    feedback.setAttribute("role", "alert");
    form.append(feedback);
    const syncFeedback = () => {
      const state = approvalFeedback.get(feedbackKey);
      form.dataset.busy = String(!!state?.pending);
      allow.textContent = state?.pending === "allow"
        ? (launch ? "Launching…" : approval.kind === "question" ? "Sending answer…" : "Allowing…")
        : allowLabel;
      deny.textContent = state?.pending === "deny"
        ? (approval.kind === "question" ? "Declining…" : "Denying…")
        : (approval.kind === "question" ? "Decline" : "Deny");
      feedback.textContent = state?.error || "";
      feedback.hidden = !state?.error;
    };
    form.syncFeedback = syncFeedback;
    syncFeedback();
    const syncCurrentFeedback = () => {
      [...ui.approvals.querySelectorAll("form")].find((current) => current.dataset.approvalKey === feedbackKey)?.syncFeedback?.();
      updateControls();
    };
    const respond = async (decision) => {
      if (approvalFeedback.get(feedbackKey)?.pending || !host.online) return;
      const epoch = authEpoch;
      approvalFeedback.set(feedbackKey, { pending: decision });
      syncCurrentFeedback();
      clearError();
      let accepted = false;
      try {
        const answers = Object.fromEntries(
          answerInputs.map(([id, input]) => [id, input.value]),
        );
        await post("/api/session/approval", {
          id: sessionKey,
          approval_id: approval.id,
          decision,
          ...(approval.kind === "question" && decision === "allow"
            ? { answers }
            : {}),
        });
        if (epoch !== authEpoch || !authorized) return;
        accepted = true;
        [...ui.approvals.querySelectorAll("form")].find((current) => current.dataset.approvalKey === feedbackKey)?.remove();
        approvalFeedback.delete(feedbackKey);
        approvalSignature = "";
        await refreshSelected();
      } catch (error) {
        if (epoch !== authEpoch || !authorized) return;
        if (accepted) showError(`Your response was accepted, but the conversation could not refresh. ${errorMessage(error)}`);
        else {
          approvalFeedback.set(feedbackKey, { error: errorMessage(error) });
          syncCurrentFeedback();
          approvalSignature = "";
          await refreshSelected().catch(() => {});
        }
      } finally {
        if (epoch === authEpoch && authorized) {
          syncCurrentFeedback();
          if (selected === sessionKey && document.activeElement === document.body && !ui.dialog.open && !ui.app.classList.contains("nav-open")) {
            const focusTarget = accepted ? ui.input : [...ui.approvals.querySelectorAll("[data-focus-key]")].find((el) => el.dataset.focusKey === `${feedbackKey}:${decision}`);
            if (focusTarget && !focusTarget.disabled) focusTarget.focus({ preventScroll: true });
          }
        }
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (form.reportValidity()) respond("allow");
    });
    deny.addEventListener("click", () => respond("deny"));
    ui.approvals.append(form);
  }
  if (outcome) {
    const note = node("p", "launch-outcome", outcome);
    note.setAttribute("role", "status");
    ui.approvals.append(note);
  }
  updateControls();
  if (focusKey) {
    const next = [...ui.approvals.querySelectorAll("[data-focus-key]")].find((el) => el.dataset.focusKey === focusKey);
    next?.focus({ preventScroll: true });
    if (next?.setSelectionRange && selectionStart != null) next.setSelectionRange(selectionStart, selectionEnd);
  }
  if (approvals.length && wasNearBottom)
    ui.timeline.scrollTop = ui.timeline.scrollHeight;
  updateLatest();
}
// The "Launch with Bypass" card: who asked, for what, and with which setup.
function launchDetails(input) {
  const text = (value) => (typeof value === "string" && value.trim() ? value : "");
  const fields = [
    ["Session", text(input.name) || "Unnamed session"],
    ["Project", text(input.project) || "Unregistered directory"],
    ["Directory", text(input.cwd)],
    ["Agent", [input.provider === "codex" ? "Codex" : "Claude", text(input.model), text(input.effort)].filter(Boolean).join(" · ")],
    ["Role", input.role === "lead" ? "Project Lead" : input.role === "worker" ? "Worker" : text(input.role)],
    ["Requested by", capitalize(requesterName(input.requested_by))],
  ].filter(([, value]) => value);
  const box = node("div", "launch-details");
  box.append(node("p", "approval-reason", "Nothing has run yet. Approving starts this session in ⚠ Bypass: commands, network, credentials and files outside the project, with no permission prompts."));
  const list = node("dl", "header-metadata");
  for (const [label, value] of fields) list.append(node("dt", "", label), node("dd", "", value));
  box.append(list, node("p", "launch-task-label", "First task"), node("p", "launch-task", text(input.first_task) || "No first task given."));
  return box;
}
// `record` is false when the history entry already exists (Back/Forward).
async function selectSession(key, record = true) {
  if (selected) setDraft(selected, ui.input.value);
  if (key !== selected) showSteps = false; // the debug steps belong to one chat
  selected = key;
  deepLinkPending = null;
  hideNotice();
  closeMenus();
  if (record) recordView(key);
  selectionEpoch++;
  const epoch = selectionEpoch;
  detail = null;
  pmBusy = false;
  pmModelReady = false;
  messageSignature = "";
  shownHistory = []; shownReceipts = []; hiddenSteps = 0;
  resetLatest();
  approvalSignature = "";
  ui.input.value = drafts.get(key) || "";
  autosize();
  clearError();
  // The banner was just cleared, so the next PM read must raise a still-present error again.
  polledPmError = null;
  showConversationLoading();
  ui.approvals.replaceChildren();
  renderRail();
  renderPmHost();
  renderHeading();
  const returnFocus = ui.app.classList.contains("nav-open") && window.matchMedia("(max-width: 760px)").matches;
  setNav(false);
  if (returnFocus) {
    ui.title.tabIndex = -1;
    ui.title.focus({ preventScroll: true });
  }
  // Before the first /api/host answer the host is not known to be offline: it is still opening.
  if (hostChecked && !host.online) showConversationLoading(`Conversation unavailable while ${hostName("the execution host")} is offline. It will open when it reconnects.`, true);
  try {
    await refreshSelected();
  } catch (error) {
    if (epoch === selectionEpoch) showRefreshError(error);
  }
}
// Return to the PM home view (Back from a conversation, or an unknown deep link). The history
// entry is already correct, or the caller records it.
function showInbox() {
  void selectSession("pm", false);
}
// The deep-linked session is not on this host: fall back to the PM with a neutral notice.
// Its entry is marked rejected before Back leaves it, so Forward repeats this fallback.
function rejectDeepLink() {
  const key = selected;
  showInbox();
  markRejected(key);
  recordView(null);
  showNotice(UNKNOWN_LINK_NOTICE);
}
// Marks the conversation's entry rejected, and any overlay entry (the drawer, a dialog) that was
// open above it: Back steps off those first, so each is marked on the way down.
function markRejected(key, budget = 3) {
  afterHistory(() => {
    const state = history.state;
    if (!state?.foreman || state.view !== key) return;
    if (!state.rejected) history.replaceState({ ...state, rejected: true }, "", location.href);
    if (state.overlay && budget > 0) {
      historyBack();
      markRejected(key, budget - 1);
    }
  });
}
// A rejected link the host now lists: its entries open normally again.
function clearRejected(key) {
  afterHistory(() => {
    const state = history.state;
    if (state?.foreman && state.view === key && state.rejected) {
      const { rejected, ...rest } = state;
      history.replaceState(rest, "", location.href);
    }
  });
}
let polledPmError = null;
async function refreshSelected() {
  if (!selected || !authorized || !host.online) return;
  const key = selected,
    epoch = selectionEpoch,
    loginEpoch = authEpoch, revision = modelRevision;
  const result = await api(
    key === "pm"
      ? "/api/pm/history"
      : `/api/session?id=${encodeURIComponent(key)}`,
  );
  if (
    key !== selected ||
    epoch !== selectionEpoch ||
    loginEpoch !== authEpoch ||
    !authorized
  )
    return;
  conversationLoading = false;
  if (key === "pm") {
    pmBusy = !!result.busy;
    if (result.error) {
      if (result.error !== polledPmError) showError(result.error);
    } else if (polledPmError) clearError();
    polledPmError = result.error || null;
    setPmRailError(polledPmError);
    pmModelReady = true;
    if (!pmModelSaving && revision === modelRevision) {
      pmModel = result.model || "";
      retainModel($("#pm-model"), pmModel);
    }
    if (!pmModelLoaded) void loadPmModels();
    renderMessages(result.history || [], []);
    renderApprovals([]);
  } else {
    detail = result;
    renderMessages(result.history || [], result.receipts || []);
    renderApprovals(result.approvals || []);
  }
  renderHeading();
}
// A persisted PM failure (history entry `{ role: "system", error: true }`).
function failureLabel() {
  return selected === "pm" ? "Coordinator error" : "Error";
}
// Rail indicator for a PM failure, fed by the full history while the PM is
// selected and by the lightweight summary read otherwise.
let pmRailError = null;
function setPmRailError(error) {
  pmRailError = error || null;
  const row = $("#select-pm");
  let alert = row.querySelector(".pm-alert");
  if (pmRailError && !alert) {
    alert = node("span", "pm-alert");
    const dot = node("span", "pm-alert-dot", "!");
    dot.setAttribute("aria-hidden", "true");
    alert.append(dot, node("span", "sr-only", "Coordinator has an error"));
    // Sit before the PINNED tag when the row has one; otherwise stay visible at the end.
    const pinned = row.querySelector(".pinned");
    if (pinned) pinned.before(alert);
    else row.append(alert);
  } else if (!pmRailError) alert?.remove();
  row.classList.toggle("has-error", !!pmRailError);
  if (pmRailError) {
    row.setAttribute("aria-label", "Coordinator, has an error");
    row.title = `Coordinator error: ${pmRailError}`;
  } else {
    row.removeAttribute("aria-label");
    row.removeAttribute("title");
  }
}
async function refreshPmSummary(epoch) {
  if (selected === "pm" || !authorized || !host.online) return;
  const selection = selectionEpoch;
  try {
    const result = await api("/api/pm/history?summary=1");
    if (!authorized || epoch !== authEpoch || selection !== selectionEpoch || selected === "pm") return;
    setPmRailError(result.error);
  } catch {
    /* Keep the last known indicator; the next poll retries. */
  }
}
// PM machine (epic #26 PMM-06). Plain-JS mirror of PmHostResponse / PmHostMoveResponse in
// shared/pm-state.ts; web/ is static and cannot import it.
const PM_MODEL_HINT = "Changes apply to the next turn and are saved with the Coordinator.";
const PLATFORM_LABEL = { darwin: "macOS", linux: "Linux", win32: "Windows", freebsd: "FreeBSD" };
function pmHostOfflineMessage(name) {
  return `Your Coordinator's machine (${name}) is offline.`;
}
function readPmHostActive(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.machine_id !== "string" || typeof raw.name !== "string") return null;
  return { machine_id: raw.machine_id, name: raw.name || "Unnamed machine", online: raw.online === true,
    epoch: Number.isSafeInteger(raw.epoch) ? raw.epoch : 0, assigned_at: raw.assigned_at, assigned_by: raw.assigned_by };
}
function readPmHost(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.machines)) return null;
  const machines = raw.machines
    .filter((m) => m && typeof m === "object" && typeof m.machine_id === "string")
    .map((m) => ({ machine_id: m.machine_id, name: typeof m.name === "string" && m.name ? m.name : "Unnamed machine",
      platform: typeof m.platform === "string" ? m.platform : "", online: m.online === true,
      last_seen: typeof m.last_seen === "number" ? m.last_seen : null, active: m.active === true }));
  return { active: readPmHostActive(raw.active), machines, mode: raw.mode === "local" ? "local" : "relay" };
}
// Move needs the relay, a current assignment, and another machine that is online.
function moveTargets() {
  if (!pmHost || pmHost.mode === "local" || !pmHost.active) return [];
  return pmHost.machines.filter((m) => m.online && !m.active && m.machine_id !== pmHost.active.machine_id);
}
function lastSeenText(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "Last seen: unknown";
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  return seconds < 60 ? "Last seen just now"
    : seconds < 3600 ? `Last seen ${Math.floor(seconds / 60)} min ago`
    : seconds < 86400 ? `Last seen ${Math.floor(seconds / 3600)} h ago`
    : `Last seen ${Math.floor(seconds / 86400)} d ago`;
}
// A relay-mode daemon's local UI (localhost) gets 404 from /api/pm/host: only the relay knows every
// machine and whether it is online. Its body carries what this machine does know (server/main.ts
// pmHost()): whether it is connected, whether it runs the PM, and the active machine's name.
function readPmHostView(raw) {
  const view = raw?.view;
  if (!view || typeof view !== "object" || view.mode !== "relay") return null;
  const name = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return { connected: view.connected === true, thisActive: view.this_machine_active === true,
    activeName: name(view.active_machine?.host), thisName: name(view.this_machine?.name) };
}
function pmHostViewLabel(view) {
  const details = "Coordinator machine details are in the hosted app";
  if (view.thisActive) return `Coordinator on ${view.activeName || view.thisName || "this machine"} (this machine) · ${details}`;
  if (view.connected && view.activeName) return `Coordinator on ${view.activeName} · ${details}`;
  if (!view.connected) return `${view.thisName || "This machine"} isn’t connected to the cloud relay · ${details}`;
  return details;
}
function renderPmHost() {
  const bar = $("#pm-host"), active = pmHost?.active || null;
  const view = pmHost ? null : pmHostView;
  // Until the first answer the PM view holds the line's place with a placeholder.
  bar.hidden = selected !== "pm" || !authorized || (pmHostChecked && !pmHost && !view);
  bar.setAttribute("aria-busy", String(!pmHostChecked));
  const offline = !!active && !active.online;
  const label = !pmHostChecked ? "Checking which machine runs the Coordinator…"
    : pmHost ? (active ? `Coordinator on ${active.name} · ${active.online ? "online" : "offline"}` : "No machine runs the Coordinator yet")
    : view ? pmHostViewLabel(view) : "";
  if ($("#pm-host-label").textContent !== label) $("#pm-host-label").textContent = label;
  $("#pm-host-dot").className = `dot ${active?.online || view?.thisActive ? "online" : active ? "offline" : "unknown"}`;
  const offlineText = offline ? pmHostOfflineMessage(active.name) : "";
  const offlineLine = $("#pm-host-offline");
  if (offlineLine.textContent !== offlineText) offlineLine.textContent = offlineText;
  // The offline warning is status, not configuration: it stays in the PM conversation view as a
  // banner. The machine line and Move PM live on the info screen.
  offlineLine.hidden = !offlineText || selected !== "pm" || !authorized;
  bar.classList.toggle("is-offline", offline);
  $("#move-pm").hidden = !moveTargets().length;
  if (ui.moveDialog.open) renderMoveList();
  renderConnectionBanner();
}
async function refreshPmHost(epoch) {
  try {
    const result = await api("/api/pm/host");
    if (!authorized || epoch !== authEpoch) return;
    pmHost = readPmHost(result);
    pmHostView = null;
  } catch (error) {
    if (!authorized || epoch !== authEpoch) return;
    // A host or relay without the route shows no PM machine (a relay-mode daemon's own view
    // instead, when it gives one); other failures keep the last answer.
    if (error?.status === 404) { pmHost = null; pmHostView = readPmHostView(error.body); }
  }
  pmHostChecked = true;
  renderPmHost();
}
let moveOpener = null, moveBusy = false, moveEpoch = 0, moveChoice = null, moveSignature = "";
function moveError(text = "") {
  const target = $("#move-pm-error");
  target.textContent = text;
  target.hidden = !text;
}
function updateMoveControls() {
  const confirm = $("#confirm-move-pm");
  const valid = !!moveChoice && moveTargets().some((m) => m.machine_id === moveChoice);
  confirm.disabled = moveBusy || !valid || !authorized;
  confirm.textContent = moveBusy ? "Moving…" : "Move Coordinator";
  $("#move-pm-form").setAttribute("aria-busy", String(moveBusy));
}
function renderMoveList() {
  const list = $("#move-pm-list");
  const machines = [...(pmHost?.machines || [])].sort((a, b) =>
    Number(b.active) - Number(a.active) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const selectable = new Set(moveTargets().map((m) => m.machine_id));
  if (moveChoice && !selectable.has(moveChoice)) moveChoice = null;
  const rows = machines.map((m) => ({
    id: m.machine_id, name: m.name, active: m.active, online: m.online, enabled: selectable.has(m.machine_id),
    // The relay writes last_seen at most once a minute, so an online machine can read "Last seen
    // 1 min ago". It is shown only for a machine that is offline, where it says something.
    meta: [PLATFORM_LABEL[m.platform] || m.platform || "Unknown platform", m.online ? "Online" : "Offline", m.online ? "" : lastSeenText(m.last_seen)].filter(Boolean).join(" · "),
    note: m.active ? "Runs the Coordinator now" : !m.online ? "Offline machines can’t take the Coordinator" : "",
    seen: m.last_seen,
  }));
  moveEpoch = pmHost?.active?.epoch ?? 0;
  const signature = JSON.stringify([rows.map(({ seen, ...row }) => row), moveChoice, pmHost?.mode, moveEpoch]);
  if (signature !== moveSignature) {
    moveSignature = signature;
    const focused = list.contains(document.activeElement) ? document.activeElement.value : null;
    list.replaceChildren();
    for (const row of rows) {
      const label = node("label", `machine-choice${row.enabled ? "" : " is-disabled"}${row.active ? " is-active" : ""}`);
      const input = node("input");
      input.type = "radio";
      input.name = "pm-machine";
      input.value = row.id;
      input.disabled = !row.enabled;
      input.checked = row.id === moveChoice;
      const text = node("span", "machine-text");
      const name = node("span", "machine-name", row.name);
      const dot = node("span", `dot ${row.online ? "online" : "offline"}`);
      dot.setAttribute("aria-hidden", "true");
      name.prepend(dot);
      const meta = node("span", "machine-meta", row.meta);
      if (!row.online && typeof row.seen === "number" && row.seen > 0) meta.title = new Date(row.seen).toLocaleString();
      text.append(name, meta);
      if (row.note) text.append(node("span", "machine-note", row.note));
      label.append(input, text);
      list.append(label);
    }
    if (!rows.length) list.append(node("p", "field-hint", "No machines have connected to the relay yet."));
    else if (!selectable.size) list.append(node("p", "field-hint", pmHost?.mode === "local"
      ? "This Foreman runs without the cloud relay, so the Coordinator stays on this machine."
      : "No other machine is online. Start Foreman on another machine to move the Coordinator there."));
    if (focused !== null) {
      const same = [...list.querySelectorAll("input")].find((input) => input.value === focused && !input.disabled);
      (same || list.querySelector("input:not(:disabled)") || $("#close-move-pm")).focus({ preventScroll: true });
    }
  }
  updateMoveControls();
}
function openMovePm(event) {
  if (!authorized || !moveTargets().length || ui.moveDialog.open) return;
  moveOpener = event?.currentTarget || document.activeElement;
  moveChoice = null;
  moveSignature = "";
  moveError();
  renderMoveList();
  showDialog(ui.moveDialog);
  pushOverlay("move", () => ui.moveDialog.open);
  (ui.moveDialog.querySelector("#move-pm-list input:not(:disabled)") || $("#close-move-pm")).focus();
}
$("#move-pm").addEventListener("click", openMovePm);
for (const selector of ["#close-move-pm", "#cancel-move-pm"])
  $(selector).addEventListener("click", () => ui.moveDialog.close());
// A dialog's close event is queued, not fired by close() itself, so a quick close and reopen
// (Escape, then Enter on the still-focused Move button) can deliver the first close after the
// second opening. That late event must not undo the new opening: pop its history entry, clear
// its choice, or drop its opener (which sent focus to the info screen instead, #189). Each
// dialog's close handler returns early while its dialog is open again.
// Close, reopen and close again before either event fires delivers two close events for one
// closed dialog: only the first is handled, or the second finds the opener already used and
// sends focus elsewhere (#197). `showDialog` arms one handling per opening.
function showDialog(dialog) {
  dialog.showModal();
  dialog.closeHandled = false;
}
// True when this close event must be ignored: the dialog is open again, or this opening's close
// was already handled.
function staleClose(dialog) {
  if (dialog.open || dialog.closeHandled) return true;
  dialog.closeHandled = true;
  return false;
}
ui.moveDialog.addEventListener("close", () => {
  if (staleClose(ui.moveDialog)) return;
  popOverlay("move");
  moveChoice = null;
  moveError();
  if (!authorized) return;
  const opener = moveOpener;
  moveOpener = null;
  // Back to the Move button, or, when the button has gone away, to the info screen it was
  // opened from (or the conversation).
  if (opener?.isConnected && !opener.hidden && !opener.closest("[hidden], [inert]")) opener.focus({ preventScroll: true });
  else if (ui.infoDialog.open) $("#close-info").focus({ preventScroll: true });
  else ui.timeline.focus({ preventScroll: true });
});
// Keep Tab and Shift+Tab inside the modal dialog (a radio group is one Tab stop).
ui.moveDialog.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const checked = ui.moveDialog.querySelector('input[name="pm-machine"]:checked');
  const focusable = [...ui.moveDialog.querySelectorAll("button, input, select, textarea, [href], [tabindex]:not([tabindex='-1'])")]
    .filter((el) => !el.disabled && !el.closest("[hidden]") && el.getClientRects().length
      && (el.type !== "radio" || (checked ? el === checked : el === ui.moveDialog.querySelector('input[name="pm-machine"]:not(:disabled)'))));
  if (!focusable.length) return;
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || !ui.moveDialog.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !ui.moveDialog.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
});
$("#move-pm-list").addEventListener("change", (event) => {
  if (event.target?.name !== "pm-machine") return;
  moveChoice = event.target.value;
  moveError();
  updateMoveControls();
});
$("#move-pm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = moveTargets().find((m) => m.machine_id === moveChoice);
  if (moveBusy || !authorized || !target) return;
  const epoch = authEpoch;
  moveBusy = true;
  moveError();
  updateMoveControls();
  try {
    const result = await post("/api/pm/host", { machine_id: target.machine_id, expected_epoch: moveEpoch });
    if (epoch !== authEpoch || !authorized) return;
    const active = readPmHostActive(result?.active)
      || { ...target, online: true, epoch: Number.isSafeInteger(result?.epoch) ? result.epoch : moveEpoch + 1 };
    pmHost = { ...pmHost, active, machines: pmHost.machines.map((m) => ({ ...m, active: m.machine_id === active.machine_id })) };
    moveBusy = false;
    ui.moveDialog.close();
    renderPmHost();
    if (selected === "pm") renderHeading();
    showNotice(`The Coordinator now runs on ${active.name}. It starts a new conversation with the same memory.`);
    void poll();
  } catch (error) {
    if (epoch !== authEpoch || !authorized) return;
    moveBusy = false;
    moveError(errorMessage(error));
    // The server's view changed (the PM moved, or the machine went offline or away): show it.
    if (error?.status === 409 || error?.status === 404) {
      try {
        const latest = await api("/api/pm/host");
        if (epoch === authEpoch && authorized) pmHost = readPmHost(latest);
      } catch { /* The next poll refreshes the list. */ }
      if (epoch === authEpoch && authorized) renderPmHost();
    }
  } finally {
    if (epoch === authEpoch) {
      moveBusy = false;
      if (ui.moveDialog.open) {
        updateMoveControls();
        if (!ui.moveDialog.contains(document.activeElement) || document.activeElement?.disabled)
          (ui.moveDialog.querySelector("#move-pm-list input:checked:not(:disabled)")
            || ui.moveDialog.querySelector("#move-pm-list input:not(:disabled)") || $("#cancel-move-pm")).focus({ preventScroll: true });
      }
    }
  }
});
// Info screen (like a messaging app's contact info): the model and its picker, the PM's machine
// and Move PM, the session's project, directory and permissions, and the control note.
let infoOpener = null;
function openInfo(event) {
  if (ui.infoDialog.open || !authorized) return;
  closeMenus();
  const opener = event?.currentTarget;
  infoOpener = opener && opener !== $("#open-info") && opener.matches?.("button") ? opener : $("#conversation-menu-button");
  renderHeading();
  showDialog(ui.infoDialog);
  pushOverlay("info", () => ui.infoDialog.open);
  $("#close-info").focus();
  // The Coordinator's info summarizes the settings it launches Leads with.
  if (selected === "pm") void loadSettings();
}
$("#open-info").addEventListener("click", openInfo);
$("#close-info").addEventListener("click", () => ui.infoDialog.close());
ui.infoDialog.addEventListener("close", () => {
  if (staleClose(ui.infoDialog)) return; // A late close event (see the Move dialog's).
  popOverlay("info");
  if (!authorized) return;
  const opener = infoOpener;
  infoOpener = null;
  if (opener?.isConnected && !opener.closest("[hidden], [inert]")) opener.focus({ preventScroll: true });
});
// Tapping the conversation's name opens its info, as in a messaging app. Keyboard and screen
// reader users reach the same screen through the overflow menu.
$("#conversation-heading").addEventListener("click", (event) => { if (selected) openInfo(event); });

// Settings (epic #157): GET /api/settings and POST /api/settings `{ key, value, version }`, one key
// per change. The hosted app may write them (`writable: true`); the local UI shows them read-only.
// Grants are only ever written from here, by the developer: no agent tool or host channel can.
function readSettingsView(raw) {
  if (!raw || typeof raw !== "object" || !raw.settings || typeof raw.settings !== "object") return null;
  const settings = raw.settings;
  const roles = settings.roles && typeof settings.roles === "object" ? settings.roles : {};
  const grants = Array.isArray(settings.bypass_grants)
    ? settings.bypass_grants.filter((g) => g && ["coordinator", "lead"].includes(g.role) && typeof g.project === "string" && typeof g.allow === "boolean")
    : DEFAULT_BYPASS_GRANTS.map((g) => ({ ...g }));
  const versions = raw.versions && typeof raw.versions === "object" ? raw.versions : {};
  return {
    settings: { roles, bypass_grants: grants, bypass_ask: settings.bypass_ask === true },
    versions: { roles: versions.roles | 0, bypass_grants: versions.bypass_grants | 0, bypass_ask: versions.bypass_ask | 0 },
    writable: raw.writable === true,
  };
}
function settingsNotice(text, error = false) {
  const status = $("#settings-status");
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle("error", error);
}
async function loadSettings() {
  if (!authorized) return;
  const request = ++settingsRequest, epoch = authEpoch;
  settingsLoading = true;
  renderSettings();
  renderCoordinatorSettings();
  try {
    const view = readSettingsView(await api("/api/settings"));
    if (request !== settingsRequest || epoch !== authEpoch || !authorized) return;
    if (!view) throw new Error("The settings could not be read.");
    settingsView = view;
    settingsError = "";
  } catch (error) {
    if (request !== settingsRequest || epoch !== authEpoch || !authorized) return;
    settingsError = error?.status === 404 ? "this host or relay doesn’t serve settings yet." : errorMessage(error);
  } finally {
    if (request === settingsRequest && epoch === authEpoch) {
      settingsLoading = false;
      renderSettings();
      renderCoordinatorSettings();
    }
  }
}
let settingsModels = [], settingsModelsLoaded = false;
async function loadSettingsModels() {
  const epoch = authEpoch;
  try {
    const result = await api("/api/models?provider=claude");
    if (epoch !== authEpoch || !authorized) return;
    settingsModels = Array.isArray(result?.models) ? result.models : [];
    settingsModelsLoaded = true;
    renderSettings(true);
  } catch { /* The selects keep the defaults and the saved values; reopening retries. */ }
}
function settingOptions(select, options, value) {
  const signature = JSON.stringify([options, value]);
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;
  select.replaceChildren(...options.map(([optionValue, label]) => new Option(label, optionValue)));
  if (value && !options.some(([optionValue]) => optionValue === value)) select.add(new Option(value, value));
  select.value = value || "";
}
function renderSettings(force = false) {
  const view = settingsView;
  const writable = !!view?.writable;
  $("#settings-fields").disabled = !view || !writable || settingsBusy || !authorized;
  if (!ui.settingsDialog.open && !force) return;
  if (!view) settingsNotice(settingsLoading ? "Loading settings…" : settingsError ? `Settings are unavailable: ${settingsError}` : "", !!settingsError && !settingsLoading);
  else if (!writable) settingsNotice("Read-only here. Change settings from the hosted app.");
  else if (settingsBusy) settingsNotice("Saving…");
  // While a change saves, the controls keep what the developer just chose; the answer (or, on a
  // failure, the re-read settings) is shown once it arrives.
  if (settingsBusy) return;
  const settings = view?.settings || { roles: {}, bypass_grants: DEFAULT_BYPASS_GRANTS, bypass_ask: false };
  for (const select of ui.settingsDialog.querySelectorAll("select[data-role]")) {
    const { role, field } = select.dataset;
    const current = settings.roles?.[role]?.[field] || "";
    const fallback = `Default (${ROLE_DEFAULTS[role][field]})`;
    const options = field === "effort"
      ? [["", fallback], ...EFFORTS.map((effort) => [effort, effort])]
      : [["", fallback], ...settingsModels.filter((m) => typeof m?.value === "string").map((m) => [m.value, m.displayName || m.value])];
    settingOptions(select, options, current);
  }
  const grants = settings.bypass_grants || [];
  for (const box of ui.settingsDialog.querySelectorAll("input[data-grant-role]"))
    box.checked = !!grants.find((g) => g.role === box.dataset.grantRole && g.project === "*")?.allow;
  $("#bypass-ask").checked = settings.bypass_ask === true;
  const list = $("#grant-override-list");
  const overrides = grants.filter((g) => g.project !== "*");
  const signature = JSON.stringify(overrides);
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.replaceChildren();
    for (const grant of overrides) {
      const item = node("li", "grant-override");
      const who = grant.role === "coordinator" ? "Leads the Coordinator starts" : "Workers that Leads start";
      item.append(node("span", "", `${grant.project} · ${who} · ${grant.allow ? "⚠ Bypass" : "Auto (Bypass off)"}`));
      const remove = node("button", "btn ghost small", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove the ${grant.project} override for ${who.toLowerCase()}`);
      // Built from the settings as they are at click time, never from the list drawn earlier: a
      // stale copy would re-post grants changed since (e.g. turn a role's Bypass back on).
      const { role, project } = grant;
      remove.addEventListener("click", () => {
        const current = settingsView?.settings.bypass_grants || [];
        void saveSetting("bypass_grants", current.filter((g) => !(g.role === role && g.project.toLowerCase() === project.toLowerCase())));
      });
      item.append(remove);
      list.append(item);
    }
    if (!overrides.length) list.append(node("li", "field-hint", "None. Every project follows the settings above."));
  }
}
async function saveSetting(key, value) {
  if (!settingsView?.writable || settingsBusy || !authorized) return;
  const epoch = authEpoch;
  // A read still in flight predates this write; its answer must not replace the saved view.
  settingsRequest++;
  settingsLoading = false;
  settingsBusy = true;
  renderSettings();
  let saved = false;
  try {
    const view = readSettingsView(await post("/api/settings", { key, value, version: settingsView.versions[key] }));
    if (epoch !== authEpoch || !authorized) return;
    if (view) settingsView = { ...view, writable: true };
    saved = true;
    settingsNotice("Saved.");
  } catch (error) {
    if (epoch !== authEpoch || !authorized) return;
    const conflict = error?.status === 409;
    settingsBusy = false;
    await loadSettings();
    settingsNotice(conflict ? "These settings changed somewhere else. The latest values are shown; make your change again." : `Could not save. ${errorMessage(error)}`, true);
  } finally {
    if (epoch === authEpoch) {
      settingsBusy = false;
      renderSettings();
      if (saved) settingsNotice("Saved.");
      renderCoordinatorSettings();
    }
  }
}
for (const select of ui.settingsDialog.querySelectorAll("select[data-role]"))
  select.addEventListener("change", () => {
    const { role, field } = select.dataset;
    const roles = structuredClone(settingsView?.settings.roles || {});
    const entry = { ...(roles[role] || {}) };
    if (select.value) entry[field] = select.value;
    else delete entry[field];
    roles[role] = entry;
    void saveSetting("roles", roles);
  });
for (const box of ui.settingsDialog.querySelectorAll("input[data-grant-role]"))
  box.addEventListener("change", () => {
    const grants = (settingsView?.settings.bypass_grants || []).filter((g) => !(g.role === box.dataset.grantRole && g.project === "*"));
    grants.unshift({ role: box.dataset.grantRole, project: "*", allow: box.checked });
    void saveSetting("bypass_grants", grants);
  });
$("#bypass-ask").addEventListener("change", () => void saveSetting("bypass_ask", $("#bypass-ask").checked));
$("#grant-add").addEventListener("click", () => {
  const project = $("#grant-add-project").value.trim();
  const role = $("#grant-add-role").value, allow = $("#grant-add-allow").value === "true";
  if (!project || project === "*") { settingsNotice("Enter a registered project name.", true); $("#grant-add-project").focus(); return; }
  const grants = (settingsView?.settings.bypass_grants || []).filter((g) => !(g.role === role && g.project.toLowerCase() === project.toLowerCase()));
  grants.push({ role, project, allow });
  $("#grant-add-project").value = "";
  void saveSetting("bypass_grants", grants);
});
async function loadGrantProjects() {
  const epoch = authEpoch;
  try {
    const result = await api("/api/projects");
    if (epoch !== authEpoch) return;
    $("#grant-projects").replaceChildren(...(result.projects || []).filter((p) => typeof p?.name === "string").map((p) => new Option(p.name)));
  } catch { /* Project names can still be typed. */ }
}
let settingsOpener = null;
function openSettings(event) {
  if (!authorized || ui.settingsDialog.open) return;
  closeMenus();
  const opener = event?.currentTarget;
  settingsOpener = opener && opener !== $("#open-settings") ? opener : $("#conversation-menu-button");
  settingsNotice("");
  renderSettings(true);
  showDialog(ui.settingsDialog);
  pushOverlay("settings", () => ui.settingsDialog.open);
  $("#close-settings").focus();
  void loadSettings();
  if (!settingsModelsLoaded && host.online) void loadSettingsModels();
  if (host.online) void loadGrantProjects();
}
$("#open-settings").addEventListener("click", openSettings);
$("#info-open-settings").addEventListener("click", openSettings);
$("#close-settings").addEventListener("click", () => ui.settingsDialog.close());
$("#settings-form").addEventListener("submit", (event) => event.preventDefault());
ui.settingsDialog.addEventListener("close", () => {
  if (staleClose(ui.settingsDialog)) return; // A late close event (see the Move dialog's).
  popOverlay("settings");
  if (!authorized) return;
  const opener = settingsOpener;
  settingsOpener = null;
  if (opener?.isConnected && !opener.closest("[hidden], [inert]")) opener.focus({ preventScroll: true });
});
// Menus use the popover top layer; light dismiss and Escape come from the browser.
function closeMenus() {
  for (const menu of [ui.menu, ui.messageMenu]) if (menu.matches(":popover-open")) menu.hidePopover();
}
function menuItems(menu) {
  return [...menu.querySelectorAll('[role="menuitem"]')].filter((item) => !item.hidden && !item.disabled);
}
let messageMenuTarget = null, messageMenuText = "";
for (const menu of [ui.menu, ui.messageMenu]) {
  menu.addEventListener("toggle", (event) => {
    if (event.newState === "open") { menuItems(menu)[0]?.focus(); return; }
    // Closing returns focus to what opened the menu, unless focus already moved elsewhere.
    const lost = menu.contains(document.activeElement) || document.activeElement === document.body || !document.activeElement;
    if (!lost) return;
    // A message re-rendered while its menu was open (streaming) is found again by its entry key.
    const key = messageMenuTarget?.dataset.entryKey;
    const back = menu === ui.menu ? $("#conversation-menu-button")
      : messageMenuTarget?.isConnected ? messageMenuTarget
      : [...ui.messages.querySelectorAll(".message")].find((article) => article.dataset.entryKey === key);
    if (back?.isConnected && !back.closest("[hidden], [inert]")) back.focus({ preventScroll: true });
  });
  menu.addEventListener("keydown", (event) => {
    const items = menuItems(menu), index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") menu.hidePopover();
  });
}
function placeMenu(menu, anchor, point) {
  const width = Math.min(280, window.innerWidth - 16);
  const left = point ? Math.min(Math.max(8, point.x), window.innerWidth - width - 8) : Math.max(8, anchor.right - width);
  const top = point ? point.y : anchor.bottom + 4;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - 120))}px`;
  menu.style.width = `${width}px`;
}
const lastMessage = () => [...ui.messages.querySelectorAll(".message")].at(-1);
ui.menu.addEventListener("beforetoggle", (event) => {
  if (event.newState !== "open") return;
  $("#open-info").hidden = !selected;
  $("#copy-last").hidden = typeof lastMessage()?.copyText !== "string";
  const steps = $("#toggle-steps");
  steps.hidden = !selected || !hiddenSteps;
  steps.textContent = showSteps ? "Hide steps" : `Show ${hiddenSteps} ${hiddenSteps === 1 ? "step" : "steps"}`;
  placeMenu(ui.menu, $("#conversation-menu-button").getBoundingClientRect());
});
$("#toggle-steps").addEventListener("click", () => {
  ui.menu.hidePopover();
  showSteps = !showSteps;
  renderMessages(shownHistory, shownReceipts);
});
let copyStatusTimer;
function copyStatus(text, error = false) {
  const status = $("#copy-status");
  clearTimeout(copyStatusTimer);
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle("error", error);
  status.hidden = !text;
  if (text) copyStatusTimer = setTimeout(() => copyStatus(""), error ? 8000 : 2500);
}
async function copyText(text) {
  copyStatus("");
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(text);
    copyStatus("Copied");
  } catch {
    copyStatus("Could not copy. Allow clipboard access or select and copy the text manually.", true);
  }
}
$("#copy-last").addEventListener("click", () => {
  const text = lastMessage()?.copyText;
  ui.menu.hidePopover();
  if (typeof text === "string") void copyText(text);
});
// The message menu: long-press (touch), right-click, or Enter / Space / the context-menu key on
// a focused message. It copies the text the message had when the menu opened.
function openMessageMenu(article, point) {
  if (typeof article?.copyText !== "string") return;
  if (ui.messageMenu.matches(":popover-open") && messageMenuTarget === article) return;
  closeMenus();
  messageMenuTarget = article;
  messageMenuText = article.copyText;
  const rect = article.getBoundingClientRect(), top = ui.timeline.getBoundingClientRect().top;
  placeMenu(ui.messageMenu, rect, point || { x: rect.left + 12, y: Math.max(rect.top, top) + 12 });
  ui.messageMenu.showPopover();
  menuItems(ui.messageMenu)[0]?.focus();
}
$("#copy-message").addEventListener("click", () => {
  const text = messageMenuText;
  ui.messageMenu.hidePopover();
  void copyText(text);
});
ui.messages.addEventListener("contextmenu", (event) => {
  const article = event.target.closest?.(".message");
  // Links, controls, code blocks and selected text keep the browser's own menu.
  if (!article || event.target.closest("a, button, pre") || String(window.getSelection?.() || "")) return;
  event.preventDefault();
  if (ui.messageMenu.matches(":popover-open") && messageMenuTarget === article) return;
  const pointer = event.clientX || event.clientY;
  openMessageMenu(article, pointer ? { x: event.clientX, y: event.clientY } : null);
});
// The message menu is a manual popover: it opens while the finger or mouse button that opened it
// is still down, and the automatic light dismiss would close it again on that release. It closes
// on a press outside it or Escape. It deliberately survives scrolling: a streaming reply keeps
// the conversation pinned to the latest message, and that must not close the menu under the user.
document.addEventListener("pointerdown", (event) => {
  if (ui.messageMenu.matches(":popover-open") && !ui.messageMenu.contains(event.target)) ui.messageMenu.hidePopover();
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && ui.messageMenu.matches(":popover-open")) { event.preventDefault(); ui.messageMenu.hidePopover(); }
});
// Some Android builds do not raise contextmenu for a long-press on plain text; a 500 ms touch
// hold without movement opens the same menu.
let pressTimer = null, pressStart = null;
const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
ui.messages.addEventListener("pointerdown", (event) => {
  const article = event.target.closest?.(".message");
  if (event.pointerType !== "touch" || !article || event.target.closest("a, button, pre")) return;
  pressStart = { x: event.clientX, y: event.clientY };
  cancelPress();
  pressTimer = setTimeout(() => {
    pressTimer = null;
    if (!ui.messageMenu.matches(":popover-open")) openMessageMenu(article, pressStart);
  }, 500);
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) ui.messages.addEventListener(type, cancelPress);
ui.messages.addEventListener("pointermove", (event) => {
  if (pressTimer && pressStart && Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) cancelPress();
});
ui.messages.addEventListener("keydown", (event) => {
  if (!event.target.classList?.contains("message") || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  openMessageMenu(event.target);
});
// TalkBack (#174): a double-tap activates the focused message with a click that no finger or
// mouse press started; that click opens the message's options, as Enter does. A sighted tap or
// click always starts with a press on the same message and stays for reading and scrolling. The
// press is remembered by entry key, since a streaming message can re-render in between.
let pressedEntry = null;
document.addEventListener("pointerdown", (event) => {
  pressedEntry = event.target.closest?.("#messages .message")?.dataset.entryKey ?? null;
}, true);
function messageClick(event) {
  const article = event.currentTarget;
  const pressed = pressedEntry !== null && pressedEntry === article.dataset.entryKey;
  pressedEntry = null;
  if (pressed || event.target.closest("a, button, pre, summary, input, select, textarea") || String(window.getSelection?.() || "")) return;
  openMessageMenu(article);
}

// GET /api/leads: the Lead registry. A host or relay without the route answers 404; it is asked
// again only once a minute, so an older host costs one request a minute, not one a poll.
async function refreshLeads(epoch) {
  if (Date.now() < leadsRetryAt) return;
  try {
    const result = await api("/api/leads");
    if (!authorized || epoch !== authEpoch) return;
    const next = Array.isArray(result?.leads) ? result.leads.filter((lead) => lead && typeof lead === "object" && typeof lead.lead === "string") : null;
    const changed = JSON.stringify(next) !== JSON.stringify(leads);
    leads = next;
    leadsMode = result?.mode === "local" ? "local" : "relay";
    if (changed) { renderRail(); renderHeading(); }
  } catch (error) {
    if (!authorized || epoch !== authEpoch) return;
    if (error?.status === 404) {
      leadsRetryAt = Date.now() + 60_000;
      if (leads !== null) { leads = null; renderRail(); renderHeading(); }
    }
  }
}
async function poll() {
  clearTimeout(pollTimer);
  if (!authorized) return;
  // A poll asked for while one is in flight (the browser coming back online, a PM move, a
  // sign-in) runs once that one has finished, which includes its /api/pm/host and /api/leads
  // reads settling: the in-flight poll may have read the state from before the change, so
  // dropping the request would leave the view stale until the timer. Many requests made during
  // one poll still make a single follow-up poll.
  if (polling) {
    pollAgain = true;
    return;
  }
  polling = true;
  pollAgain = false;
  const epoch = authEpoch;
  let pmHostRead, leadsRead;
  try {
    const nextHost = await api("/api/host");
    if (!authorized || epoch !== authEpoch) return;
    host = nextHost;
    hostChecked = true;
    hostError = "";
    renderHost();
    // The PM machine is answered by the relay even while that machine is offline, so it is
    // read on every poll, exactly once, whether or not the host is online. It is read alongside
    // the sessions, so a slow answer never holds up the session list.
    pmHostRead = refreshPmHost(epoch);
    leadsRead = refreshLeads(epoch);
    if (host.online) {
      const rows = await api("/api/sessions");
      if (!authorized || epoch !== authEpoch) return;
      sessions = Array.isArray(rows) ? rows : [];
      sessionsLoaded = true;
      if (deepLinkPending) {
        const key = deepLinkPending;
        deepLinkPending = null;
        if (selected === key && !sessions.some((s) => s.session_key === key)) rejectDeepLink();
        else if (selected === key) clearRejected(key);
      }
      renderRail();
      await refreshSelected().catch(showRefreshError);
      if (!selected) {
        renderMessages();
        renderHeading();
      }
      await refreshPmSummary(epoch);
    } else {
      if (conversationLoading) showConversationLoading(`Conversation unavailable while ${hostName("the execution host")} is offline. It will open when it reconnects.`, true);
      renderRail();
      renderHeading();
    }
  } catch (error) {
    if (authorized && epoch === authEpoch) {
      host = { online: false };
      hostChecked = true;
      hostError = errorMessage(error);
      renderHost();
      renderRail();
      renderHeading();
      if (conversationLoading) showConversationLoading("Conversation unavailable while the execution host is unreachable. Retrying automatically.", true);
      // The relay may still answer which machine runs the PM, and until something answers the
      // PM view would say "Checking…" for as long as /api/host keeps failing. Still one read a poll.
      pmHostRead ??= refreshPmHost(epoch);
    }
  } finally {
    // One PM machine read per poll: the next poll starts only after this one's answer.
    await pmHostRead?.catch(() => { /* Display only; the next poll reads it again. */ });
    await leadsRead?.catch(() => { /* Display only; the next poll reads it again. */ });
    polling = false;
    if (!authorized) pollAgain = false;
    else if (pollAgain) void poll();
    else pollTimer = setTimeout(poll, document.hidden ? 10000 : 3000);
  }
}
function autosize() {
  ui.input.style.height = "auto";
  ui.input.style.height = `${Math.min(200, ui.input.scrollHeight)}px`;
}
ui.input.addEventListener("input", () => {
  if (selected) setDraft(selected, ui.input.value);
  for (const action of ["send", "interrupt"]) {
    const feedback = actionFeedback.get(selected)?.[action];
    if (feedback?.text && !feedback.error) setActionFeedback(selected, action, "");
  }
  autosize();
  updateControls();
});
ui.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!ui.send.disabled) $("#composer").requestSubmit();
  }
});
$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = selected,
    text = ui.input.value.trim();
  if (!key || !text || ui.send.disabled) return;
  const previous = sendAttempts.get(key);
  const attempt =
    previous?.text === text ? previous : { id: crypto.randomUUID(), text };
  sendAttempts.set(key, attempt);
  sending.add(key);
  const epoch = authEpoch;
  setActionFeedback(key, "send", "");
  updateControls();
  clearError();
  let accepted = false;
  try {
    if (key === "pm") await post("/api/pm/message", { text });
    else
      await post("/api/session/message", {
        id: key,
        message_id: attempt.id,
        text,
      });
    accepted = true;
    sendAttempts.delete(key);
    setDraft(key, "");
    if (selected === key) {
      ui.input.value = "";
      autosize();
    }
    if (epoch === authEpoch && authorized) {
      // The 202 means the turn is dispatched: Interrupt can reach it now, not only after the
      // refresh below answers.
      sending.delete(key);
      setActionFeedback(key, "send", "Message accepted.");
      updateControls();
    }
    await refreshSelected();
  } catch (error) {
    if (epoch === authEpoch && authorized) setActionFeedback(key, "send",
      accepted
        ? `Your message was accepted, but the conversation could not refresh. ${errorMessage(error)}`
        : `${errorMessage(error)} Your message is still in the composer.${key === "pm" ? " Check the conversation before sending again." : " Retry the same message to check delivery without creating a duplicate."}`,
      true,
    );
  } finally {
    if (epoch === authEpoch) {
      sending.delete(key);
      updateControls();
      if (selected === key && !ui.input.disabled) ui.input.focus();
    }
  }
});
ui.interrupt.addEventListener("click", async () => {
  if (ui.interrupt.disabled) return;
  const key = selected;
  const epoch = authEpoch;
  ui.interrupt.dataset.busy = "true";
  setActionFeedback(key, "interrupt", "");
  updateControls();
  clearError();
  let accepted = false;
  try {
    await post(
      key === "pm" ? "/api/pm/interrupt" : "/api/session/interrupt",
      key === "pm" ? {} : { id: key },
    );
    accepted = true;
    if (epoch === authEpoch && authorized) setActionFeedback(key, "interrupt", "Interrupt request accepted.");
    await refreshSelected();
  } catch (error) {
    if (epoch === authEpoch && authorized) setActionFeedback(key, "interrupt", accepted
      ? `Interrupt request accepted, but the conversation could not refresh. ${errorMessage(error)}`
      : errorMessage(error), true);
  } finally {
    if (epoch === authEpoch) {
      ui.interrupt.dataset.busy = "false";
      updateControls();
    }
  }
});
function retainModel(select, value) {
  if (![...select.options].some((option) => option.value === value)) {
    select.add(new Option(value, value));
  }
  select.value = value;
}
function modelOptions(select, models, value = "") {
  select.replaceChildren(new Option("Provider default", ""));
  for (const model of models) {
    const option = new Option(model.displayName, model.value);
    option.title = model.description || model.value;
    select.add(option);
  }
  retainModel(select, value);
}
async function loadNewModels(value = "") {
  if (typeof value !== "string") value = "";
  const request = ++newModelRequest, epoch = authEpoch;
  const provider = $("#new-provider").value, select = $("#new-model");
  modelOptions(select, [], value);
  select.disabled = true;
  $("#new-model-hint").textContent = "Loading available models…";
  try {
    const result = await api(`/api/models?provider=${provider}`);
    if (request !== newModelRequest || epoch !== authEpoch || !authorized) return;
    modelOptions(select, result.models || [], value);
    $("#new-model-hint").textContent = "Uses your provider settings unless you choose a model.";
  } catch (error) {
    if (request !== newModelRequest || epoch !== authEpoch || !authorized) return;
    $("#new-model-hint").textContent = `Models unavailable: ${errorMessage(error)} Your selected model is retained. Reopen this dialog to retry.`;
  } finally { if (request === newModelRequest) select.disabled = false; }
}
async function loadPmModels() {
  pmModelLoaded = true;
  pmModelLoading = true;
  const epoch = authEpoch;
  updateControls();
  try {
    const result = await api("/api/models?provider=claude");
    if (epoch !== authEpoch || !authorized) return;
    modelOptions($("#pm-model"), result.models || [], pmModel);
    $("#pm-model-hint").textContent = PM_MODEL_HINT;
  } catch (error) {
    if (epoch !== authEpoch || !authorized) return;
    $("#pm-model-hint").textContent = `Models unavailable: ${errorMessage(error)} Reopen the Coordinator to retry.`;
  } finally { if (epoch === authEpoch) { pmModelLoading = false; updateControls(); } }
}
$("#pm-model").addEventListener("change", async () => {
  const value = $("#pm-model").value;
  if (pmModelSaving || pmBusy || !host.online) { retainModel($("#pm-model"), pmModel); return; }
  pmModelSaving = true;
  $("#pm-model-hint").textContent = "Saving…";
  modelRevision++;
  const epoch = authEpoch;
  updateControls();
  try {
    const result = await post("/api/pm/model", { model: value || null });
    if (epoch !== authEpoch || !authorized) return;
    pmModel = result.model || "";
    $("#pm-model-hint").textContent = "Saved. Applies to the next turn.";
  } catch (error) { if (epoch === authEpoch && authorized) $("#pm-model-hint").textContent = `Could not save model. ${errorMessage(error)}`; }
  finally {
    if (epoch === authEpoch) {
      pmModelSaving = false;
      retainModel($("#pm-model"), pmModel);
      updateControls();
      if (authorized) await refreshSelected().catch(showError);
    }
  }
});
$("#new-provider").addEventListener("change", loadNewModels);
function updateNewPolicy() {
  const mode = $("#new-policy").value;
  $("#new-policy-hint").textContent = POLICY_DESCRIPTION[mode];
  $("#bypass-confirmation").hidden = mode !== 'bypass';
  $("#confirm-bypass").required = mode === 'bypass';
  $("#confirm-bypass").checked = false;
}
$("#new-policy").addEventListener("change", updateNewPolicy);
function projectChoices(rows) {
  const choices = $("#project-choices"); choices.replaceChildren();
  for (const project of rows) {
    const button = node("button", "project-choice"); button.type = "button";
    button.append(node("strong", "", project.name), node("span", "", project.path));
    button.addEventListener("click", () => { $("#new-cwd").value = project.path; void resolveNewProject(project); });
    choices.append(button);
  }
}
async function loadProjects() {
  const epoch = authEpoch;
  try {
    const result = await api("/api/projects");
    if (epoch !== authEpoch || !ui.dialog.open) return;
    projectRows = result.projects || [];
    if (!$("#new-cwd").value.trim()) projectChoices(projectRows);
  } catch (error) { if (epoch === authEpoch) $("#project-status").textContent = `Projects unavailable: ${errorMessage(error)} Enter an absolute directory to try resolving it.`; }
}
async function resolveNewProject(selectedProject) {
  const revision = ++projectRevision, epoch = authEpoch, reference = $("#new-cwd").value.trim();
  projectResolution = null; projectPending = !!reference;
  const matches = projectRows.filter((p) => [p.path, p.canonicalPath, p.name, ...(p.aliases || [])].some((v) => v?.toLowerCase() === reference.toLowerCase()));
  projectSelection = selectedProject || (matches.length === 1 ? matches[0] : null);
  $("#rename-project").hidden = !projectSelection; $("#remove-project").hidden = !projectSelection; $("#remember-project").hidden = !!projectSelection;
  $("#project-name").value = projectSelection?.name || ""; $("#project-aliases").value = (projectSelection?.aliases || []).join(", "); $("#project-feedback").textContent = "";
  $("#project-status").textContent = reference ? "Resolving project…" : "Choose a recent project or search by name, alias, or absolute path.";
  projectChoices(reference ? projectRows.filter((p) => `${p.name} ${p.path} ${(p.aliases || []).join(" ")}`.toLowerCase().includes(reference.toLowerCase())) : projectRows);
  updateControls();
  if (!reference) return;
  try {
    const result = await post("/api/projects/resolve", { reference });
    if (revision !== projectRevision || epoch !== authEpoch || !ui.dialog.open) return;
    if (result.status === "resolved") {
      projectResolution = { ...result, reference }; projectSelection = result.project || null;
      $("#project-status").textContent = `Project: ${result.project?.name || "Unregistered directory"} · ${result.path}`;
      projectChoices([]);
      $("#project-name").value = result.project?.name || result.path.split("/").filter(Boolean).at(-1) || "";
      $("#project-aliases").value = (result.project?.aliases || []).join(", ");
      $("#rename-project").hidden = !result.project; $("#remove-project").hidden = !result.project; $("#remember-project").hidden = !!result.project;
    } else {
      $("#project-status").textContent = result.status === "ambiguous" ? "Several projects match. Which project do you mean?" : "No project matches. Choose a registered project or enter its full absolute directory.";
      projectChoices(result.candidates || []);
    }
  } catch (error) { if (revision === projectRevision && epoch === authEpoch) $("#project-status").textContent = errorMessage(error); }
  finally { if (revision === projectRevision && epoch === authEpoch) { projectPending = false; updateControls(); } }
}
$("#new-cwd").addEventListener("input", () => resolveNewProject());
async function changeProject(action) {
  if (projectPending || !authorized || !host.online || (action === "register" ? !projectResolution : !projectSelection)) return;
  const selection = projectResolution || { project: projectSelection }, epoch = authEpoch, revision = projectRevision;
  const button = $(action === "register" ? "#remember-project" : action === "update" ? "#rename-project" : "#remove-project");
  button.disabled = true; $("#project-feedback").textContent = "Saving…";
  try {
    const name = $("#project-name").value.trim(), aliases = $("#project-aliases").value.split(",").map((v) => v.trim()).filter(Boolean);
    const result = await post(`/api/projects/${action}`, action === "register" ? { name, path: selection.reference.startsWith("/") ? selection.reference : selection.path, aliases } : { id: selection.project.id, name, aliases });
    if (epoch !== authEpoch || revision !== projectRevision || !ui.dialog.open) return;
    if (action === "remove") { $("#new-cwd").value = ""; await loadProjects(); await resolveNewProject(); }
    else { $("#new-cwd").value = result.path; await loadProjects(); await resolveNewProject(); }
    $("#project-feedback").textContent = action === "remove" ? "Project removed. Existing sessions are unchanged." : `Project saved on ${hostName("the execution host")}.`;
    $("#new-cwd").focus();
  } catch (error) { if (epoch === authEpoch && revision === projectRevision) $("#project-feedback").textContent = errorMessage(error); }
  finally { button.disabled = false; }
}
$("#remember-project").addEventListener("click", () => changeProject("register"));
$("#rename-project").addEventListener("click", () => changeProject("update"));
$("#remove-project").addEventListener("click", () => changeProject("remove"));
// "Ask the Coordinator" (D7): the brief goes to the Coordinator as a message, and its chat opens.
// The Coordinator decides whether to start a Lead and with which setup; nothing launches here.
function askStatus(text, error = false) {
  const status = $("#ask-coordinator-status");
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle("error", error);
}
$("#ask-coordinator").addEventListener("input", () => { askStatus(""); updateControls(); });
$("#send-to-coordinator").addEventListener("click", async () => {
  const text = $("#ask-coordinator").value.trim();
  if (askBusy || !authorized || !host.online || !text) return;
  const epoch = authEpoch;
  askBusy = true;
  askStatus("");
  updateControls();
  try {
    await post("/api/pm/message", { text });
    if (epoch !== authEpoch || !authorized) return;
    askBusy = false;
    $("#ask-coordinator").value = "";
    ui.dialog.close();
    setActionFeedback("pm", "send", "Message accepted.");
    if (selected !== "pm") await selectSession("pm");
    else await refreshSelected().catch(showRefreshError);
  } catch (error) {
    if (epoch === authEpoch && authorized) askStatus(`${errorMessage(error)} Your message is still here. Check the Coordinator’s conversation before sending again.`, true);
  } finally {
    if (epoch === authEpoch) { askBusy = false; updateControls(); }
  }
});
let dialogOpener;
function openNew(event) {
  if (!authorized || !host.online) return;
  dialogOpener = event?.currentTarget || document.activeElement;
  if (!$("#new-cwd").value && detail?.session?.cwd)
    $("#new-cwd").value = detail.session.cwd;
  $("#new-error").hidden = true;
  $("#new-policy").value = "native";
  updateNewPolicy();
  askStatus("");
  showDialog(ui.dialog);
  pushOverlay("dialog", () => ui.dialog.open);
  void loadNewModels();
  void loadProjects(); void resolveNewProject();
  $("#ask-coordinator").focus();
}
ui.newButton.addEventListener("click", openNew);
ui.dialog.addEventListener("close", () => {
  if (staleClose(ui.dialog)) return; // A late close event (see the Move dialog's).
  popOverlay("dialog");
  projectRevision++; projectPending = false; projectResolution = null; projectSelection = null;
  if (!authorized || creating) return;
  if (dialogOpener?.isConnected && !dialogOpener.closest("[inert]")) dialogOpener.focus({ preventScroll: true });
});
for (const selector of ["#close-dialog", "#cancel-new"])
  $(selector).addEventListener("click", () => ui.dialog.close());
ui.newForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (creating || !host.online || projectPending || !projectResolution || projectResolution.reference !== $("#new-cwd").value.trim() || !ui.newForm.reportValidity()) return;
  const values = {
    provider: $("#new-provider").value,
    permission_mode: $("#new-policy").value,
    ...($("#new-model").value ? { model: $("#new-model").value } : {}),
    name: $("#new-name").value.trim(),
    cwd: projectResolution.path,
    text: $("#new-prompt").value.trim(),
  };
  if (!values.name || !values.cwd || !values.text) return;
  const signature = JSON.stringify(values);
  if (creationAttempt?.signature !== signature)
    creationAttempt = { signature, id: crypto.randomUUID() };
  creating = true;
  const epoch = authEpoch;
  updateControls();
  $("#new-error").hidden = true;
  $("#create-session").textContent = "Starting…";
  try {
    const session = await post("/api/sessions", {
      id: creationAttempt.id,
      ...values,
    });
    sessions = [
      session,
      ...sessions.filter((s) => s.session_key !== session.session_key),
    ];
    creationAttempt = undefined;
    ui.dialog.close();
    $("#new-name").value = "";
    $("#new-prompt").value = "";
    await selectSession(session.session_key);
  } catch (error) {
    if (epoch !== authEpoch || !authorized) return;
    $("#new-error").textContent =
      `${errorMessage(error)} You can retry with the same details.`;
    $("#new-error").hidden = false;
  } finally {
    if (epoch === authEpoch) {
      creating = false;
      $("#create-session").textContent = "Start session";
      updateControls();
    }
  }
});
$("#select-pm").addEventListener("click", () => { if (!pmModelLoading) pmModelLoaded = false; return selectSession("pm"); });
ui.search.addEventListener("input", renderRail);
$("#dismiss-error").addEventListener("click", clearError);
$("#open-nav").addEventListener("click", () => openNav());
for (const selector of ["#close-nav", "#nav-backdrop"])
  $(selector).addEventListener("click", () => {
    closeNav();
    $("#open-nav").focus();
  });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !ui.dialog.open && !ui.moveDialog.open && !ui.infoDialog.open && !ui.settingsDialog.open && ui.app.classList.contains("nav-open")) {
    closeNav();
    $("#open-nav").focus();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});
window.addEventListener("online", poll);
// The sign-out still in progress (the push unsubscribe wait, then Firebase sign-out), if any.
// Sign-in waits for it: a sign-in completed during the wait would otherwise be undone by the
// Firebase sign-out that follows.
let signingOut = null;
const SIGN_OUT_TIMEOUT = 10000, SIGN_OUT_STUCK = "Signing out is taking longer than expected. Continue with Google reloads Foreman to sign in again.";
let signOutStuck = false;
ui.signOut.addEventListener("click", () => {
  if (signingOut) return;
  // Capture the push subscription and token while still signed in; the server unsubscribe
  // must be sent with the token before Firebase sign-out. It never blocks signing out.
  const leaving = unsubscribeOnSignOut();
  revokeAccess("Sign in to open your session inbox.");
  ui.signIn.disabled = true;
  signingOut = (async () => {
    await leaving;
    try {
      // Bounded: a Firebase sign-out that never settles must not leave "Continue with Google"
      // disabled until a reload (#150). This app has already let go of the account above.
      await withTimeout(authSDK.signOut(firebaseAuth), SIGN_OUT_TIMEOUT, SIGN_OUT_STUCK);
    } catch (error) {
      ui.authStatus.textContent = errorMessage(error);
      // A sign-out still pending could land after a new sign-in and undo it: signing in again
      // starts from a fresh page instead.
      if (error?.message === SIGN_OUT_STUCK) signOutStuck = true;
    }
  })().finally(() => {
    signingOut = null;
    ui.signIn.disabled = false;
  });
});

// Push notifications (epic #43 AND-05). Shown only in hosted mode when the relay has push
// configured (/api/config `push`) and the browser supports it. Permission is requested only
// from the "Turn on notifications" tap, never on load.
const PUSH_KINDS = ["approval_requested", "question_asked", "session_failed", "pm_failed", "host_offline"];
const PUSH_KINDS_STORAGE = "foreman:push-kinds";
const PUSH_STATUS = {
  off: "Get a notification when a session needs your approval or an answer, even with Foreman closed.",
  blocked: "Notifications are blocked for Foreman. To allow them on Android, open Settings → Apps → Foreman → Notifications (in a browser tab: Chrome → Site settings → Notifications), then return here.",
  on: "This device gets Foreman notifications. They name the session and what it needs, never its conversation.",
};
const PUSH_SUMMARY = { off: "Off", blocked: "Blocked", on: "On" };
// On, but every kind unticked: the subscription stays, and nothing can fire until one is ticked.
// Short enough for the drawer's summary row on a narrow phone; the status line below says the rest.
const PUSH_NONE_SUMMARY = "On · all types off";
const PUSH_NONE_STATUS = "This device is subscribed, but every notification type is turned off, so Foreman sends nothing. Tick a type below to get notifications again.";
const pushUi = {
  root: $("#notify-settings"),
  summary: $("#notify-summary"),
  status: $("#notify-status"),
  enable: $("#notify-enable"),
  kinds: $("#notify-kinds"),
  actions: $("#notify-actions"),
  test: $("#notify-test"),
  disable: $("#notify-disable"),
  feedback: $("#notify-feedback"),
  toggles: [...document.querySelectorAll("#notify-kinds input[data-kinds]")],
};
let pushKey = null, pushBusy = false, pushState = "unsupported";

function pushSupported() {
  return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function base64UrlBytes(value) {
  const text = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
// Whether a subscription was made with the relay's current VAPID key.
function subscriptionMatchesKey(subscription) {
  const current = subscription?.options?.applicationServerKey;
  if (!current || !pushKey) return false;
  const a = new Uint8Array(current), b = base64UrlBytes(pushKey);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
// A short, human label for the device list ("Android · Chrome"); never the user agent string.
function deviceLabel() {
  const ua = navigator.userAgent;
  const platform = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /Macintosh|Mac OS X/i.test(ua) ? "Mac"
    : /Windows/i.test(ua) ? "Windows" : /CrOS/i.test(ua) ? "ChromeOS" : /Linux/i.test(ua) ? "Linux" : "Device";
  const browser = /EdgA?\//.test(ua) ? "Edge" : /SamsungBrowser\//.test(ua) ? "Samsung Internet" : /Firefox\/|FxiOS/.test(ua) ? "Firefox"
    : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${platform} · ${browser}`;
}
function storedPushKinds() {
  try {
    const kinds = JSON.parse(localStorage.getItem(PUSH_KINDS_STORAGE));
    if (Array.isArray(kinds) && kinds.every((kind) => PUSH_KINDS.includes(kind))) return kinds;
  } catch { /* Fall back to the defaults. */ }
  return [...PUSH_KINDS];
}
function savePushKinds(kinds) {
  try { localStorage.setItem(PUSH_KINDS_STORAGE, JSON.stringify(kinds)); } catch { /* Display only. */ }
}
function toggleKinds(toggle) {
  return toggle.dataset.kinds.split(" ");
}
function kindsFromToggles() {
  return PUSH_KINDS.filter((kind) => pushUi.toggles.some((toggle) => toggle.checked && toggleKinds(toggle).includes(kind)));
}
function showPushKinds(kinds) {
  for (const toggle of pushUi.toggles) toggle.checked = toggleKinds(toggle).every((kind) => kinds.includes(kind));
}
function pushFeedback(text = "", error = false) {
  pushUi.feedback.textContent = text;
  pushUi.feedback.classList.toggle("error", error);
}
function renderPush(state) {
  pushState = state;
  pushUi.root.dataset.state = state;
  // Unsupported (no push on the relay, local mode, or a browser without Push) hides the section.
  pushUi.root.hidden = state === "unsupported";
  if (state === "unsupported") return;
  const none = state === "on" && kindsFromToggles().length === 0;
  pushUi.summary.textContent = none ? PUSH_NONE_SUMMARY : PUSH_SUMMARY[state];
  pushUi.status.textContent = none ? PUSH_NONE_STATUS : PUSH_STATUS[state];
  pushUi.enable.hidden = state !== "off";
  pushUi.kinds.hidden = pushUi.actions.hidden = state !== "on";
}
function setPushBusy(busy) {
  pushBusy = busy;
  for (const control of [pushUi.enable, pushUi.test, pushUi.disable, ...pushUi.toggles]) control.disabled = busy;
}
async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
async function currentPushSubscription() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}
// This device's subscription for the current VAPID key; one made with another key can never
// be delivered to, so it is replaced.
async function subscribeDevice() {
  const registration = await withTimeout(navigator.serviceWorker.ready, 10000, "Foreman is still starting up. Reload and try again.");
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !subscriptionMatchesKey(subscription)) {
    const stale = subscription.endpoint;
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
    post("/api/push/unsubscribe", { endpoint: stale }).catch(() => {});
  }
  return subscription || registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlBytes(pushKey) });
}
function postPushSubscription(subscription, kinds) {
  return post("/api/push/subscribe", { subscription: subscription.toJSON(), device_label: deviceLabel(), kinds });
}
async function refreshPush() {
  if (!pushKey || !authorized || !pushSupported()) { renderPush("unsupported"); return; }
  if (pushBusy) return;
  if (Notification.permission === "denied") { renderPush("blocked"); return; }
  const epoch = authEpoch;
  let subscription = null;
  try { subscription = await currentPushSubscription(); } catch { /* Treated as off. */ }
  if (epoch !== authEpoch || pushBusy) return;
  if (!subscription || Notification.permission !== "granted") { renderPush("off"); return; }
  if (!subscriptionMatchesKey(subscription)) {
    // The relay's key changed since this device subscribed: resubscribe with the saved kinds.
    setPushBusy(true);
    try {
      const kinds = storedPushKinds();
      await postPushSubscription(await subscribeDevice(), kinds);
      if (epoch !== authEpoch) return;
    } catch (error) {
      if (epoch === authEpoch) { renderPush("off"); pushFeedback(`Notifications need to be turned on again. ${errorMessage(error)}`, true); }
      return;
    } finally {
      setPushBusy(false);
    }
  }
  showPushKinds(storedPushKinds());
  renderPush("on");
}
pushUi.enable.addEventListener("click", async () => {
  if (pushBusy) return;
  const epoch = authEpoch;
  setPushBusy(true);
  pushFeedback();
  try {
    // The only place Foreman asks for notification permission: this tap.
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (epoch !== authEpoch) return;
    if (permission !== "granted") {
      renderPush(permission === "denied" ? "blocked" : "off");
      if (permission !== "denied") pushFeedback("Notifications were not allowed.");
      return;
    }
    // Every kind is on when notifications are turned on.
    const kinds = [...PUSH_KINDS];
    const subscription = await subscribeDevice();
    try {
      await postPushSubscription(subscription, kinds);
    } catch (error) {
      await subscription.unsubscribe().catch(() => {});
      throw error;
    }
    if (epoch !== authEpoch) return;
    savePushKinds(kinds);
    showPushKinds(kinds);
    renderPush("on");
    pushFeedback("Notifications are on for this device.");
  } catch (error) {
    if (epoch === authEpoch) { renderPush(Notification.permission === "denied" ? "blocked" : "off"); pushFeedback(`Could not turn on notifications. ${errorMessage(error)}`, true); }
  } finally {
    setPushBusy(false);
  }
});
for (const toggle of pushUi.toggles)
  toggle.addEventListener("change", async () => {
    const previous = storedPushKinds(), kinds = kindsFromToggles(), epoch = authEpoch;
    setPushBusy(true);
    pushFeedback();
    try {
      const subscription = await currentPushSubscription();
      if (!subscription) {
        renderPush("off");
        pushFeedback("This device is no longer subscribed. Turn notifications on again.", true);
        return;
      }
      await postPushSubscription(subscription, kinds);
      if (epoch !== authEpoch) return;
      savePushKinds(kinds);
      renderPush("on");
      pushFeedback("Saved.");
    } catch (error) {
      if (epoch !== authEpoch) return;
      showPushKinds(previous);
      renderPush("on");
      pushFeedback(`Could not save. ${errorMessage(error)}`, true);
    } finally {
      setPushBusy(false);
    }
  });
pushUi.test.addEventListener("click", async () => {
  const epoch = authEpoch;
  setPushBusy(true);
  pushFeedback();
  try {
    const subscription = await currentPushSubscription();
    const result = await post("/api/push/test", subscription ? { endpoint: subscription.endpoint } : {});
    if (epoch !== authEpoch) return;
    if (result?.failed && !result?.sent) pushFeedback("The push service did not accept the test notification. Turn notifications off and on again.", true);
    else pushFeedback("Test notification sent. It should arrive in a few seconds.");
  } catch (error) {
    if (epoch === authEpoch) pushFeedback(errorMessage(error), true);
  } finally {
    setPushBusy(false);
  }
});
pushUi.disable.addEventListener("click", async () => {
  const epoch = authEpoch;
  setPushBusy(true);
  pushFeedback();
  try {
    const subscription = await currentPushSubscription();
    let confirmed = true;
    if (subscription) {
      try { await post("/api/push/unsubscribe", { endpoint: subscription.endpoint }); } catch { confirmed = false; }
      // Even unconfirmed, the browser subscription is removed: the relay then gets "gone" from
      // the push service on its next send and deletes it.
      await subscription.unsubscribe().catch(() => {});
    }
    if (epoch !== authEpoch) return;
    renderPush("off");
    pushFeedback(confirmed ? "Notifications are off for this device." : "Notifications are off for this device. Foreman could not confirm with the relay; it stops sending after its next attempt.");
  } catch (error) {
    if (epoch === authEpoch) pushFeedback(errorMessage(error), true);
  } finally {
    setPushBusy(false);
  }
});
// Removes this device's subscription on sign-out: the relay first (with the still-valid token),
// then the browser. Bounded, and failures are ignored, so sign-out always proceeds.
async function unsubscribeOnSignOut() {
  if (!pushKey || !pushSupported() || !firebaseAuth?.currentUser) return;
  const user = firebaseAuth.currentUser;
  const work = (async () => {
    const subscription = await currentPushSubscription();
    if (!subscription) return;
    try {
      const token = await user.getIdToken();
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
    } catch { /* The browser unsubscribe below still stops delivery. */ }
    await subscription.unsubscribe().catch(() => {});
  })();
  await withTimeout(work, 5000, "timeout").catch(() => {});
}
// A notification tapped while the app is open: the service worker posts the notification's
// URL here, and it is routed like a deep link, without a reload (drafts and history kept).
function openFromNotification(url) {
  let target;
  try { target = new URL(url, location.origin); } catch { return; }
  if (target.origin !== location.origin || !["/", "/index.html"].includes(target.pathname)) return;
  const key = parseDeepLinkKey(target.search);
  if (ui.dialog.open) ui.dialog.close();
  if (ui.moveDialog.open) ui.moveDialog.close();
  if (ui.settingsDialog.open) ui.settingsDialog.close();
  if (ui.infoDialog.open) ui.infoDialog.close();
  closeMenus();
  if (!key) {
    if (navOpen()) closeNav();
    if (selected !== "pm") { showInbox(); recordView(null); }
    return;
  }
  if (key === selected) {
    if (navOpen()) closeNav();
    void refreshSelected().catch(showRefreshError);
  } else void selectSession(key);
  // Checked against the host's next session list, like a deep link at load.
  if (key !== "pm") deepLinkPending = key;
}
if ("serviceWorker" in navigator)
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (!(event.source instanceof ServiceWorker) || event.data?.type !== "foreman:open" || typeof event.data.url !== "string") return;
    openFromNotification(event.data.url);
  });
document.addEventListener("visibilitychange", () => {
  // Permission may have been changed in Android settings while Foreman was in the background.
  if (!document.hidden && pushState !== "unsupported") void refreshPush();
});
ui.signIn.addEventListener("click", async () => {
  // The button is disabled while a sign-out is pending; a click that slips in as it finishes
  // (the auth state change re-enables the button first) waits for it.
  if (signingOut) {
    ui.signIn.disabled = true;
    await signingOut;
  }
  if (!firebaseAuth || !authSDK || signOutStuck) {
    location.reload();
    return;
  }
  ui.signIn.disabled = true;
  try {
    const provider = new authSDK.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const result = await authSDK.signInWithPopup(firebaseAuth, provider);
    if (!authorized) enterApp(result.user);
  } catch (error) {
    ui.authStatus.textContent =
      error?.code === "auth/popup-blocked"
        ? "Your browser blocked the sign-in window. Allow popups for this site and try again."
        : errorMessage(error);
  } finally {
    ui.signIn.disabled = false;
  }
});
function enterApp(user) {
  authEpoch++;
  authorized = true;
  ui.authScreen.hidden = true;
  ui.app.hidden = false;
  ui.signOut.hidden = !authRequired || localAuthMode;
  $("#account").textContent = user?.email || "Local connection";
  clearError();
  setPmRailError(null);
  renderHost();
  renderPmHost();
  renderRail();
  renderHeading();
  if (selected && !ui.input.value) {
    ui.input.value = drafts.get(selected) || "";
    autosize();
  }
  if (selected) showConversationLoading();
  else renderMessages();
  if (unknownInitialLink && !initialNoticeShown) showNotice(UNKNOWN_LINK_NOTICE);
  initialNoticeShown = true;
  poll();
  void refreshPush();
}
async function boot() {
  try {
    const response = await fetch("/api/config", {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        "Foreman configuration is unavailable. Reload to try again.",
      );
    const config = await response.json();
    authRequired = config.auth?.required !== false;
    // Push exists only on the hosted relay (Google sign-in), never in local or open mode.
    const vapidKey = config.push?.vapid_public_key;
    pushKey = authRequired && config.auth?.kind !== "local" && typeof vapidKey === "string" && /^[A-Za-z0-9_-]{80,100}$/.test(vapidKey) ? vapidKey : null;
    if (!authRequired) {
      enterApp(null);
      return;
    }
    if (config.auth?.kind === "local") {
      localAuthMode = true;
      try { await api('/api/host'); enterApp(null); return; } catch {}
      ui.authStatus.textContent = 'Enter the local API token from the file shown in the Foreman server log.';
      const form = document.createElement('form'); form.id = 'local-auth-form';
      const input = document.createElement('input'); input.type = 'password'; input.placeholder = 'Local API token'; input.autocomplete = 'off'; input.required = true;
      const button = document.createElement('button'); button.textContent = 'Unlock Foreman';
      form.append(input, button); ui.authScreen.append(form);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        try { await api('/api/auth/local', {method:'POST',body:JSON.stringify({token:input.value})}); input.value = ''; form.hidden = true; enterApp(null); }
        catch (error) { ui.authStatus.textContent = errorMessage(error); }
      });
      $('#sign-in').hidden = true;
      return;
    }
    if (!config.auth?.firebase?.apiKey)
      throw new Error(
        "Google sign-in has not been configured for this Foreman deployment.",
      );
    const [appSDK, sdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js"),
    ]);
    authSDK = sdk;
    firebaseAuth = sdk.getAuth(appSDK.initializeApp(config.auth.firebase));
    sdk.onAuthStateChanged(firebaseAuth, (user) => {
      if (user) enterApp(user);
      else
        revokeAccess(
          "Sign in with your authorized Google account to continue.",
        );
    });
  } catch (error) {
    ui.authStatus.textContent = errorMessage(error);
    ui.signIn.textContent = "Try again";
    ui.signIn.hidden = false;
  }
}
window
  .matchMedia("(max-width: 760px)")
  .addEventListener("change", () => closeNav());
// Android keyboards can resize only the visual viewport. Keep the composer and
// dialog scroll area inside it without changing browser pinch-zoom behavior.
function fitViewport() {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale !== 1) return;
  document.documentElement.style.setProperty("--viewport-height", `${viewport.height}px`);
}
window.visualViewport?.addEventListener("resize", fitViewport);
fitViewport();
setNav(false);
initHistory();
boot();
// Installability and the offline screen. Registered after load so it never competes with
// startup; failures (no support, insecure origin, blocked) leave the app unchanged.
if ("serviceWorker" in navigator && window.isSecureContext) {
  const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
