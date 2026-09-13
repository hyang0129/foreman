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
const drafts = new Map(),
  sendAttempts = new Map();

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
  if (authRequired) {
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
      const reason =
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
  authEpoch++;
  authorized = false;
  pmModel = ""; pmModelLoaded = false; pmModelReady = false;
  modelOptions($("#pm-model"), []);
  clearTimeout(pollTimer);
  sessions = [];
  detail = null;
  host = { online: false };
  drafts.clear();
  sendAttempts.clear();
  messageSignature = "";
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
  ui.signIn.hidden = false;
  ui.signIn.disabled = false;
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
        `${s.name} ${s.cwd} ${s.provider}`.toLowerCase().includes(query)),
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
            : s.last_message || shortPath(s.cwd);
      row.append(
        node("span", "session-sub", summary),
        node(
          "span",
          "session-meta",
          `${s.provider === "codex" ? "Codex" : "Claude"} · ${s.managed ? "Managed" : "Monitoring"}${!host.online ? " · Last known" : ""}`,
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
  $("#create-session").disabled = !authorized || !host.online || creating;
  ui.input.disabled = !canMessage || sending;
  ui.send.disabled = !canMessage || sending || !ui.input.value.trim();
  ui.send.firstChild.textContent = sending ? "Sending… " : "Send ";
  ui.interrupt.disabled =
    !authorized ||
    !host.online ||
    (isPm ? !pmBusy : !session?.capabilities?.interrupt) ||
    ui.interrupt.dataset.busy === "true";
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
  if (selected === "pm") {
    ui.title.textContent = "Project manager";
    ui.provider.hidden = false;
    ui.provider.textContent = "PINNED";
    ui.subtitle.textContent = pmBusy
      ? "Working · Planning and delegating"
      : "Ready · Your view across the fleet";
  } else if (detail?.session) {
    const s = detail.session;
    ui.title.textContent = s.name || "Session";
    ui.provider.hidden = false;
    ui.provider.textContent = s.provider === "codex" ? "Codex" : "Claude";
    ui.subtitle.textContent = `${LABEL[s.state] || s.state || "Unknown"}${!host.online ? " · Last known" : ""} · ${shortPath(s.cwd)}${s.managed ? ` · ${s.model || "Provider default"}` : " · Monitoring only"}`;
  } else {
    ui.title.textContent = selected ? "Loading session…" : "Your session inbox";
    ui.provider.hidden = true;
    ui.subtitle.textContent = "Choose a session or start something new.";
  }
  updateControls();
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
function appendContent(container, text) {
  // Render plain text and fenced code with DOM nodes. Provider output never enters HTML.
  const parts = String(text || "").split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
  parts.forEach((part, index) => {
    if (!part) return;
    if (index % 2) {
      const pre = node("pre");
      pre.append(node("code", "", part));
      container.append(pre);
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
  return article;
}
function renderMessages(history = [], receipts = []) {
  const signature = JSON.stringify([selected, history, receipts]);
  if (signature === messageSignature) return;
  const wasNearBottom =
    ui.timeline.scrollHeight -
      ui.timeline.scrollTop -
      ui.timeline.clientHeight <
    100;
  const firstRender = !messageSignature;
  messageSignature = signature;
  const fragment = document.createDocumentFragment(),
    used = new Set();
  for (const entry of history) {
    const receipt =
      entry.role === "user"
        ? receipts.find(
            (r) =>
              !used.has(r.id) && (r.id === entry.id || r.text === entry.text),
          )
        : null;
    if (receipt) used.add(receipt.id);
    fragment.append(messageNode(entry, receipt));
  }
  for (const receipt of receipts) {
    if (!used.has(receipt.id))
      fragment.append(messageNode({ ...receipt, role: "user" }, receipt));
  }
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
  if (wasNearBottom || firstRender)
    ui.timeline.scrollTop = ui.timeline.scrollHeight;
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
  approvalSignature = signature;
  ui.approvals.replaceChildren();
  for (const approval of approvals) {
    const sessionKey = selected;
    const form = node("form", "approval");
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
      details.append(
        node("summary", "", "Review request details"),
        node("pre", "", JSON.stringify(approval.input, null, 2)),
      );
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
    const deny = node(
      "button",
      "btn ghost",
      approval.kind === "question" ? "Decline" : "Deny",
    );
    deny.type = "button";
    actions.append(allow, deny);
    form.append(actions);
    const respond = async (decision) => {
      form.dataset.busy = "true";
      updateControls();
      clearError();
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
        form.remove();
        approvalSignature = "";
        await refreshSelected();
      } catch (error) {
        showError(error);
        approvalSignature = "";
        await refreshSelected().catch(() => {});
      } finally {
        form.dataset.busy = "false";
        updateControls();
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
  if (approvals.length && wasNearBottom)
    ui.timeline.scrollTop = ui.timeline.scrollHeight;
}
async function selectSession(key) {
  if (selected) drafts.set(selected, ui.input.value);
  selected = key;
  selectionEpoch++;
  detail = null;
  pmBusy = false;
  pmModelReady = false;
  messageSignature = "";
  approvalSignature = "";
  try {
    sessionStorage.setItem("foreman:selected", key);
  } catch {
    /* optional */
  }
  ui.input.value = drafts.get(key) || "";
  autosize();
  clearError();
  ui.messages.replaceChildren(
    emptyState("Opening conversation…", "Getting the latest messages."),
  );
  ui.approvals.replaceChildren();
  renderRail();
  renderHeading();
  setNav(false);
  try {
    await refreshSelected();
  } catch (error) {
    showError(error);
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
      await refreshSelected().catch(showError);
      if (!selected) {
        renderMessages();
        renderHeading();
      }
    } else {
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
    await refreshSelected();
  } catch (error) {
    showError(
      accepted
        ? `Your message was accepted, but the conversation could not refresh. ${errorMessage(error)}`
        : `${errorMessage(error)} Your message is still in the composer.${key === "pm" ? " Check the conversation before sending again." : " Retry the same message to check delivery without creating a duplicate."}`,
    );
  } finally {
    sending = false;
    updateControls();
    if (selected === key && !ui.input.disabled) ui.input.focus();
  }
});
ui.interrupt.addEventListener("click", async () => {
  if (ui.interrupt.disabled) return;
  const key = selected;
  ui.interrupt.dataset.busy = "true";
  updateControls();
  clearError();
  try {
    await post(
      key === "pm" ? "/api/pm/interrupt" : "/api/session/interrupt",
      key === "pm" ? {} : { id: key },
    );
    await refreshSelected();
  } catch (error) {
    showError(error);
  } finally {
    ui.interrupt.dataset.busy = "false";
    updateControls();
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
async function loadNewModels() {
  const request = ++newModelRequest, epoch = authEpoch;
  const provider = $("#new-provider").value, select = $("#new-model");
  modelOptions(select, []);
  select.disabled = true;
  $("#new-model-hint").textContent = "Loading available models…";
  try {
    const result = await api(`/api/models?provider=${provider}`);
    if (request !== newModelRequest || epoch !== authEpoch || !authorized) return;
    modelOptions(select, result.models || []);
    $("#new-model-hint").textContent = "Uses your provider settings unless you choose a model.";
  } catch (error) {
    if (request !== newModelRequest || epoch !== authEpoch || !authorized) return;
    $("#new-model-hint").textContent = `Models unavailable: ${errorMessage(error)} Reopen this dialog to retry, or use the provider default.`;
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
  } finally { pmModelLoading = false; updateControls(); }
}
$("#pm-model").addEventListener("change", async () => {
  const value = $("#pm-model").value;
  if (pmModelSaving || pmBusy || !host.online) { retainModel($("#pm-model"), pmModel); return; }
  pmModelSaving = true;
  modelRevision++;
  const epoch = authEpoch;
  updateControls();
  try {
    const result = await post("/api/pm/model", { model: value || null });
    if (epoch !== authEpoch || !authorized) return;
    pmModel = result.model || "";
    $("#pm-model-hint").textContent = "Saved. Applies to the next turn.";
  } catch (error) { if (epoch === authEpoch && authorized) showError(error); }
  finally {
    pmModelSaving = false;
    retainModel($("#pm-model"), pmModel);
    updateControls();
    if (epoch === authEpoch && authorized) await refreshSelected().catch(showError);
  }
});
$("#new-provider").addEventListener("change", loadNewModels);
function openNew() {
  if (!authorized || !host.online) return;
  if (!$("#new-cwd").value && detail?.session?.cwd)
    $("#new-cwd").value = detail.session.cwd;
  $("#new-error").hidden = true;
  ui.dialog.showModal();
  void loadNewModels();
  $("#new-name").focus();
}
ui.newButton.addEventListener("click", openNew);
for (const selector of ["#close-dialog", "#cancel-new"])
  $(selector).addEventListener("click", () => ui.dialog.close());
ui.newForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (creating || !host.online || !ui.newForm.reportValidity()) return;
  const values = {
    provider: $("#new-provider").value,
    ...($("#new-model").value ? { model: $("#new-model").value } : {}),
    name: $("#new-name").value.trim(),
    cwd: $("#new-cwd").value.trim(),
    text: $("#new-prompt").value.trim(),
  };
  if (!values.name || !values.cwd || !values.text) return;
  const signature = JSON.stringify(values);
  if (creationAttempt?.signature !== signature)
    creationAttempt = { signature, id: crypto.randomUUID() };
  creating = true;
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
    $("#new-error").textContent =
      `${errorMessage(error)} You can retry with the same details.`;
    $("#new-error").hidden = false;
  } finally {
    creating = false;
    $("#create-session").textContent = "Start session";
    updateControls();
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
  if (event.key === "Escape" && ui.app.classList.contains("nav-open")) {
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
  ui.signOut.hidden = !authRequired;
  $("#account").textContent = user?.email || "Local connection";
  clearError();
  renderHost();
  renderRail();
  renderHeading();
  renderMessages();
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
setNav(false);
boot();
