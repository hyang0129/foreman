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
let selected = null;
try {
  selected = sessionStorage.getItem("foreman:selected");
} catch {
  /* Storage may be unavailable in private browsing. */
}
let sessions = [],
  detail = null,
  host = { online: false },
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
const actionFeedback = new Map(), approvalFeedback = new Map();
let conversationLoading = false;
let timelineEntries = [], nextEntryKey = 0, newMessages = false;
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
  $("#pm-model-hint").textContent = "Changes apply to the next turn and are saved on your Mac.";
  modelOptions($("#pm-model"), []);
  clearTimeout(pollTimer);
  sessions = [];
  detail = null;
  host = { online: false };
  drafts.clear();
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
function renderHost() {
  $("#host-dot").className = `dot ${host.online ? "online" : "offline"}`;
  $("#host-status").textContent = host.online
    ? `${host.host || "Execution host"} · online`
    : "Execution host offline";
  const banner = $("#connection-banner");
  banner.hidden = !!host.online;
  banner.textContent =
    "Your Mac is disconnected. Showing the last available state. Messages and approvals will be available when it reconnects.";
  updateControls();
}
function renderRail() {
  const focusedKey = document.activeElement?.dataset?.session;
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
  if (!visible.length)
    ui.list.append(
      node(
        "p",
        "rail-empty",
        query
          ? "No sessions match your search."
          : "Your sessions will appear here. Start one above to put an agent to work.",
      ),
    );
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
  const headingSummary = $("#heading-details summary");
  const headingName = detail?.session && selected !== "pm" ? projectName(detail.session) : "";
  if (headingSummary.dataset.project !== headingName) { headingSummary.replaceChildren(node("span", "", "Session details"), ...(headingName ? [node("span", "", ` · ${headingName}`)] : [])); headingSummary.dataset.project = headingName; }
  if (selected === "pm") {
    ui.title.textContent = "Project manager";
    ui.provider.hidden = false;
    ui.provider.textContent = "PINNED";
    ui.subtitle.textContent = pmBusy
      ? "Working · Planning and delegating"
      : "Ready · Your view across the fleet";
    if (!host.online) ui.subtitle.textContent += " · Last known";
  } else if (detail?.session) {
    const s = detail.session;
    ui.title.textContent = s.name || "Session";
    ui.provider.hidden = false;
    ui.provider.textContent = s.provider === "codex" ? "Codex" : "Claude";
    ui.subtitle.textContent = `${LABEL[s.state] || s.state || "Unknown"}${!host.online ? " · Last known" : ""} · ${s.cwd || "Project unavailable"}${s.managed ? ` · ${s.model || "Provider default"} · ${policyLabel(s)}` : " · Monitoring only"}`;
  } else {
    ui.title.textContent = selected ? "Loading session…" : "Your session inbox";
    ui.provider.hidden = true;
    ui.subtitle.textContent = "Choose a session or start something new.";
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
function copyControl(text, label, key) {
  const group = node("div", "copy-control");
  const button = node("button", "btn ghost copy-button", label);
  button.type = "button";
  button.dataset.copyKey = key;
  const feedback = node("span", "copy-feedback");
  feedback.setAttribute("role", "status");
  let pending = false, timer;
  button.addEventListener("click", async () => {
    if (pending) return;
    pending = true;
    clearTimeout(timer);
    feedback.textContent = "";
    feedback.classList.remove("error");
    button.setAttribute("aria-busy", "true");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      feedback.textContent = "Copied";
      timer = setTimeout(() => { feedback.textContent = ""; }, 2500);
    } catch {
      feedback.classList.add("error");
      feedback.textContent = "Could not copy. Allow clipboard access or select and copy the text manually.";
    } finally {
      pending = false;
      button.removeAttribute("aria-busy");
    }
  });
  group.append(button, feedback);
  return group;
}
function appendContent(container, text) {
  // Render plain text and fenced code with DOM nodes. Provider output never enters HTML.
  const parts = String(text || "").split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
  parts.forEach((part, index) => {
    if (!part) return;
    if (index % 2) {
      const pre = node("pre");
      pre.append(node("code", "", part));
      const block = node("div", "code-block");
      block.append(copyControl(part, "Copy code", `code-${index}`), pre);
      container.append(block);
    } else container.append(node("div", "message-body", part));
  });
}
function messageNode(entry, receipt) {
  const role = ["user", "assistant", "tool", "system"].includes(entry.role)
    ? entry.role
    : "system";
  const article = node("article", `message ${role}`);
  const sender = sourceLabel(entry.source);
  const label = node(
    "div",
    "message-label",
    sender
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
  if (entry.at && !Number.isNaN(Date.parse(entry.at))) {
    const time = node(
      "time",
      "",
      new Date(entry.at).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    time.dateTime = entry.at;
    label.append(time);
  }
  article.append(label);
  appendContent(article, entry.text || entry.summary || "");
  article.append(copyControl(String(entry.text || entry.summary || ""), "Copy message", "message"));
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
    article.append(
      node(
        "div",
        `receipt ${["failed", "uncertain"].includes(receipt.status) ? receipt.status : ""}`,
        `${status}${receipt.error ? ` · ${receipt.error}` : ""}`,
      ),
    );
  }
}
function renderMessages(history = [], receipts = []) {
  const signature = JSON.stringify([selected, history, receipts]);
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
  for (const item of entries) {
    if (!item.previous && !identityOf(item)) {
      const previous = [...unmatched].find((old) => !identityOf(old) && sameMetadata(old.entry, item.entry)
        && textOf(item.entry).startsWith(textOf(old.entry)) && textOf(old.entry));
      if (previous) { item.previous = previous; unmatched.delete(previous); }
    }
    const previous = item.previous;
    if (!firstRender && !wasNearBottom && (!previous || textOf(previous.entry) !== textOf(item.entry))) newMessages = true;
    item.key = previous?.key || ++nextEntryKey;
    const contentSignature = JSON.stringify([item.entry.role, item.entry.text, item.entry.summary, item.entry.at, item.entry.ts, item.entry.source]);
    const receiptSignature = JSON.stringify(item.receipt);
    item.element = previous?.contentSignature === contentSignature ? previous.element : messageNode(item.entry, item.receipt);
    if (item.element === previous?.element && previous.receiptSignature !== receiptSignature) renderMessageReceipt(item.element, item.receipt);
    item.contentSignature = contentSignature;
    item.receiptSignature = receiptSignature;
    item.element.dataset.entryKey = String(item.key);
    delete item.previous;
    fragment.append(item.element);
  }
  timelineEntries = entries;
  if (!history.length && !receipts.length)
    fragment.append(
      selected
        ? emptyState(
            selected === "pm"
              ? "A little direction goes a long way."
              : "Ready when you are.",
            selected === "pm"
              ? "Tell your project manager what you want to accomplish. It can check the fleet and delegate the next steps."
              : detail?.session?.capabilities?.message
                ? "Send a task or a follow-up to begin the conversation."
                : "No readable conversation is available yet. Activity will appear as this session runs.",
          )
        : emptyState(
            "Make room for the work.",
            "Start a Claude or Codex session, or pick an existing conversation. Everything that needs you is one click away.",
            true,
          ),
    );
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
    if (approval.reason) form.append(node("p", "", approval.reason));
    if (approval.input && Object.keys(approval.input).length) {
      const details = node("details");
      details.dataset.focusKey = `${feedbackKey}:details`;
      details.open = expanded.has(details.dataset.focusKey);
      details.append(
        node("summary", "", "Review request details"),
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
async function selectSession(key) {
  if (selected) drafts.set(selected, ui.input.value);
  selected = key;
  selectionEpoch++;
  const epoch = selectionEpoch;
  detail = null;
  pmBusy = false;
  pmModelReady = false;
  messageSignature = "";
  resetLatest();
  approvalSignature = "";
  try {
    sessionStorage.setItem("foreman:selected", key);
  } catch {
    /* optional */
  }
  ui.input.value = drafts.get(key) || "";
  autosize();
  clearError();
  showConversationLoading();
  ui.approvals.replaceChildren();
  renderRail();
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
async function poll() {
  clearTimeout(pollTimer);
  if (!authorized || polling) return;
  polling = true;
  const epoch = authEpoch;
  try {
    const nextHost = await api("/api/host");
    if (!authorized || epoch !== authEpoch) return;
    host = nextHost;
    renderHost();
    if (host.online) {
      const rows = await api("/api/sessions");
      if (!authorized || epoch !== authEpoch) return;
      sessions = Array.isArray(rows) ? rows : [];
      renderRail();
      await refreshSelected().catch(showRefreshError);
      if (!selected) {
        renderMessages();
        renderHeading();
      }
    } else {
      if (conversationLoading) showConversationLoading("Conversation unavailable while your Mac is offline. It will open when your Mac reconnects.", true);
      renderRail();
      renderHeading();
    }
  } catch (error) {
    if (authorized && epoch === authEpoch) {
      host = { online: false };
      renderHost();
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
  if (selected) drafts.set(selected, ui.input.value);
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
    drafts.delete(key);
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
    $("#pm-model-hint").textContent = "Changes apply to the next turn and are saved on your Mac.";
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
  setLaunchMode("brief"); launchStatus("");
  void loadLauncherModels();
  void loadNewModels();
  void loadProjects(); void resolveNewProject();
  $("#launch-brief").focus();
}
ui.newButton.addEventListener("click", openNew);
ui.dialog.addEventListener("close", () => {
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
$("#open-nav").addEventListener("click", () => setNav(true));
for (const selector of ["#close-nav", "#nav-backdrop"])
  $(selector).addEventListener("click", () => {
    setNav(false);
    $("#open-nav").focus();
  });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !ui.dialog.open && ui.app.classList.contains("nav-open")) {
    setNav(false);
    $("#open-nav").focus();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});
window.addEventListener("online", poll);
ui.signOut.addEventListener("click", async () => {
  revokeAccess("Sign in to open your session inbox.");
  try {
    await authSDK.signOut(firebaseAuth);
  } catch (error) {
    ui.authStatus.textContent = errorMessage(error);
  }
});
ui.signIn.addEventListener("click", async () => {
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
  renderHost();
  renderRail();
  renderHeading();
  if (selected) showConversationLoading();
  else renderMessages();
  poll();
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
  .addEventListener("change", () => setNav(false));
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
boot();
