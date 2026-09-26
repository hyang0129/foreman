import { test, expect, devices, type Page, type Locator } from "@playwright/test";

// #201 (story #203): the conversation view shows a working summary, not the agent's tool calls.
// While a turn runs, the header's one status line says in plain words what the agent is doing,
// derived from the tool entries the history already carries. Tool calls, tool results, raw JSON,
// paths and subagent/peer chatter are hidden; sending an investigator or a Lead is one compact
// line; prose, user messages, approvals, questions, failures and receipts stay. Galaxy S24
// emulation (360×780 CSS px), as #154's spec.
//
// History shapes follow the host: the Coordinator records { role: "tool", name, summary } for each
// tool call (server/pm.ts: Agent → "<subagent_type>: <description>", start_lead → "<project> /
// <workstream>", anything else → JSON of the input) and { role: "peer", text } for a cross-session
// message; a Codex session records { role: "tool", text: "<itemType>: <command or tool> (<status>)" }.
const { defaultBrowserType: _browser, ...s24 } = devices["Galaxy S24"];
test.use({ ...s24 });

const now = Date.now();
const iso = (ago: number) => new Date(now - ago).toISOString();
const RESULTS = "/Users/hong/.claude/projects/-Users-hong-code-foreman/4f2a9c1e/tool-results/toolu_01AbCdEf.txt";
const REPLY = "PR #156 landed the messaging layout. Two follow-ups are open; nothing needs you.";
const caps = { message: true, interrupt: true, approvals: true };
const WORKER = {
  session_key: "fm:worker", session_id: "worker", provider: "codex", name: "Fix flaky tests", cwd: "/Users/dev/code/app",
  project_name: "app", state: "working", managed: true, capabilities: caps, permission_mode: "auto", updated_at: iso(30_000), current_tool: null,
};
const LEAD = {
  session_key: "fm:lead", session_id: "lead", provider: "claude", name: "lead-triage", cwd: "/Users/dev/code/foreman", project_name: "foreman",
  state: "working", role: "lead", launched_by: "coordinator", workstream: "triage", managed: true, capabilities: caps, permission_mode: "bypass",
  updated_at: iso(10_000), current_tool: "mcp__lead__spawn_session",
};
const OBSERVED = {
  session_key: "claude:observed", session_id: "observed", provider: "claude", name: "Terminal research", cwd: "/Users/dev/code/app",
  state: "working", managed: false, capabilities: { message: false, interrupt: false, approvals: false }, updated_at: iso(5_000), current_tool: "Grep",
};

async function fixture(page: Page) {
  const state = {
    pmHistory: [{ role: "assistant", text: "Coordinator here. What are we working on?", ts: iso(10 * 60_000) }] as any[],
    pmBusy: false,
    sessions: [structuredClone(WORKER), structuredClone(LEAD), structuredClone(OBSERVED)] as any[],
    histories: {} as Record<string, any[]>,
    receipts: {} as Record<string, any[]>,
    approvals: {} as Record<string, any[]>,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let result: any = {}, status = 200;
    if (path === "/api/config") result = { auth: { required: false } };
    else if (path === "/api/host") result = { online: true, host: "Dev Mac" };
    else if (path === "/api/sessions") result = state.sessions;
    else if (path === "/api/session") {
      const key = url.searchParams.get("id")!;
      result = { session: state.sessions.find((s) => s.session_key === key), history: state.histories[key] || [], receipts: state.receipts[key] || [], approvals: state.approvals[key] || [] };
    } else if (path === "/api/pm/history") result = { history: state.pmHistory, busy: state.pmBusy, error: null, model: null };
    else if (path === "/api/models") result = { models: [] };
    else { status = 404; result = { error: "Unknown mock route" }; }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(result) });
  });
  return state;
}
const pollNow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("online")));
const tool = (name: string, summary: string, ago = 0) => ({ role: "tool", name, summary, ts: iso(ago) });

// Nothing a developer should not need to read: tool names, JSON, paths, or the old Activity rows.
const LEAKS = [/ToolSearch/, /mcp__/, /list_projects/, /spawn_session/, /tool-results/, /\/Users\//, /[{}]/, /\bActivity\b/, /\bRead\b/, /\bAgent\b/, /\bGrep\b/,
  /commandExecution/, /fileChange/, /dynamicToolCall/, /\[tool/, /cross-session/i, /(^|\n)(investigator|agent):/, /\/bin\/zsh/,
  // Relative and Windows paths, URLs, and what stripped JSON leaves behind.
  /\w\/\w/, /\w\\\w/, /\s:\w/];
async function expectNoLeaks(...regions: Locator[]) {
  for (const region of regions) {
    const text = await region.innerText();
    for (const leak of LEAKS) expect(text, `${leak} is visible`).not.toMatch(leak);
  }
}
// The visible rows of the conversation, in order, by kind.
const rowKinds = (page: Page) => page.locator("#messages > *:not(.date-separator)").evaluateAll((rows) =>
  rows.filter((row) => (row as HTMLElement).offsetParent !== null).map((row) =>
    row.classList.contains("dispatch-line") ? "dispatch" : row.classList.contains("step-line") ? "step" : row.classList.contains("message") ? [...row.classList].filter((c) => c !== "message")[0] : row.className));
async function expectSpinning(page: Page) {
  const status = page.locator("#activity-status");
  await expect(status).toHaveClass(/is-active/);
  await expect.poll(() => status.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length)).toBeGreaterThan(0);
}

test("a Coordinator turn shows one plain-words status line while it runs, one sent-an-investigator line, and the reply", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await expect(page.getByText("Coordinator here.")).toBeVisible();
  const status = page.locator("#activity-status"), timeline = page.locator("#timeline"), head = page.locator(".conversation-head");

  state.pmHistory.push({ role: "user", text: "What happened on PR #156?", ts: iso(60_000) });
  state.pmBusy = true;
  state.pmHistory.push(tool("ToolSearch", JSON.stringify({ query: "select:mcp__fleet__list_projects,mcp__fleet__resolve_project", max_results: 5 }), 50_000));
  await pollNow(page);
  await expect(status).toHaveText("Checking your projects…");
  await expectSpinning(page);
  state.pmHistory.push(tool("mcp__fleet__list_projects", "{}", 45_000));
  state.pmHistory.push(tool("mcp__fleet__resolve_project", JSON.stringify({ reference: "foreman" }), 44_000));
  await pollNow(page);
  await expect(status).toHaveText("Finding the project…");
  expect(await rowKinds(page)).toEqual(["assistant", "user"]);
  await expectNoLeaks(timeline, head);

  // The investigator is sent: one compact line stays in the conversation.
  // Absolute, relative and Windows paths and a JSON fragment in the description are all dropped.
  state.pmHistory.push(tool("Agent", 'investigator: What happened on PR #156? Check web/app.js, src/app.js, C:\\Users\\x\\a.txt and /Users/hong/code/foreman {"scope":"all"}', 40_000));
  await pollNow(page);
  await expect(status).toHaveText("Asking an investigator: What happened on PR #156? Check and scope all…");
  // The call is recorded before its permission check, so the line says what was asked.
  await expect(page.locator(".dispatch-line")).toHaveText("↗Asked for an investigator: What happened on PR #156? Check and scope all");
  // Its results come back as tool-result files the Coordinator reads (three times, as reported),
  // and a Lead's cross-session note arrives: all hidden.
  for (const ago of [30_000, 25_000, 20_000]) state.pmHistory.push(tool("Read", JSON.stringify({ file_path: RESULTS }), ago));
  state.pmHistory.push(tool("ToolSearch", JSON.stringify({ query: "select:ToolSearch" }), 15_000));
  await pollNow(page);
  await expect(status).toHaveText("Getting ready…");
  state.pmHistory.pop();
  await pollNow(page);
  await expect(status).toHaveText("Reading the results…");
  await expectSpinning(page);
  expect(await rowKinds(page)).toEqual(["assistant", "user", "dispatch"]);
  await expectNoLeaks(timeline, head);

  // The turn ends: the reply, and nothing else new.
  state.pmHistory.push({ role: "assistant", text: REPLY, ts: iso(1000) });
  state.pmBusy = false;
  await pollNow(page);
  await expect(page.getByText(REPLY)).toBeVisible();
  await expect(status).toHaveText("Ready");
  expect(await rowKinds(page)).toEqual(["assistant", "user", "dispatch", "assistant"]);
  await expect(page.locator(".dispatch-line")).toHaveCount(1);
  await expectNoLeaks(timeline, head);
  // Copy last message still copies the reply, not the compact line.
  expect(await page.evaluate(() => (([...document.querySelectorAll("#messages .message")].at(-1) as any).copyText))).toBe(REPLY);

  // Debugging: the steps are off by default and shown only from the conversation menu.
  await page.locator("#conversation-menu-button").tap();
  const toggle = page.getByRole("menuitem", { name: "Show 6 steps" });
  await expect(toggle).toBeVisible();
  await toggle.tap();
  await expect(page.locator(".step-line")).toHaveCount(6);
  await expect(page.locator(".step-line").first()).toContainText("ToolSearch");
  await page.locator("#conversation-menu-button").tap();
  await page.getByRole("menuitem", { name: "Hide steps" }).tap();
  await expect(page.locator(".step-line")).toHaveCount(0);
  await expectNoLeaks(timeline, head);
  // Shown steps belong to one chat: switching away and back turns them off again.
  await page.locator("#conversation-menu-button").tap();
  await page.getByRole("menuitem", { name: "Show 6 steps" }).tap();
  await expect(page.locator(".step-line")).toHaveCount(6);
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await page.locator("#session-list").getByRole("button", { name: /Fix flaky tests/ }).tap();
  await expect(page.locator("#conversation-title")).toContainText("Fix flaky tests");
  await expect(page.locator(".step-line")).toHaveCount(0);
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await page.locator("#select-pm").tap();
  await expect(page.getByText(REPLY)).toBeVisible();
  await expect(page.locator(".step-line")).toHaveCount(0);
});

test("starting a Lead is one compact line; peer messages are hidden; failures and the Coordinator-moved notice stay", async ({ page }) => {
  const state = await fixture(page);
  state.pmHistory.push(
    { role: "user", text: "Start a triage Lead on foreman", ts: iso(9 * 60_000) },
    tool("mcp__leads__list_leads", "{}", 8 * 60_000),
    tool("mcp__leads__start_lead", "foreman / triage", 7 * 60_000),
    { role: "peer", text: "<cross-session-message from=\"lead-triage\">Triaged 12 bugs; details in /Users/dev/notes.md</cross-session-message>", ts: iso(6 * 60_000) },
    { role: "assistant", text: "The triage Lead is running.", ts: iso(5 * 60_000) },
    { role: "system", text: "Coordinator failed: the provider stopped responding.", error: true, ts: iso(4 * 60_000) },
    { role: "system", text: "The Coordinator now runs on machine-b. Send your next message there.", ts: iso(3 * 60_000) },
  );
  await page.goto("/");
  await expect(page.getByText("The triage Lead is running.")).toBeVisible();
  await expect(page.locator(".dispatch-line")).toHaveText("↗Asked to start Lead foreman · triage");
  await expect(page.locator(".message.system.error")).toContainText("provider stopped responding");
  await expect(page.locator(".message.system.pm-moved")).toContainText("now runs on machine-b");
  expect(await rowKinds(page)).toEqual(["assistant", "user", "dispatch", "assistant", "system", "system"]);
  await expectNoLeaks(page.locator("#timeline"));
});

test("at 360×780 a turn with 10 tool calls takes no more height than its reply plus one status line", async ({ page }) => {
  expect(page.viewportSize()).toEqual({ width: 360, height: 780 });
  const state = await fixture(page);
  const reply = (n: number) => `Turn ${n}: ${REPLY}`;
  const steps = [
    tool("ToolSearch", JSON.stringify({ query: "select:mcp__fleet__list_projects" })),
    tool("mcp__fleet__list_projects", "{}"),
    tool("mcp__fleet__resolve_project", JSON.stringify({ reference: "foreman" })),
    tool("Read", JSON.stringify({ file_path: "/Users/hong/code/foreman/README.md" })),
    tool("Read", JSON.stringify({ file_path: RESULTS })),
    tool("Read", JSON.stringify({ file_path: RESULTS })),
    tool("mcp__leads__list_leads", "{}"),
    tool("mcp__leads__read_handoff", JSON.stringify({ lead: "fm:11111111-1111-4111-8111-111111111111" })),
    tool("mcp__fleet__memory_read", "{}"),
    tool("mcp__fleet__log_note", JSON.stringify({ note: "PR #156 landed" })),
  ];
  expect(steps).toHaveLength(10);
  // One timestamp for every entry: a run near midnight must not put a date separator inside a turn.
  const at = new Date().toISOString();
  state.pmHistory = [
    { role: "user", text: "Question one", ts: at },
    { role: "assistant", text: reply(1), ts: at },
    { role: "user", text: "Question two", ts: at },
    ...steps.map((step) => ({ ...step, ts: at })),
    { role: "assistant", text: reply(2), ts: at },
  ];
  await page.goto("/");
  await expect(page.getByText(reply(2))).toBeVisible();
  // The status line's own height, measured in place while a turn runs.
  state.pmBusy = true;
  await pollNow(page);
  await expect(page.locator("#activity-status")).toHaveClass(/is-active/);
  const statusLine = await page.locator("#activity-status").evaluate((el) => el.getBoundingClientRect().height);
  expect(statusLine).toBeGreaterThan(0);
  state.pmBusy = false;
  await pollNow(page);
  await expect(page.locator("#activity-status")).toHaveText("Ready");
  const measure = (question: string, answer: string) => page.evaluate(([question, answer]) => {
    const find = (text: string) => [...document.querySelectorAll("#messages .message")].find((el) => el.textContent!.includes(text))!.getBoundingClientRect();
    const asked = find(question), replied = find(answer);
    // The agent's side of the turn: from the question to the end of the reply.
    return { turn: replied.bottom - asked.bottom, reply: replied.height };
  }, [question, answer]);
  const plain = await measure("Question one", reply(1)), busy = await measure("Question two", reply(2));
  expect(busy.reply).toBe(plain.reply);
  // The spacing before a reply is the same with no tool calls; ten calls add at most one status line.
  const spacing = plain.turn - plain.reply;
  expect(busy.turn).toBeLessThanOrEqual(busy.reply + spacing + statusLine);
  expect(busy.turn).toBeLessThanOrEqual(plain.turn + statusLine);
});

test("a worker chat hides Codex tool rows, says what it is doing, and keeps approvals, questions and failed or uncertain receipts", async ({ page }) => {
  const state = await fixture(page);
  const key = WORKER.session_key;
  state.histories[key] = [
    { id: "u1", role: "user", text: "Fix the flaky login test", at: iso(5 * 60_000) },
    { id: "c1", role: "tool", text: "commandExecution: /bin/zsh -lc 'cat /Users/dev/code/app/src/login.test.ts' (completed)", at: iso(4 * 60_000) },
    { id: "c2", role: "tool", text: "fileChange:  (completed)", at: iso(3 * 60_000) },
    { id: "a1", role: "assistant", text: "The test raced the session refresh; I made it wait for the refresh.", at: iso(2 * 60_000) },
    { id: "u2", role: "user", text: "Also run the suite", at: iso(90_000) },
    { id: "u3", role: "user", text: "And tell the Lead", at: iso(80_000) },
    { id: "c3", role: "tool", text: "dynamicToolCall: send_message (completed)", at: iso(70_000) },
    { id: "c4", role: "tool", text: "commandExecution: /bin/zsh -lc 'npm test' (inProgress)", at: iso(60_000) },
  ];
  state.receipts[key] = [
    { id: "u2", text: "Also run the suite", status: "failed", error: "Codex disconnected", at: iso(90_000) },
    { id: "u3", text: "And tell the Lead", status: "uncertain", at: iso(80_000) },
  ];
  state.approvals[key] = [
    { id: "p1", kind: "permission", tool: "Bash", reason: "Run the test suite", input: { command: "npm test" } },
    { id: "q1", kind: "question", tool: "AskUserQuestion", questions: [{ id: "scope", question: "Which suites should I run?" }] },
  ];
  await page.goto(`/?session=${encodeURIComponent(key)}`);
  await expect(page.getByText("The test raced the session refresh")).toBeVisible();
  await expect(page.locator("#activity-status")).toHaveText("Running tests…");
  await expectSpinning(page);
  expect(await rowKinds(page)).toEqual(["user", "assistant", "user", "user"]);
  await expect(page.locator(".receipt-chip.failed")).toContainText("Failed");
  await expect(page.locator(".receipt-chip.failed")).toContainText("Codex disconnected");
  await expect(page.locator(".receipt-chip.uncertain")).toContainText("Delivery uncertain");
  await expect(page.getByRole("heading", { name: "Permission requested · Bash" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The agent has a question" })).toBeVisible();
  await expect(page.getByText("Which suites should I run?")).toBeVisible();
  await expectNoLeaks(page.locator("#messages"), page.locator(".conversation-head"));
});

test("a Lead chat says what it is doing in plain words and shows starting a worker as one line; an observed chat hides its tool markers", async ({ page }) => {
  const state = await fixture(page);
  state.histories[LEAD.session_key] = [
    { id: "u1", role: "user", text: "Start with the flaky tests", at: iso(5 * 60_000), source: { kind: "coordinator" } },
    { id: "a1", role: "assistant", text: "I'll start a worker on the flaky login test.", at: iso(4 * 60_000) },
    { id: "t1", role: "tool", name: "mcp__lead__list_workers", summary: "{}", at: iso(3 * 60_000) },
    { id: "t2", role: "tool", name: "mcp__lead__spawn_session", summary: JSON.stringify({ name: "fix-tests", cwd: "/Users/dev/code/app" }), at: iso(2 * 60_000) },
  ];
  await page.goto(`/?session=${encodeURIComponent(LEAD.session_key)}`);
  await expect(page.getByText("I'll start a worker")).toBeVisible();
  await expect(page.locator("#activity-status")).toHaveText("Starting a worker…");
  await expectSpinning(page);
  await expect(page.locator(".dispatch-line")).toHaveText("↗Asked to start a worker");
  expect(await rowKinds(page)).toEqual(["user", "assistant", "dispatch"]);
  await expectNoLeaks(page.locator("#messages"), page.locator(".conversation-head"));
  // The session list's preview is in plain words too.
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await expect(page.locator("#session-list")).toContainText("Starting a worker…");
  await expect(page.locator("#session-list")).toContainText("Searching the code…");
  await expectNoLeaks(page.locator("#session-list"));

  state.histories[OBSERVED.session_key] = [{
    id: "observed-tail", role: "system", at: iso(5_000),
    text: `user (${iso(60_000)}): Where is the retry logic?\n\nassistant (${iso(50_000)}): Let me look. [tool Grep]\n\nuser (${iso(40_000)}): [tool result]\n\nassistant (${iso(30_000)}): [tool Read]`,
  }];
  await page.locator("#session-list").getByRole("button", { name: /Terminal research/ }).tap();
  await expect(page.locator("#messages")).toContainText("Where is the retry logic?");
  await expect(page.locator("#messages")).toContainText("Let me look.");
  await expect(page.locator("#activity-status")).toHaveText("Searching the code…");
  await expectNoLeaks(page.locator("#messages"), page.locator(".conversation-head"));
});

// #215 review: the phrase table is a plain object, so a tool named after an Object.prototype
// member ("constructor", "toString", ...) must not read the prototype and render a function (or
// an object) as the status line. Each such name reads as the generic phrase.
test("a tool named after an Object.prototype member reads as the generic phrase", async ({ page }) => {
  const state = await fixture(page);
  state.sessions[0].current_tool = "toString";
  await page.goto("/");
  await expect(page.getByText("Coordinator here.")).toBeVisible();
  const status = page.locator("#activity-status");
  state.pmHistory.push({ role: "user", text: "Go", ts: iso(60_000) });
  state.pmBusy = true;
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "mcp__fleet__constructor"]) {
    state.pmHistory.push(tool(name, "{}", 50_000));
    await pollNow(page);
    await expect(status, name).toHaveText("Working…");
  }
  // Loading a tool with such a name names nothing either.
  state.pmHistory.push(tool("ToolSearch", JSON.stringify({ query: "select:mcp__fleet__constructor" }), 40_000));
  await pollNow(page);
  await expect(status).toHaveText("Getting ready…");
  await expectNoLeaks(page.locator(".conversation-head"));
  // A session's current tool: the list preview and its own status line.
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  const row = page.locator("#session-list").getByRole("button", { name: /Fix flaky tests/ });
  await expect(row.locator(".session-sub")).toHaveText("Working…");
  await row.tap();
  await expect(status).toHaveText("Working…");
  await expect(page.locator(".conversation-head")).not.toContainText("function");
  await expect(page.locator(".conversation-head")).not.toContainText("[object");
});
