# Epic: Make Foreman feel responsive, clear, and comfortable

Status: proposed backlog · Product review: 2026-09-13

## Outcome

A developer checking Foreman on a laptop or phone should immediately understand whether an agent is working, whether their message arrived, and what needs their attention. Reading a long answer and moving between conversations should feel predictable. These improvements use existing session data and controls; they do not change how agents execute work.

## Current experience

Reviewed `web/index.html`, `web/app.js`, `web/style.css`, the MVP plan, and browser tests. No existing GitHub issues were listed at review time.

- Working state, queued/running/completed receipts, offline banners, and approval cards already exist. Working state is text-only, and opening a conversation uses a replacement empty-state message.
- Dark colors already follow the operating system through `prefers-color-scheme`. There is no explicit appearance preference.
- The timeline already avoids scrolling to the bottom when the reader is more than 100 pixels away. There is no new-message affordance when reading older content.
- The rail already groups sessions by state, supports search, and preserves keyboard focus during polling. Mobile navigation, focus rings, and reduced-motion styles also exist.
- Messages support plain text and fenced code blocks. Timestamps show time of day, and code blocks have no copy control.
- Model selectors already exist. The PM selector sits above the composer, while worker model names share a compact subtitle with state and project path. “Provider default” does not establish which concrete model the provider resolved.

## Scope and guardrails

Changes should stay within browser presentation, local appearance preferences, and browser tests. Reuse existing APIs and authoritative state. Do not add agent tools, alter message ordering or delivery, change approvals or permissions, or change model selection behavior. Keep session contents rendered safely as text; no new raw-HTML rendering is needed.

Not part of this epic: native Android packaging, push notifications, background execution, transcript storage, persisted message drafts, new providers, model discovery changes, analytics infrastructure, session archiving/renaming, or automatic retries. Android packaging is a separate exploration, although mobile layout improvements will benefit it.

## Prioritized backlog

P0 is the first polish release. P1 consists of independent follow-ups. Size is relative implementation effort, including browser verification: S is a small focused change; M involves interacting UI states.

| ID | Priority | Improvement | Size | Developer benefit |
| --- | --- | --- | --- | --- |
| UX-01 | P0 | Visible working indicator | S | Know the app is responding during a long turn |
| UX-02 | P0 | System / Light / Dark appearance | S | Read comfortably in any environment |
| UX-03 | P0 | Clear loading and action feedback | M | Distinguish waiting, accepted actions, and failures |
| UX-04 | P0 | Mobile readability and reachable controls | M | Use the inbox comfortably from a phone |
| UX-05 | P1 | New-message marker and jump to latest | M | Read earlier answers without losing new activity |
| UX-06 | P1 | Copy code and message text | S | Move useful output into a developer workflow |
| UX-07 | P1 | Clearer conversation and model header | S | Know who is answering and which model is selected |
| UX-08 | P1 | Easier-to-scan receipts and approval cards | S | Spot the next action without decoding status text |
| UX-09 | P1 | Conversation date separators | S | Understand resumed conversations across days |
| UX-10 | P1 | More helpful empty and search states | S | Recover naturally when there is nothing to show |

## Stories and acceptance criteria

### UX-01 — Visible working indicator

As a developer waiting for an answer, I want a subtle activity indicator so I can tell work is continuing.

- Show an animated dot or spinner beside a visible “Working…” label for PM `busy` or a worker's reported `working` state. Use an existing tool name when available; otherwise keep the wording generic. Do not claim access to internal reasoning or invent a progress percentage.
- Keep the indicator stable across polls. Replace it with the existing input-needed/ready/failed state when reported; a merely queued message does not imply that its own turn is running.
- When the host is offline, stop active animation and show last-known activity as stale. An old `working` value must not imply a live connection.
- Use one polite status announcement on a state transition, not on every animation frame or poll. Reduced-motion mode shows a static symbol with the same label.

### UX-02 — System / Light / Dark appearance

As a developer, I want to choose an appearance without changing my device settings.

- Provide a compact labeled control in the rail/footer with System, Light, and Dark options. System is the initial default and continues to follow OS changes.
- Persist only this preference in browser storage. Reload retains it; unavailable storage falls back gracefully without breaking the inbox.
- Apply the preference before the main interface paints where practical. Cover the sign-in screen, dialogs, banners, code blocks, select menus, and focus states. Update the browser theme color to match.
- All three choices work with keyboard and touch. Text and controls meet the contrast requirements below in both palettes.

### UX-03 — Clear loading and action feedback

As a developer, I want clear feedback while the UI waits without mistaking loading for an empty conversation.

- On initial navigation to a conversation, show a compact loading treatment and label. After data loads, replace it with history or a true empty state. Ordinary background refreshes retain the current content and do not flash a skeleton.
- Use consistent pending labels for existing send, start-session, interrupt, approval, and model-change actions. Preserve existing disabled states and delivery semantics; the indicator must not trigger an additional request.
- Place action failures near the affected control where practical and retain a discoverable error message. Keep long error text readable without widening the viewport. Retain entered content and the existing managed-session retry identity.
- Show success feedback only after the existing response confirms it. Do not label an accepted message as completed or add a success toast for every poll.

### UX-04 — Mobile readability and reachable controls

As a developer using a phone, I want to read status and act on a session without zooming or struggling with small controls.

- Review the current mobile subtitle, badges, and composer hint, which shrink as low as 8–10 CSS pixels. Use a readable secondary-text scale (target at least 12 pixels) and make long names, paths, and model IDs wrap or truncate with a keyboard/touch-accessible way to read the full value.
- Provide at least 44-by-44 CSS pixel touch areas for primary actions, navigation, dismiss controls, and new copy buttons. Decorative icon size may remain smaller.
- At 360-pixel portrait width and short landscape heights, keep the composer and dialog actions reachable with the software keyboard open. Respect safe-area insets. Session navigation and history continue to scroll independently.
- At 200% text zoom, there is no document-level horizontal scroll or clipped action text. Code may scroll horizontally within its own container.
- Preserve predictable focus return when dismissing navigation/dialogs and visible keyboard focus. Verify the new-session dialog and approval questions as well as the main inbox.

### UX-05 — New-message marker and jump to latest

As a developer reading an earlier answer, I want to notice new output without being moved away from my place.

- Keep automatic scrolling when already near the bottom. When reading above it, preserve the visible reading position and show a “New messages ↓” button after new history arrives.
- Activating the button moves to the latest message; it clears when the user reaches the bottom. A simple “Jump to latest” affordance may appear whenever sufficiently far from the bottom.
- Reset the indicator when switching conversations. Polling the same entries or changing a receipt label does not create a false new-message notification. No unread state is stored on the server.
- The button is keyboard accessible, does not cover the composer or approval actions, and uses instant scrolling under reduced motion.

### UX-06 — Copy code and message text

As a developer, I want to copy a command or answer accurately without fiddling with text selection on my phone.

- Add a labeled Copy control to fenced code blocks and a quiet Copy message action. Copy the original text rather than timestamps, role labels, receipts, or button labels.
- Show brief “Copied” feedback only after clipboard success; explain a denied clipboard operation without losing focus or changing the message.
- Controls appear on keyboard focus as well as hover and remain discoverable on touch devices. Copying never executes code or sends it to a session.

### UX-07 — Clearer conversation and model header

As a developer, I want the conversation to clearly identify the agent answering my messages.

- Give the PM header a clear “Claude · Project manager” identity and show the current selection near it. Keep worker provider, selected model, project, and state visually distinct instead of relying on one crowded line.
- If the selected value is Provider default, label it “Provider default” and explain that provider settings determine the model. Never display an inferred concrete model as verified; discovering the resolved model is outside this epic.
- Add nearby, concise help that the PM model controls its replies and planning while newly launched agents have their own selection. Preserve the existing busy lock and next-turn semantics.
- Full model and project text remains accessible on mobile and with a keyboard. A header layout change must not consume most of the phone's conversation area.

### UX-08 — Easier-to-scan receipts and approval cards

As a developer, I want a quick visual distinction between work progressing and a request that needs me.

- Pair existing queued/running/completed/failed/uncertain labels with consistent small icons or chips. Color is supplementary, never the sole distinction.
- Give approval cards a clear request title, reason, and action hierarchy; make long tool input collapsible presentation if useful, with an accessible Show details control. Keep enough context visible to understand what is being approved.
- Preserve the meaning of Allow/Deny and uncertainty warnings. Do not preselect an approval decision, change its scope, add automatic submission, or replace “uncertain” with “failed.”
- Existing question answers and keyboard focus survive polling while the card is open. A collapsed detail region does not discard any information.

### UX-09 — Conversation date separators

As a developer returning to an older session, I want to know which day each exchange belongs to.

- Insert Today / Yesterday / localized date separators from existing message timestamps and expose the full local date and time through an accessible timestamp description.
- Keep the authoritative message order, including receipt-only entries. Missing or invalid timestamps receive a neutral fallback rather than an invented date.
- Separators remain quiet in both themes and do not add repeated screen-reader announcements during polling.

### UX-10 — More helpful empty and search states

As a developer, I want an empty screen to explain my next available step.

- Distinguish no sessions, no search matches, an empty managed conversation, an observed session with no readable history, loading, and an offline host. Reuse the existing accurate capability-specific copy.
- For no search matches, offer a Clear search action and return focus to search. For no sessions, retain the existing Start a session action and its host-availability rules.
- Keep copy short and specific. Avoid example buttons that immediately send a prompt, trigger paid work, or create a session.

## Shared accessibility and responsive requirements

- Normal text targets a minimum 4.5:1 contrast ratio; large text and essential control/focus boundaries target 3:1. Verify both themes, warnings, errors, and disabled-state explanations.
- Every new control has an accessible name and visible focus. Use semantic buttons and labels. Announce consequential state transitions politely and errors clearly, without repeatedly announcing the entire transcript.
- Honor `prefers-reduced-motion` for animations as well as transitions. Layout must remain understandable with animation completely disabled.
- Test desktop and 360-pixel mobile viewports, portrait/landscape, keyboard-only navigation, text zoom, and touch input. Verify with an actual Android browser for software-keyboard and safe-area behavior; desktop emulation alone is not sufficient.
- Preserve current safe text rendering, independent rail/history scrolling, sign-out cleanup, composer contents on failure, and approval-answer preservation.

## Delivery and verification

Ship UX-01 through UX-04 first, then choose P1 stories independently. There is no need to wait for native packaging. Define shared appearance tokens and status styling while implementing UX-01/02 so subsequent stories reuse them.

Use the existing browser fixtures to verify visible behavior: PM and worker activity transitions, stale/offline state, theme persistence and OS preference changes, loading-to-empty transitions, action errors, reduced motion, and mobile layout. Add focused coverage for each P1 story when it ships. Extend the existing scrolling, approval, provider-output safety, and model-selection cases where relevant rather than creating tests that duplicate CSS implementation.

Completion means a developer can identify whether the PM is working, select an appearance, recognize a pending or failed action, and operate the existing inbox comfortably on a phone. All current message-delivery, approval, authentication, and provider tests must remain green. No new telemetry is necessary to evaluate this release.
