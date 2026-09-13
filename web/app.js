// Foreman UI: session rail (left), PM chat (center), session detail (right).
const $ = (s) => document.querySelector(s);
const railList = $("#rail-list"), railCount = $("#rail-count"), railFoot = $("#rail-foot");
const chat = $("#chat"), input = $("#input"), composer = $("#composer"), sendBtn = $("#send"), pmStatus = $("#pm-status");
const detail = $("#detail"), detailName = $("#detail-name"), detailBody = $("#detail-body"), tailOut = $("#detail-tail-out");

let sessions = [], selected = null, streaming = null;

const STATE_LABEL = { needs_input: "needs you", working: "working", turn_finished: "finished turn", idle: "idle", unknown: "untracked", ended: "ended", dead: "dead" };
const GROUPS = [["needs_input", "Needs you"], ["working", "Working"], ["turn_finished", "Finished"], ["idle", "Idle"], ["unknown", "Untracked"], ["ended", "Ended"], ["dead", "Dead"]];

function age(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`;
}
function shortCwd(p) { return p ? p.replace(/^\/Users\/[^/]+/, "~") : ""; }

function renderRail() {
  railList.innerHTML = "";
  let n = 0;
  for (const [state, label] of GROUPS) {
    const rows = sessions.filter((s) => s.state === state && s.name !== "foreman-pm");
    if (!rows.length) continue;
    const g = document.createElement("li"); g.className = "rail-group"; g.textContent = `${label} · ${rows.length}`; railList.appendChild(g);
    for (const s of rows) {
      n++;
      const li = document.createElement("li"); li.className = "row" + (selected === s.session_id ? " selected" : ""); li.dataset.id = s.session_id;
      const sub = s.state === "needs_input" ? (s.reason || "waiting") : s.state === "working" ? (s.current_tool ? `${s.current_tool}${s.active_subagents ? ` · ${s.active_subagents} agents` : ""}` : "thinking") : (s.last_message ? s.last_message.replace(/\s+/g, " ").slice(0, 60) : shortCwd(s.cwd));
      li.innerHTML = `<span class="dot ${s.state}"></span><span class="name">${esc(s.name || s.session_id.slice(0, 8))}</span><span class="age">${age(s.updated_at || s.started_at)}</span><span class="sub">${esc(sub)}</span>`;
      li.addEventListener("click", () => select(s.session_id));
      railList.appendChild(li);
    }
  }
  railCount.textContent = String(n);
}

function select(id) {
  selected = id; renderRail();
  const s = sessions.find((x) => x.session_id === id); if (!s) return;
  detail.hidden = false; tailOut.hidden = true;
  detailName.textContent = s.name || s.session_id.slice(0, 8);
  const rows = [
    ["state", `<span class="pill ${s.state}">${STATE_LABEL[s.state] || s.state}</span>${s.reason ? ` ${esc(s.reason)}` : ""}`],
    ["dir", esc(shortCwd(s.cwd))], ["kind", esc(s.kind + (s.entrypoint ? ` · ${s.entrypoint}` : ""))],
    ["updated", s.updated_at ? `${age(s.updated_at)} ago` : "—"], ["started", s.started_at ? `${age(s.started_at)} ago` : "—"],
    ["pid", s.pid ? `${s.pid}${s.alive ? "" : " (gone)"}` : "—"], ["tracked", s.tracked ? "yes (hooks)" : "no (started before hooks)"],
    ["last message", s.last_message ? esc(s.last_message) : "—"], ["last error", s.last_error ? esc(s.last_error) : "—"],
    ["session", `<span class="mono">${s.session_id}</span>`],
  ];
  if (s.bg_id) rows.push(["attach", `<span class="mono">claude attach ${s.bg_id}</span>`]);
  detailBody.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}
$("#detail-close").addEventListener("click", () => { detail.hidden = true; selected = null; renderRail(); });
$("#detail-ask").addEventListener("click", () => { const s = sessions.find((x) => x.session_id === selected); if (!s) return; input.value = `What is the status of session "${s.name || s.session_id.slice(0, 8)}" and does it need anything from me?`; input.focus(); });
$("#detail-tail").addEventListener("click", async () => { const r = await fetch(`/api/session/tail?id=${encodeURIComponent(selected)}`).then((r) => r.json()); tailOut.textContent = r.text || r.error; tailOut.hidden = false; });

// --- chat ---
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function md(text) {
  // Small markdown subset: fenced code, inline code, bold, headings-as-bold, bullet lists, pipe tables, paragraphs.
  const out = []; const lines = text.split("\n"); let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    if (/^\s*\|/.test(l)) { const rows = []; while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]); const cells = rows.filter((r) => !/^\s*\|[\s:-]+\|\s*$/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()))); if (cells.length) out.push(`<table><tr>${cells[0].map((c) => `<th>${c}</th>`).join("")}</tr>${cells.slice(1).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`); continue; }
    if (/^\s*[-*] /.test(l)) { const items = []; while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, "")); out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`); continue; }
    if (/^\s*\d+\. /.test(l)) { const items = []; while (i < lines.length && /^\s*\d+\. /.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\. /, "")); out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ol>`); continue; }
    if (!l.trim()) { i++; continue; }
    const para = []; while (i < lines.length && lines[i].trim() && !/^```|^\s*\||^\s*[-*] |^\s*\d+\. /.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("");
}
function inline(s) { return esc(s).replace(/^#+\s*(.*)$/, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>"); }

function add(cls, html) { const d = document.createElement("div"); d.className = `msg ${cls}`; d.innerHTML = html; chat.appendChild(d); chat.scrollTop = chat.scrollHeight; return d; }
function addUser(text) { add("user", esc(text)); }
function addAssistant(text) { add("assistant", md(text)); }

function onPm(ev) {
  if (ev.type === "turn_start") { streaming = add("assistant cursor", ""); streaming.__text = ""; pmStatus.textContent = "thinking…"; sendBtn.disabled = false; }
  else if (ev.type === "delta") { if (!streaming) { streaming = add("assistant cursor", ""); streaming.__text = ""; } streaming.__text += ev.text; streaming.innerHTML = md(streaming.__text); chat.scrollTop = chat.scrollHeight; }
  else if (ev.type === "tool") { if (streaming) { streaming.classList.remove("cursor"); streaming = null; } add("tool", `<b>${esc(ev.name)}</b> ${esc(ev.summary)}`); }
  else if (ev.type === "assistant_text") { if (streaming) { streaming.classList.remove("cursor"); streaming.innerHTML = md(ev.text || streaming.__text); streaming = null; } else if (ev.text) addAssistant(ev.text); }
  else if (ev.type === "turn_end") { pmStatus.textContent = `idle · last turn $${ev.cost_usd.toFixed(3)}${ev.is_error ? " · error: " + ev.subtype : ""}`; }
  else if (ev.type === "peer") add("peer", esc(ev.text));
  else if (ev.type === "status") { pmStatus.textContent = ev.text; add("status", esc(ev.text)); }
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault(); const text = input.value.trim(); if (!text) return;
  input.value = ""; autosize(); addUser(text); pmStatus.textContent = "sending…";
  await fetch("/api/pm/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
});
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); composer.requestSubmit(); } });
function autosize() { input.style.height = "auto"; input.style.height = Math.min(200, input.scrollHeight) + "px"; }
input.addEventListener("input", autosize);
$("#btn-interrupt").addEventListener("click", () => fetch("/api/pm/interrupt", { method: "POST" }));

// --- boot ---
fetch("/api/pm/history").then((r) => r.json()).then(({ history }) => {
  for (const h of history) { if (h.role === "user") addUser(h.text); else if (h.role === "assistant") addAssistant(h.text); else if (h.role === "tool") add("tool", `<b>${esc(h.name.replace(/^mcp__fleet__/, "fleet."))}</b> ${esc(h.summary)}`); }
});
const es = new EventSource("/api/events");
es.addEventListener("fleet", (e) => { sessions = JSON.parse(e.data); renderRail(); if (selected) select(selected); const pmRow = sessions.find((s) => s.name === "foreman-pm"); railFoot.textContent = `${sessions.filter((s) => s.tracked && s.name !== "foreman-pm").length} tracked by hooks · pm ${pmRow ? pmRow.state.replace("_", " ") : "off"} · ${new Date().toLocaleTimeString()}`; });
es.addEventListener("pm", (e) => onPm(JSON.parse(e.data)));
es.addEventListener("pm_state", (e) => { const s = JSON.parse(e.data); pmStatus.textContent = s.session_id ? `session ${s.session_id.slice(0, 8)} · ${s.busy ? "thinking…" : "idle"}` : "starting…"; });
es.onerror = () => { railFoot.textContent = "reconnecting…"; };
setInterval(renderRail, 30_000);
