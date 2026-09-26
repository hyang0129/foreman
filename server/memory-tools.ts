// PM memory tools (epic #26, PMM-04): the only way the PM reads or writes its portable memory.
// Built on the `PmMemory` store interface (shared/pm-state.ts), so the same tools work against the
// relay Durable Object and the local-only file store. Tool names match PM_MEMORY_TOOLS on the
// `fleet` MCP server: memory_read, memory_write, memory_edit, log_note.
//
// Error contract with the stores (PMM-03 RelayPmStore/LocalPmStore, PMM-05 wiring):
//   A store rejects with any Error (or object) that has a `code` property equal to a PmErrorCode
//   ('version_conflict', 'too_large', 'invalid', 'unavailable', 'not_active', 'stale_epoch',
//   'already_initialized'). `PmStoreError` below is a convenient class with that shape, but it is
//   not required: detection is structural (`pmErrorCode`). A rejection without a recognized code is
//   reported as a generic store failure. Nothing is retried automatically; every failure is returned
//   to the PM as a tool error with a next step.

import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  PM_DOC_LIMITS, PM_DOC_NAMES, MIN_LOG_ENTRY, MAX_LOG_ENTRY, MAX_LOG_READ, isPmErrorCode,
  type PmMemory, type PmDocName, type PmErrorCode, type Doc,
} from "../shared/pm-state.ts";
import { utf8Length } from "../shared/notify.ts";
import { redactSecrets } from "../shared/redact.ts";

/** Default number of newest log entries memory_read returns. */
export const MEMORY_READ_DEFAULT_LOG = 40;

/** A store rejection carrying a contract error code. Stores may throw this or any Error with a `code: PmErrorCode`. */
export class PmStoreError extends Error {
  readonly code: PmErrorCode;
  constructor(code: PmErrorCode, message: string) {
    super(message);
    this.name = "PmStoreError";
    this.code = code;
  }
}

/** The PmErrorCode on a store rejection, or null when it carries none. Structural: any `{ code }` works. */
export function pmErrorCode(error: unknown): PmErrorCode | null {
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return isPmErrorCode(code) ? code : null;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };
const ok = (o: unknown): ToolResult => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });
const fail = (m: string): ToolResult => ({ content: [{ type: "text", text: m }], isError: true });

function storeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String((error as { message?: unknown })?.message ?? error);
  const text = redactSecrets(raw).replace(/\s+/g, " ").trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Turns a store rejection into a tool error with a clear next step. Never retries. */
export function memoryToolError(action: string, error: unknown): ToolResult {
  const code = pmErrorCode(error);
  const detail = storeMessage(error);
  const said = detail ? ` Store said: ${detail}` : "";
  switch (code) {
    case "version_conflict":
      return fail(`version_conflict: ${action} was not saved because memory changed since you read it. Nothing was saved — re-read memory and retry (call memory_read, then apply your change to the current version).${said}`);
    case "too_large":
      return fail(`too_large: ${action} was not saved because the result is over the size limit. Nothing was saved — summarize (shorten or condense the content, dropping stale detail) and retry.${said}`);
    case "invalid":
      return fail(`invalid: ${action} was rejected by the memory store. Nothing was saved — fix the input and retry.${said}`);
    // #122: `stale_epoch` means the assignment changed since this PM started (it was moved away).
    // `not_active` only says this machine is not the PM host right now: it may never have been
    // (e.g. a new relay connection whose assignment has not arrived), so it claims no move.
    case "not_active":
      return fail(`not_active: ${action} was not saved because this machine is not the active Coordinator host right now. Nothing was saved — tell the developer the memory update did not happen.${said}`);
    case "stale_epoch":
      return fail(`stale_epoch: ${action} was not saved because this machine is no longer the active Coordinator host (the Coordinator was moved). Nothing was saved — tell the developer the memory update did not happen.${said}`);
    case "unavailable":
      return fail(`unavailable: ${action} failed because Coordinator memory is unreachable right now. Nothing was saved — tell the developer the memory update did not happen; try again later.${said}`);
    case "already_initialized":
      return fail(`already_initialized: ${action} was refused by the memory store. Nothing was saved — call memory_read and retry against the current memory.${said}`);
    case null:
    default: {
      // Host transport failures (PMM-03's `disconnected`/`timeout`/`invalid_result`) and unrecognized
      // rejections: the request may have been applied before the answer was lost, so the outcome is
      // unknown. Do not claim nothing was saved.
      const raw = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      const label = typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw) ? `${raw}: ` : "";
      return fail(`${label}${action} failed in the memory store and may or may not have been saved. Call memory_read to check whether your change is there before retrying; if memory stays unreachable, tell the developer the update may not have happened.${said}`);
    }
  }
}

function checkDoc(doc: unknown): string | null {
  return typeof doc === "string" && (PM_DOC_NAMES as readonly string[]).includes(doc) ? null : `invalid: doc must be one of ${PM_DOC_NAMES.join(", ")}.`;
}
function checkVersion(v: unknown): string | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? null : "invalid: expected_version must be the non-negative integer version from memory_read. Call memory_read and retry.";
}
function tooLarge(doc: PmDocName, what: string, text: string): string | null {
  const bytes = utf8Length(text);
  return bytes > PM_DOC_LIMITS[doc]
    ? `too_large: ${what} is ${bytes} bytes; the ${doc} doc limit is ${PM_DOC_LIMITS[doc]} bytes. Nothing was saved — summarize it and retry.`
    : null;
}
function occurrences(haystack: string, needle: string): number {
  let n = 0;
  // Overlapping matches count, as in the stores' exactly-once check (`indexOf(old_text, at + 1)`).
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

/** Collapses whitespace in a log note the same way the old file-based log_note did. */
export function normalizeLogNote(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}

/** The four memory tools, in PM_MEMORY_TOOLS order. Register them on the `fleet` MCP server. */
export function makeMemoryTools(memory: PmMemory): SdkMcpToolDefinition<any>[] {
  const docSchema = z.enum(PM_DOC_NAMES).describe("Which memory doc: projects (one `## <project name>` section per project) or preferences (the developer's standing preferences)");
  const versionSchema = z.number().int().min(0).describe("The doc version you last read with memory_read. A stale version is rejected, never merged");

  const memory_read = tool(
    "memory_read",
    `Read your portable Coordinator memory: the projects and preferences docs with their current versions, and the newest log entries (default ${MEMORY_READ_DEFAULT_LOG}, at most ${MAX_LOG_READ}, oldest first). Use the versions as expected_version for memory_write and memory_edit.`,
    { log_limit: z.number().int().min(1).max(MAX_LOG_READ).optional().describe(`Newest log entries to return (1-${MAX_LOG_READ}, default ${MEMORY_READ_DEFAULT_LOG})`) },
    async ({ log_limit }) => {
      const limit = log_limit === undefined ? MEMORY_READ_DEFAULT_LOG : log_limit;
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LOG_READ) return fail(`invalid: log_limit must be an integer from 1 to ${MAX_LOG_READ}.`);
      try {
        const m = await memory.read();
        const doc = (d: Doc) => ({ content: d.content, version: d.version, updated_at: d.updated_at });
        const log = [...m.log].sort((a, b) => a.seq - b.seq).slice(-limit).map((e) => ({ seq: e.seq, at: e.at, text: e.text }));
        return ok({ initialized: m.initialized, projects: doc(m.projects), preferences: doc(m.preferences), log });
      } catch (error) { return memoryToolError("Reading memory", error); }
    },
    { annotations: { readOnlyHint: true } },
  );

  const memory_write = tool(
    "memory_write",
    `Replace a whole memory doc. projects ≤ ${PM_DOC_LIMITS.projects} bytes, preferences ≤ ${PM_DOC_LIMITS.preferences} bytes. No filesystem paths: key projects by registered name. Pass the version from memory_read as expected_version; on a version conflict re-read memory and retry.`,
    { doc: docSchema, content: z.string().describe("The complete new doc content (markdown)"), expected_version: versionSchema },
    async ({ doc, content, expected_version }) => {
      const invalid = checkDoc(doc) ?? (typeof content !== "string" ? "invalid: content must be a string." : null) ?? checkVersion(expected_version);
      if (invalid) return fail(invalid);
      const big = tooLarge(doc, "content", content);
      if (big) return fail(big);
      try {
        const { version } = await memory.write(doc, content, expected_version);
        return ok({ saved: doc, version });
      } catch (error) { return memoryToolError(`Writing ${doc}`, error); }
    },
  );

  const memory_edit = tool(
    "memory_edit",
    "Replace exactly one occurrence of old_text with new_text in a memory doc. old_text must appear exactly once in the current doc; include enough surrounding text to make it unique. Pass the version from memory_read as expected_version; on a version conflict re-read memory and retry.",
    { doc: docSchema, old_text: z.string().describe("Existing text to replace; must occur exactly once"), new_text: z.string().describe("Replacement text (may be empty to delete)"), expected_version: versionSchema },
    async ({ doc, old_text, new_text, expected_version }) => {
      const invalid = checkDoc(doc)
        ?? (typeof old_text !== "string" ? "invalid: old_text must be a string." : null)
        ?? (typeof new_text !== "string" ? "invalid: new_text must be a string." : null)
        ?? (old_text.length === 0 ? "invalid: old_text must not be empty. To replace the whole doc use memory_write." : null)
        ?? checkVersion(expected_version);
      if (invalid) return fail(invalid);
      const big = tooLarge(doc, "old_text", old_text) ?? tooLarge(doc, "new_text", new_text);
      if (big) return fail(big);
      try {
        const { version } = await memory.edit(doc, old_text, new_text, expected_version);
        return ok({ saved: doc, version });
      } catch (error) {
        const code = pmErrorCode(error);
        if (code === "invalid") {
          // Say plainly whether old_text was missing or not unique. Diagnose against the current doc
          // only after the store refused; the store stays the authority and nothing is retried.
          // Only for `invalid` (a definite refusal): after an ambiguous failure (timeout, lost
          // connection) the edit may have landed, so a changed version is not a conflict.
          try {
            const current = (await memory.read())[doc];
            if (current.version !== expected_version) return memoryToolError(`Editing ${doc}`, new PmStoreError("version_conflict", `expected version ${expected_version}, current version ${current.version}`));
            const n = occurrences(current.content, old_text);
            if (n === 0) return fail(`not_found: old_text does not occur in ${doc} (version ${current.version}). Nothing was saved — call memory_read, copy the exact current text, and retry.`);
            if (n > 1) return fail(`not_unique: old_text occurs ${n} times in ${doc} (version ${current.version}). Nothing was saved — include more surrounding text so it matches exactly once, and retry.`);
          } catch { /* fall through to the store's own error */ }
        }
        return memoryToolError(`Editing ${doc}`, error);
      }
    },
  );

  const log_note = tool(
    "log_note",
    `Append one terse line to the portable Coordinator log (decisions, outcomes). ${MIN_LOG_ENTRY}-${MAX_LOG_ENTRY} characters after whitespace is collapsed. Use memory_write/memory_edit on the projects doc for project status.`,
    { note: z.string().describe(`One line, ${MIN_LOG_ENTRY}-${MAX_LOG_ENTRY} characters`) },
    async ({ note }) => {
      if (typeof note !== "string") return fail("invalid: note must be a string.");
      const text = normalizeLogNote(note);
      if (text.length < MIN_LOG_ENTRY) return fail(`invalid: note must be at least ${MIN_LOG_ENTRY} characters after whitespace is collapsed. Nothing was logged.`);
      if (text.length > MAX_LOG_ENTRY) return fail(`too_large: note is ${text.length} characters; the limit is ${MAX_LOG_ENTRY}. Nothing was logged — summarize it and retry.`);
      try {
        await memory.log(text);
        return ok("Logged.");
      } catch (error) { return memoryToolError("Logging the note", error); }
    },
  );

  return [memory_read, memory_write, memory_edit, log_note];
}
