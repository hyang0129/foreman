const POLICY_LABEL = { native: 'Native', bypass: '⚠ Bypass · no permission prompts' };
const POLICY_DESCRIPTION = {
  native: 'Use the provider’s normal permissions and approval prompts. Claude and Codex have different native boundaries. Foreman adds no credential deny list.',
  bypass: '⚠ Commands, network, credentials, and files outside the project without permission prompts. Foreman adds no sandbox or credential protection.',
};
const policyLabel = (session) => POLICY_LABEL[session.permission_mode] || (session.permission_mode ? `Legacy policy: ${session.permission_mode}` : 'Policy unknown');
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
// The URL is the only record of the open conversation, so reload keeps the view.
function viewUrl(key) {
  return key === "pm" ? "/?view=pm" : key ? `/?session=${encodeURIComponent(key)}` : "/";
}
const initialLink = parseDeepLink(location.search);
// "pm" is the PM sentinel, never a session key; a session link naming it is unknown.
const unknownInitialLink = initialLink?.session === "pm" || (!initialLink && new URLSearchParams(location.search).has("session"));
let selected = initialLink?.view === "pm" ? "pm" : initialLink?.session && initialLink.session !== "pm" ? initialLink.session : null;
// A deep-linked session opens optimistically and is checked against the host's list once.
let deepLinkPending = selected && selected !== "pm" ? selected : null, initialNoticeShown = false;
const UNKNOWN_LINK_NOTICE = "That conversation isn’t available on your Mac. Showing your inbox.";
let sessions = [],
  detail = null,
  host = { online: false },
  // GET /api/pm/host (epic #26 contract D): which machine runs the PM. null until read, or
  // when the host or relay does not serve the route.
  pmHost = null,
  authorized = false,
  authRequired = false,
  localAuthMode = false,
  firebaseAuth,
  authSDK;
let pollTimer,
  polling = false,
  sending = false,
  creating = false,
  authEpoch = 0,
  selectionEpoch = 0;
let messageSignature = "",
  approvalSignature = "",
  creationAttempt,
  pmBusy = false;
let pmModel = "", pmModelSaving = false, pmModelLoading = false, pmModelReady = false,
  pmModelLoaded = false, modelRevision = 0, newModelRequest = 0;
let launchRevision = 0, launchJob = null, launchMode = "brief", launchBusy = false, launcherModelRequest = 0;
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
  for (const state of copyStates.values()) { clearTimeout(state.timer); state.render = () => {}; }
  copyStates.clear();
  timelineEntries = [];
  newMessages = false;
  ui.latest.hidden = true;
}
ui.timeline.addEventListener("scroll", updateLatest, { passive: true });
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
    throw error;
  }
  return result;
}
function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

function revokeAccess(message) {
  cancelLauncher(); launcherModelRequest++;
  authEpoch++;
  authorized = false;
  pmModel = ""; pmModelLoaded = false; pmModelReady = false;
  sending = false; creating = false; pmModelSaving = false; pmModelLoading = false;
  newModelRequest++;
  projectRevision++; projectRows = []; projectResolution = null; projectSelection = null; projectPending = false;
  $("#project-choices").replaceChildren(); $("#project-status").textContent = ""; $("#project-feedback").textContent = "";
  ui.interrupt.dataset.busy = "false";
  $("#create-session").textContent = "Start session";
  $("#pm-model-hint").textContent = "Changes apply to the next turn and are saved with the PM.";
  modelOptions($("#pm-model"), []);
  clearTimeout(pollTimer);
  sessions = [];
  hostChecked = false;
  sessionsLoaded = false;
  detail = null;
  host = { online: false };
  pmHost = null;
  renderPmHost();
  ui.moveDialog.close();
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
// History model (Android Back). The stack is at most [inbox, conversation, drawer, dialog]:
// opening a conversation from the inbox pushes an entry, switching conversations replaces it,
// and the drawer and the new-session dialog each push an overlay entry. Back therefore closes
// the dialog, then the drawer, then returns to the inbox, then leaves the app. Every entry
// carries { foreman: 1, view, overlay? } so popstate can restore the matching screen.
let ownBack = null, ownBackDone = null;
function historyState(view, overlay) {
  return overlay ? { foreman: 1, view: view || null, overlay } : { foreman: 1, view: view || null };
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
      // Our conversation entries always sit directly above an inbox entry.
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
function initHistory() {
  const url = viewUrl(selected);
  const state = history.state;
  if (state?.foreman && (state.view || null) === selected) {
    // A reload or restore of an entry this app created keeps its stack; an overlay that
    // no longer exists after the reload is dropped from the entry.
    if (state.overlay || location.pathname + location.search !== url) history.replaceState(historyState(selected), "", url);
  } else if (selected) {
    // A fresh deep link: put the inbox beneath it, so Back returns to the inbox, not out.
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
  if (navOpen() && !state.overlay) {
    setNav(false);
    $("#open-nav").focus({ preventScroll: true });
  }
  // Forward into an overlay entry whose layer is gone: keep the entry as a plain view.
  if ((state.overlay === "nav" && !navOpen()) || (state.overlay === "dialog" && !ui.dialog.open) || (state.overlay === "move" && !ui.moveDialog.open))
    history.replaceState(historyState(state.view), "", location.href);
  const view = state.view || null;
  if (view === selected) return;
  if (view) void selectSession(view, false);
  else showInbox();
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
function renderHost() {
  $("#host-dot").className = `dot ${host.online ? "online" : "offline"}`;
  $("#host-status").textContent = !hostChecked ? "Connecting to execution host…" : host.online
    ? `${host.host || "Execution host"} · online`
    : "Execution host offline";
  const banner = $("#connection-banner");
  banner.hidden = !!host.online || !hostChecked;
  banner.textContent =
    "Your Mac is disconnected. Showing the last available state. Messages and approvals will be available when it reconnects.";
  updateControls();
  if (ui.messages.querySelector(".empty-state") && !conversationLoading) renderMessages();
}
function renderRail() {
  const focusedKey = document.activeElement?.dataset?.session;
  const focusedClear = document.activeElement?.hasAttribute("data-clear-search");
  ui.list.replaceChildren();
  const query = ui.search.value.trim().toLowerCase();
  const visible = sessions.filter(
    (s) =>
      s.name !== "foreman-pm" &&
      (!query ||
        `${s.name} ${s.cwd} ${s.project_name || ""} ${s.provider}`.toLowerCase().includes(query)),
  );
  $("#session-count").textContent = String(
    sessions.filter((s) => s.name !== "foreman-pm").length,
  );
  $("#select-pm").classList.toggle("selected", selected === "pm");
  $("#select-pm").setAttribute("aria-pressed", String(selected === "pm"));
  const known = new Set(GROUPS.map(([state]) => state));
  const groups = [...GROUPS, ["other", "Other sessions"]];
  for (const [state, label] of groups) {
    const rows = visible.filter((s) =>
      state === "other" ? !known.has(s.state) : s.state === state,
    );
    if (!rows.length) continue;
    ui.list.append(node("h2", "group-heading", `${label} · ${rows.length}`));
    rows.sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );
    for (const s of rows) {
      const row = node(
        "button",
        `session-row${selected === s.session_key ? " selected" : ""}`,
      );
      row.title = s.cwd || "";
      row.setAttribute("aria-description", s.cwd || "");
      row.type = "button";
      row.dataset.session = s.session_key;
      row.setAttribute("aria-pressed", String(selected === s.session_key));
      row.append(
        node("span", `dot ${known.has(s.state) ? s.state : "unknown"}`),
        node(
          "span",
          "session-name",
          s.name || s.session_id?.slice(0, 8) || "Session",
        ),
        node("span", "session-age", ago(s.updated_at || s.started_at)),
      );
      const summary =
        s.state === "needs_input"
          ? s.reason || "Waiting for your response"
          : s.state === "working"
            ? s.current_tool || "Working on your task"
            : s.last_message || projectName(s);
      row.append(
        node("span", "session-sub", summary),
        node(
          "span",
          "session-meta",
          `${projectName(s)} · ${s.provider === "codex" ? "Codex" : "Claude"} · ${s.managed ? `Managed · ${policyLabel(s)}` : "Monitoring"}${!host.online ? " · Last known" : ""}`,
        ),
      );
      row.addEventListener("click", () => selectSession(s.session_key));
      ui.list.append(row);
    }
  }
  if (!visible.length) {
    const empty = node("div", "rail-empty");
    const noMatches = !!query && sessionsLoaded;
    empty.append(node("p", "", noMatches ? "No sessions match your search."
      : !hostChecked || (host.online && !sessionsLoaded) ? "Loading sessions…"
      : !host.online ? "Your Mac is offline. Reconnect to see sessions."
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
  $("#create-session").disabled = !authorized || !host.online || creating || projectPending || !projectResolution || launchMode === "brief" || launchBusy;
  $("#propose-session").disabled = !authorized || !host.online || launchBusy || !$("#launch-brief").value.trim();
  $("#launch-brief").disabled = launchBusy;
  $("#launcher-model").disabled = launchBusy;
  if (launchBusy && !host.online) manualLaunch("Host is offline. Your brief is preserved; start manually when it reconnects.");
  ui.input.disabled = !canMessage || sending;
  ui.send.disabled = !canMessage || sending || !ui.input.value.trim();
  ui.send.firstChild.textContent = sending ? "Sending… " : "Send ";
  ui.interrupt.disabled =
    !authorized ||
    !host.online ||
    (isPm ? !pmBusy : !session?.capabilities?.interrupt) ||
    ui.interrupt.dataset.busy === "true";
  ui.interrupt.textContent = ui.interrupt.dataset.busy === "true" ? "Interrupting…" : "Interrupt";
  renderActionFeedback();
  ui.input.placeholder = !selected
    ? "Choose a session to start a conversation"
    : !host.online
      ? "Reconnect your Mac to send a message"
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
        ? "Your project manager keeps track of the work and delegates to session agents."
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
function renderHeading() {
  const headingSummary = $("#heading-details summary"), model = $("#header-model");
  const isPm = selected === "pm";
  const headingName = detail?.session && !isPm ? projectName(detail.session) : "";
  const summaryLabel = isPm ? "Model details" : "Session details";
  const summarySignature = JSON.stringify([summaryLabel, headingName]);
  if (headingSummary.dataset.signature !== summarySignature) {
    headingSummary.replaceChildren(node("span", "", summaryLabel), ...(headingName ? [node("span", "", ` · ${headingName}`)] : []));
    headingSummary.dataset.signature = summarySignature;
  }
  const fields = [];
  let selectedModel = "";
  if (isPm) {
    ui.title.textContent = "Claude · Project manager";
    ui.provider.hidden = true;
    selectedModel = pmModelReady ? pmModel || "Provider default" : "Loading model…";
    fields.push(["Selected model", selectedModel]);
    if (pmModelReady && !pmModel) fields.push(["Model settings", "Provider settings determine the model; Foreman has not verified a concrete model."]);
    fields.push(["Applies to", "The PM’s replies and planning. Newly launched agents have their own model selection."]);
    const machine = pmHost?.active;
    if (machine) fields.push(["Runs on", `${machine.name} · ${machine.online ? "online" : "offline"}${pmHost.mode === "local" ? " · this machine only (no cloud relay)" : ""}`]);
  } else if (detail?.session) {
    const s = detail.session;
    ui.title.textContent = s.name || "Session";
    ui.provider.hidden = false;
    ui.provider.textContent = s.provider === "codex" ? "Codex" : "Claude";
    selectedModel = s.model || (s.managed ? "Provider default" : "Model not reported");
    fields.push([s.managed ? "Selected model" : "Reported model", selectedModel]);
    if (!s.model && s.managed) fields.push(["Model settings", "Provider settings determine the model; Foreman has not verified a concrete model."]);
    fields.push(["Project", projectName(s)], ["Directory", s.cwd || "Project unavailable"], ["Permissions", s.managed ? policyLabel(s) : "Monitoring only"]);
  } else {
    ui.title.textContent = selected ? "Loading session…" : "Your session inbox";
    ui.provider.hidden = true;
  }
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
  renderActivity();
  updateControls();
}
function renderActivity() {
  const status = $("#activity-status"), label = $("#activity-label");
  const state = selected === "pm" ? (pmModelReady ? (pmBusy ? "working" : "turn_finished") : null) : detail?.session?.state;
  const working = state === "working";
  const tool = working && selected !== "pm" ? detail?.session?.current_tool : null;
  const text = state ? `${host.online ? "" : "Last known · "}${working ? "Working…" : LABEL[state] || state}${tool ? ` · ${tool}` : ""}` : "";
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
function messageNode(entry, receipt, entryKey) {
  const role = ["user", "assistant", "tool", "system"].includes(entry.role)
    ? entry.role
    : "system";
  const failed = role === "system" && entry.error === true;
  const article = node("article", `message ${role}${failed ? " error" : ""}`);
  if (failed) article.setAttribute("aria-label", failureLabel());
  const sender = sourceLabel(entry.source);
  const label = node(
    "div",
    "message-label",
    failed ? failureLabel() : sender
      ? `From ${sender}`
      : role === "user"
        ? "You"
        : role === "assistant"
          ? selected === "pm"
            ? "Project manager"
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
  article.append(copyControl(String(entry.text || entry.summary || ""), "Copy message", "message", entryKey));
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
  const now = new Date();
  const signature = JSON.stringify([selected, history, receipts, localDay(now), hostChecked, host.online, sessionsLoaded, sessions.length, detail?.session?.capabilities?.message]);
  if (signature === messageSignature) return;
  const wasNearBottom = nearLatest();
  const firstRender = !messageSignature;
  const oldTop = ui.timeline.scrollTop;
  const focusedCopy = ui.messages.contains(document.activeElement) ? document.activeElement : null;
  const focusEntry = focusedCopy?.closest("[data-entry-key]")?.dataset.entryKey;
  const focusCopy = focusedCopy?.dataset.copyKey;
  const viewportTop = ui.timeline.getBoundingClientRect().top;
  const anchors = timelineEntries.map((item) => ({ key: item.key, top: item.element.getBoundingClientRect().top - viewportTop, bottom: item.element.getBoundingClientRect().bottom - viewportTop }))
    .filter((item) => item.bottom > 0);
  messageSignature = signature;
  const fragment = document.createDocumentFragment(), used = new Set(), entries = [];
  for (const entry of history) {
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
    const contentSignature = JSON.stringify([item.entry.role, item.entry.text, item.entry.summary, item.entry.at, item.entry.ts, item.entry.source, item.entry.error === true]);
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
  if (!history.length && !receipts.length) {
    const loading = !hostChecked || (host.online && !sessionsLoaded && !selected);
    const title = loading ? "Loading sessions…" : !host.online ? "Your Mac is offline"
      : selected === "pm" ? "New conversation."
      : selected ? (detail?.session?.capabilities?.message ? "Ready when you are." : "No readable history yet.")
      : sessions.filter((s) => s.name !== "foreman-pm").length ? "Choose a conversation" : "No sessions yet";
    const text = loading ? "Checking your execution host for sessions."
      : !host.online ? "Reconnect your Mac to view sessions and continue work."
      : selected === "pm" ? "The PM remembers projects and decisions, not past chats."
      : selected ? (detail?.session?.capabilities?.message ? "Send a task or a follow-up to begin the conversation." : "No readable conversation is available yet. Activity will appear as this session runs.")
      : "Choose an existing conversation or start a Claude or Codex session.";
    fragment.append(emptyState(title, text, !selected && !loading));
  }
  ui.messages.replaceChildren(fragment);
  if (focusEntry && focusCopy) {
    const article = entries.find((item) => String(item.key) === focusEntry)?.element;
    [...(article?.querySelectorAll("[data-copy-key]") || [])].find((button) => button.dataset.copyKey === focusCopy)?.focus({ preventScroll: true });
  }
  if (wasNearBottom || firstRender) ui.timeline.scrollTop = ui.timeline.scrollHeight;
  else {
    const anchor = anchors.find((old) => entries.some((item) => item.key === old.key));
    const element = anchor && entries.find((item) => item.key === anchor.key).element;
    ui.timeline.scrollTop = element ? ui.timeline.scrollTop + element.getBoundingClientRect().top - viewportTop - anchor.top : oldTop;
  }
  updateLatest();
}
function renderApprovals(approvals = []) {
  const signature = JSON.stringify([selected, approvals]);
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
    const form = node("form", "approval");
    form.dataset.approvalKey = feedbackKey;
    form.append(
      node(
        "h3",
        "",
        approval.kind === "question"
          ? "The agent has a question"
          : approval.kind === "unsupported"
            ? "This request needs attention"
            : `Permission requested · ${approval.tool || "Tool"}`,
      ),
    );
    form.append(node("p", "approval-reason", approval.reason || (approval.kind === "question"
      ? "Your answer is needed before the agent can continue."
      : approval.kind === "unsupported" ? "This interaction cannot be answered here."
      : `The agent is requesting permission to use ${approval.tool || "this tool"}.`)));
    const context = approval.input?.command || approval.input?.file_path || approval.input?.path;
    if (typeof context === "string" && context) form.append(node("p", "approval-context", context.length > 180 ? `${context.slice(0, 180)}…` : context));
    if (approval.input && Object.keys(approval.input).length) {
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
    const allow = node(
      "button",
      "btn",
      approval.kind === "question" ? "Send answer" : "Allow once",
    );
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
        ? (approval.kind === "question" ? "Sending answer…" : "Allowing…")
        : (approval.kind === "question" ? "Send answer" : "Allow once");
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
// `record` is false when the history entry already exists (Back/Forward).
async function selectSession(key, record = true) {
  if (selected) setDraft(selected, ui.input.value);
  selected = key;
  deepLinkPending = null;
  hideNotice();
  if (record) recordView(key);
  selectionEpoch++;
  const epoch = selectionEpoch;
  detail = null;
  pmBusy = false;
  pmModelReady = false;
  messageSignature = "";
  resetLatest();
  approvalSignature = "";
  ui.input.value = drafts.get(key) || "";
  autosize();
  clearError();
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
  if (!host.online) showConversationLoading("Conversation unavailable while your Mac is offline. It will open when your Mac reconnects.", true);
  try {
    await refreshSelected();
  } catch (error) {
    if (epoch === selectionEpoch) showRefreshError(error);
  }
}
// Return to the inbox (Back from a conversation, or an unknown deep link). The history
// entry is already correct, or the caller records it.
function showInbox() {
  if (selected) setDraft(selected, ui.input.value);
  selected = null;
  deepLinkPending = null;
  selectionEpoch++;
  detail = null;
  pmBusy = false;
  pmModelReady = false;
  messageSignature = "";
  resetLatest();
  approvalSignature = "";
  conversationLoading = false;
  ui.input.value = "";
  autosize();
  clearError();
  ui.approvals.replaceChildren();
  renderRail();
  renderPmHost();
  renderMessages();
  renderHeading();
}
// The deep-linked session is not on this host: fall back to the inbox with a neutral notice.
function rejectDeepLink() {
  showInbox();
  recordView(null);
  showNotice(UNKNOWN_LINK_NOTICE);
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
  return selected === "pm" ? "Project manager error" : "Error";
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
    alert.append(dot, node("span", "sr-only", "Project manager has an error"));
    // Sit before the PINNED tag when the row has one; otherwise stay visible at the end.
    const pinned = row.querySelector(".pinned");
    if (pinned) pinned.before(alert);
    else row.append(alert);
  } else if (!pmRailError) alert?.remove();
  row.classList.toggle("has-error", !!pmRailError);
  if (pmRailError) {
    row.setAttribute("aria-label", "Project manager, has an error");
    row.title = `Project manager error: ${pmRailError}`;
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
const PLATFORM_LABEL = { darwin: "macOS", linux: "Linux", win32: "Windows", freebsd: "FreeBSD" };
function pmHostOfflineMessage(name) {
  return `Your PM's machine (${name}) is offline.`;
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
function renderPmHost() {
  const bar = $("#pm-host"), active = pmHost?.active || null;
  bar.hidden = selected !== "pm" || !pmHost;
  const offline = !!active && !active.online;
  const label = !pmHost ? "" : active ? `PM on ${active.name} · ${active.online ? "online" : "offline"}` : "No machine runs the PM yet";
  if ($("#pm-host-label").textContent !== label) $("#pm-host-label").textContent = label;
  $("#pm-host-dot").className = `dot ${active?.online ? "online" : active ? "offline" : "unknown"}`;
  const offlineText = offline ? pmHostOfflineMessage(active.name) : "";
  const offlineLine = $("#pm-host-offline");
  if (offlineLine.textContent !== offlineText) offlineLine.textContent = offlineText;
  offlineLine.hidden = !offlineText;
  bar.classList.toggle("is-offline", offline);
  $("#move-pm").hidden = !moveTargets().length;
  if (ui.moveDialog.open) renderMoveList();
}
async function refreshPmHost(epoch) {
  try {
    const result = await api("/api/pm/host");
    if (!authorized || epoch !== authEpoch) return;
    pmHost = readPmHost(result);
  } catch (error) {
    if (!authorized || epoch !== authEpoch) return;
    // A host or relay without the route shows no PM machine; other failures keep the last answer.
    if (error?.status === 404) pmHost = null;
  }
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
  confirm.textContent = moveBusy ? "Moving…" : "Move PM";
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
    meta: [PLATFORM_LABEL[m.platform] || m.platform || "Unknown platform", m.online ? "Online" : "Offline", lastSeenText(m.last_seen)].join(" · "),
    note: m.active ? "Runs the PM now" : !m.online ? "Offline machines can’t take the PM" : "",
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
      if (typeof row.seen === "number" && row.seen > 0) meta.title = new Date(row.seen).toLocaleString();
      text.append(name, meta);
      if (row.note) text.append(node("span", "machine-note", row.note));
      label.append(input, text);
      list.append(label);
    }
    if (!rows.length) list.append(node("p", "field-hint", "No machines have connected to the relay yet."));
    else if (!selectable.size) list.append(node("p", "field-hint", pmHost?.mode === "local"
      ? "This Foreman runs without the cloud relay, so the PM stays on this machine."
      : "No other machine is online. Start Foreman on another machine to move the PM there."));
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
  ui.moveDialog.showModal();
  pushOverlay("move", () => ui.moveDialog.open);
  (ui.moveDialog.querySelector("#move-pm-list input:not(:disabled)") || $("#close-move-pm")).focus();
}
$("#move-pm").addEventListener("click", openMovePm);
for (const selector of ["#close-move-pm", "#cancel-move-pm"])
  $(selector).addEventListener("click", () => ui.moveDialog.close());
ui.moveDialog.addEventListener("close", () => {
  popOverlay("move");
  moveChoice = null;
  moveError();
  if (!authorized) return;
  const opener = moveOpener;
  moveOpener = null;
  // Back to the Move button, or to the conversation when the button has gone away.
  if (opener?.isConnected && !opener.hidden && !opener.closest("[hidden], [inert]")) opener.focus({ preventScroll: true });
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
    showNotice(`The PM now runs on ${active.name}. It starts a new conversation with the same memory.`);
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
async function poll() {
  clearTimeout(pollTimer);
  if (!authorized || polling) return;
  polling = true;
  const epoch = authEpoch;
  try {
    const nextHost = await api("/api/host");
    if (!authorized || epoch !== authEpoch) return;
    host = nextHost;
    hostChecked = true;
    renderHost();
    // The PM machine is answered by the relay even while that machine is offline, so it is
    // read on every poll, exactly once, whether or not the host is online.
    await refreshPmHost(epoch);
    if (!authorized || epoch !== authEpoch) return;
    if (host.online) {
      const rows = await api("/api/sessions");
      if (!authorized || epoch !== authEpoch) return;
      sessions = Array.isArray(rows) ? rows : [];
      sessionsLoaded = true;
      if (deepLinkPending) {
        const key = deepLinkPending;
        deepLinkPending = null;
        if (selected === key && !sessions.some((s) => s.session_key === key)) rejectDeepLink();
      }
      renderRail();
      await refreshSelected().catch(showRefreshError);
      if (!selected) {
        renderMessages();
        renderHeading();
      }
      await refreshPmSummary(epoch);
    } else {
      if (conversationLoading) showConversationLoading("Conversation unavailable while your Mac is offline. It will open when your Mac reconnects.", true);
      renderRail();
      renderHeading();
    }
  } catch (error) {
    if (authorized && epoch === authEpoch) {
      host = { online: false };
      hostChecked = true;
      renderHost();
      renderRail();
      renderHeading();
      $("#connection-banner").textContent =
        `Cannot reach the execution host. ${errorMessage(error)} Retrying automatically.`;
      if (conversationLoading) showConversationLoading("Conversation unavailable while your Mac is offline. Retrying automatically.", true);
    }
  } finally {
    polling = false;
    if (authorized)
      pollTimer = setTimeout(poll, document.hidden ? 10000 : 3000);
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
  sending = true;
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
    if (epoch === authEpoch && authorized) setActionFeedback(key, "send", "Message accepted.");
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
      sending = false;
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
    $("#pm-model-hint").textContent = "Changes apply to the next turn and are saved with the PM.";
  } catch (error) {
    if (epoch !== authEpoch || !authorized) return;
    $("#pm-model-hint").textContent = `Models unavailable: ${errorMessage(error)} Reopen the project manager to retry.`;
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
    $("#project-feedback").textContent = action === "remove" ? "Project removed. Existing sessions are unchanged." : "Project saved on your Mac.";
    $("#new-cwd").focus();
  } catch (error) { if (epoch === authEpoch && revision === projectRevision) $("#project-feedback").textContent = errorMessage(error); }
  finally { button.disabled = false; }
}
$("#remember-project").addEventListener("click", () => changeProject("register"));
$("#rename-project").addEventListener("click", () => changeProject("update"));
$("#remove-project").addEventListener("click", () => changeProject("remove"));
function launchStatus(text, busy = false) {
  $("#launch-status-label").textContent = text;
  $("#launch-status").classList.toggle("is-active", busy);
  $("#launch-status .activity-symbol").hidden = !busy;
}
function cancelLauncher() {
  launchRevision++; launchBusy = false;
  const id = launchJob; launchJob = null;
  if (id && authorized) void post("/api/launch/cancel", { id }).catch(() => {});
}
function setLaunchMode(mode) {
  launchMode = mode;
  $("#launch-brief-panel").hidden = mode !== "brief";
  $("#session-fields").hidden = mode === "brief";
  $("#session-fields").disabled = mode === "brief";
  $("#create-session").hidden = mode === "brief";
  $("#create-session").textContent = mode === "proposal" ? "Confirm and start" : "Start session";
  $("#edit-brief").hidden = mode === "brief";
  $("#start-manually").hidden = mode === "manual";
  $("#launch-reason").hidden = mode !== "proposal";
  updateControls();
}
function manualLaunch(message = "") {
  cancelLauncher();
  if (launchMode === "brief" || !$("#new-prompt").value.trim()) $("#new-prompt").value = $("#launch-brief").value;
  setLaunchMode("manual"); launchStatus(message);
  $("#new-name").focus();
}
async function loadLauncherModels() {
  const request = ++launcherModelRequest, epoch = authEpoch, value = $("#launcher-model").value || "claude-sonnet-5";
  try {
    const result = await api("/api/models?provider=claude");
    if (epoch !== authEpoch || request !== launcherModelRequest || !ui.dialog.open) return;
    const select = $("#launcher-model");
    select.replaceChildren(new Option("claude-sonnet-5 (default)", "claude-sonnet-5"));
    for (const model of result.models || []) if (model.value !== "claude-sonnet-5") select.add(new Option(model.displayName, model.value));
    retainModel(select, value);
    $("#launcher-model-hint").textContent = "Proposes the setup only. The session has its own model selection.";
  } catch (error) {
    if (epoch === authEpoch && request === launcherModelRequest) $("#launcher-model-hint").textContent = `Launcher models unavailable: ${errorMessage(error)} You can start manually.`;
  }
}
$("#launch-brief").addEventListener("input", updateControls);
$("#start-manually").addEventListener("click", () => manualLaunch());
$("#edit-brief").addEventListener("click", () => {
  cancelLauncher(); setLaunchMode("brief"); launchStatus(""); $("#launch-brief").focus();
});
$("#propose-session").addEventListener("click", async () => {
  if (launchBusy || !authorized || !host.online || !$("#launch-brief").value.trim()) return;
  cancelLauncher();
  const revision = launchRevision, epoch = authEpoch, id = crypto.randomUUID();
  launchJob = id; launchBusy = true;
  $("#new-error").hidden = true;
  launchStatus("Working… Proposing your session", true); updateControls();
  const current = () => revision === launchRevision && epoch === authEpoch && authorized && ui.dialog.open;
  try {
    let job = await post("/api/launch/propose", { id, brief: $("#launch-brief").value.trim(), model: $("#launcher-model").value });
    const deadline = Date.now() + 65_000;
    while (current() && job.status === "working") {
      if (Date.now() > deadline) throw new Error("Launcher took too long.");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!current()) return;
      job = await api(`/api/launch?id=${encodeURIComponent(id)}`);
    }
    if (!current()) return;
    if (job.status !== "ready" || !job.proposal) throw new Error(job.error || "Launcher was cancelled or returned no proposal.");
    const proposal = job.proposal;
    $("#new-name").value = proposal.name; $("#new-cwd").value = proposal.cwd;
    $("#new-prompt").value = proposal.text; $("#new-provider").value = proposal.provider;
    $("#launch-reason").textContent = proposal.reason;
    await loadNewModels(proposal.model);
    if (!current()) return;
    await resolveNewProject();
    if (!current()) return;
    launchBusy = false; launchJob = null;
    setLaunchMode("proposal"); launchStatus("Proposal ready. Edit any field, then confirm to start.");
    $("#new-name").focus();
  } catch (error) {
    if (current()) manualLaunch(`${errorMessage(error)} Your brief is preserved below; review the manual form.`);
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
  ui.dialog.showModal();
  pushOverlay("dialog", () => ui.dialog.open);
  setLaunchMode("brief"); launchStatus("");
  void loadLauncherModels();
  void loadNewModels();
  void loadProjects(); void resolveNewProject();
  $("#launch-brief").focus();
}
ui.newButton.addEventListener("click", openNew);
ui.dialog.addEventListener("close", () => {
  popOverlay("dialog");
  cancelLauncher(); launcherModelRequest++;
  projectRevision++; projectPending = false; projectResolution = null; projectSelection = null;
  if (!authorized || creating) return;
  if (dialogOpener?.isConnected && !dialogOpener.closest("[inert]")) dialogOpener.focus({ preventScroll: true });
});
for (const selector of ["#close-dialog", "#cancel-new"])
  $(selector).addEventListener("click", () => ui.dialog.close());
ui.newForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (launchMode === "brief" || launchBusy || creating || !host.online || projectPending || !projectResolution || projectResolution.reference !== $("#new-cwd").value.trim() || !ui.newForm.reportValidity()) return;
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
    $("#new-prompt").value = ""; $("#launch-brief").value = "";
    await selectSession(session.session_key);
  } catch (error) {
    if (epoch !== authEpoch || !authorized) return;
    $("#new-error").textContent =
      `${errorMessage(error)} You can retry with the same details.`;
    $("#new-error").hidden = false;
  } finally {
    if (epoch === authEpoch) {
      creating = false;
      $("#create-session").textContent = launchMode === "proposal" ? "Confirm and start" : "Start session";
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
  if (event.key === "Escape" && !ui.dialog.open && !ui.moveDialog.open && ui.app.classList.contains("nav-open")) {
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
      await authSDK.signOut(firebaseAuth);
    } catch (error) {
      ui.authStatus.textContent = errorMessage(error);
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
const PUSH_NONE_SUMMARY = "On — all notification types are off";
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
  if (!key) {
    if (navOpen()) closeNav();
    if (selected) { showInbox(); recordView(null); }
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
  if (!firebaseAuth || !authSDK) {
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
