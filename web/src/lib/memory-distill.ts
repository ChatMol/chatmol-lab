/**
 * Automatic memory distillation: after a run, the fast model reads the recent
 * transcript plus the current memory index and proposes up to a few durable
 * entries. This is the former `knowledge-summarizer` subagent turned into a
 * background step. Failures are logged and never surface as run errors.
 */
import { completeText } from "./llm-client";
import {
  isMemoryScope,
  isMemoryType,
  listMemories,
  saveMemory,
  validateMemoryInput,
  type MemoryEntry,
  type MemoryInput,
  type MemoryOptions,
} from "./memory";
import type { ApiConfig } from "./settings";
import type { TurnMessage } from "./tools";

export const DISTILL_MAX_ENTRIES = 3;
export const DISTILL_TRANSCRIPT_MAX_CHARS = 12_000;
export const DISTILL_TIMEOUT_MS = 20_000;

const DISTILLER_SYSTEM = `Role: knowledge summarizer for a computational-biology research assistant.
You read the end of a work session and decide what is worth remembering for future sessions.
- Track durable user context: research goals, preferred computational workflows and backends, common file conventions, WeMol CLI usage patterns (module/flow ids, parameter keys that worked), database endpoints that worked, corrections the user gave about how to work.
- Summarize only reusable knowledge, not transient reasoning, not the content of files that live in the workspace, and never credentials or personal data beyond the research context.
- Prefer updating an existing entry (reuse its exact name) over creating a near-duplicate.
- Include caveats and exact command patterns when learned from successful runs.
Types, which are not interchangeable:
- "feedback": something THE USER told you about how to work — a correction, an instruction, or an explicit confirmation. Never your own approach, however well it worked. Include "user_quote" with the user's own words, copied from their message.
- "user": who the user is — role, field, expertise, standing preferences they stated.
- "project": goals, constraints and decisions of the current work.
- "reference": reusable tool knowledge — endpoints, module ids, parameter keys, command patterns that worked.
A method you chose yourself is "reference" or "project", not "feedback".
Return ONLY a JSON array (no prose, no code fence). Each item: {"name": kebab-case, "description": one line, "type": "user"|"feedback"|"project"|"reference", "scope": "workspace"|"global", "content": markdown up to ~800 chars, "reason": why this is durable, "user_quote": required for type "feedback"}.
Use scope "workspace" for facts about this project/session's files, jobs and goals; "global" for the user's general preferences, corrections and reusable tool knowledge.
Return [] when nothing durable was learned. At most ${DISTILL_MAX_ENTRIES} items.`;

function messageText(message: TurnMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        const record = block as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
        if (record.type === "tool_use" || record.type === "tool_result") return `[${String(record.type)}] ${JSON.stringify(record.input ?? record.content ?? "").slice(0, 400)}`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.map((call) => `[tool_call] ${JSON.stringify(call).slice(0, 400)}`).join("\n");
  }
  return "";
}

/** Tail of the transcript, oldest first, bounded by characters. */
export function renderRecentTranscript(messages: TurnMessage[], maxChars = DISTILL_TRANSCRIPT_MAX_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.hidden) continue;
    const text = messageText(message).trim();
    if (!text) continue;
    const line = `[${message.role}] ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join("\n\n");
}

/** A run is worth distilling when it did real work. */
export function shouldDistill(messages: TurnMessage[]): boolean {
  const visible = messages.filter((message) => !message.hidden);
  if (visible.length < 2) return false;
  const toolWork = visible.some((message) => Array.isArray(message.tool_calls) && message.tool_calls.length > 0 || message.role === "tool");
  const longEnough = visible.reduce((sum, message) => sum + messageText(message).length, 0) > 600;
  return toolWork || longEnough;
}

/** Parse the model's JSON array into validated inputs; invalid items are dropped. */
function normalizeForQuoteMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * `feedback` means the user told us how to work. A distiller left to itself
 * files its own successful approach that way, and it then reads back as a
 * standing user preference in every later session. An entry only keeps the
 * type when its quote is actually in a user message.
 */
export function verifyFeedbackType(entry: { type: string; user_quote?: string }, userText: string): "keep" | "downgrade" {
  if (entry.type !== "feedback") return "keep";
  const quote = normalizeForQuoteMatch(entry.user_quote || "");
  if (quote.length < 8) return "downgrade";
  return normalizeForQuoteMatch(userText).includes(quote) ? "keep" : "downgrade";
}

/** Concatenated user messages, the only place `feedback` may come from. */
export function userMessageText(messages: TurnMessage[]): string {
  return messages.filter((m) => m.role === "user").map(messageText).join("\n");
}

export function parseDistillOutput(text: string, max = DISTILL_MAX_ENTRIES, userText = ""): MemoryInput[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: MemoryInput[] = [];
  for (const item of parsed) {
    if (out.length >= max) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    try {
      const declared = isMemoryType(record.type) ? record.type : ("project" as const);
      const verified = verifyFeedbackType(
        { type: declared, user_quote: typeof record.user_quote === "string" ? record.user_quote : "" },
        userText,
      ) === "keep" ? declared : ("reference" as const);
      out.push(validateMemoryInput({
        name: typeof record.name === "string" ? record.name : "",
        description: typeof record.description === "string" ? record.description : "",
        type: verified,
        scope: isMemoryScope(record.scope) ? record.scope : "workspace",
        content: typeof record.content === "string" ? record.content : "",
      }));
    } catch {
      // drop invalid candidates silently
    }
  }
  return out;
}

export interface DistillResult {
  saved: MemoryEntry[];
  skipped: boolean;
  error?: string;
}

/** Run one distillation pass and persist the results. */
export async function distillMemories(
  messages: TurnMessage[],
  apiConfig: ApiConfig,
  o: MemoryOptions,
): Promise<DistillResult> {
  if (!apiConfig.key || !shouldDistill(messages)) return { saved: [], skipped: true };
  const transcript = renderRecentTranscript(messages);
  if (!transcript) return { saved: [], skipped: true };
  const existing = listMemories(o);
  const index = existing.length
    ? existing.map((entry) => `- ${entry.name} (${entry.type}, ${entry.scope}): ${entry.description}`).join("\n")
    : "(empty)";
  const user = `Current memory index:\n${index}\n\nWorkspace memory ${o.cwd ? "is available" : "is NOT available (use scope global only)"}.\n\nRecent transcript:\n${transcript}\n\nReturn the JSON array now.`;
  try {
    const result = await completeText({ apiConfig, system: DISTILLER_SYSTEM, user, maxTokens: 1200, temperature: 0, timeoutMs: DISTILL_TIMEOUT_MS });
    const candidates = parseDistillOutput(result.text, DISTILL_MAX_ENTRIES, userMessageText(messages))
      .filter((candidate) => o.cwd || candidate.scope === "global");
    const saved: MemoryEntry[] = [];
    for (const candidate of candidates) {
      try {
        saved.push(saveMemory(candidate, o));
      } catch (err) {
        console.warn(`[memory] distill: skipped "${candidate.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { saved, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[memory] distill failed: ${message}`);
    return { saved: [], skipped: false, error: message };
  }
}
