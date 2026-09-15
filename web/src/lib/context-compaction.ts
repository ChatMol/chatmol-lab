/**
 * Context compaction: a read-time projection of the canonical transcript.
 *
 * Modeled on dsh-compaction-basic + dsh-compaction-tool-result-pruner:
 *   1. Pressure is measured against the routed model's context window
 *      (threshold ≈ 80% of the window, capped) rather than a fixed number.
 *   2. Oversized tool results in the retained tail are pruned to head + tail
 *      without a model call.
 *   3. The oldest span is condensed into one summary written by a model
 *      (deterministic fallback when no model is available); the summary is
 *      injected as the first user message framed in <compacted_summary>.
 *   4. Compaction is monotonic: a persisted record whose prefix hash matches
 *      the canonical transcript is reused, and later compactions build on it.
 *   5. `/compact` and overflow recovery use the same function with `force`.
 *
 * The canonical session messages are never rewritten; only the projection
 * handed to the model changes.
 */
import * as crypto from "crypto";
import type { ToolDefinition, TurnMessage } from "./tools";
import { completeText } from "./llm-client";
import type { ApiConfig } from "./settings";

export interface ContextCompactionConfig {
  enabled: boolean;
  /** Start compacting when the projected context exceeds this many approx tokens. */
  triggerApproxTokens: number;
  /** Most recent human turns kept verbatim. */
  keepTurns: number;
  /** Budget for the verbatim tail (approx tokens); turns are dropped from keepTurns down to 1 until it fits. */
  retainApproxTokens: number;
  maxSummaryChars: number;
  /** Chars of transcript handed to the summarizing model. */
  maxSummaryInputChars: number;
  /** Tool-result pruning: results longer than the threshold keep head + tail (chars). */
  pruneThresholdChars: number;
  pruneHeadChars: number;
  pruneTailChars: number;
  maxListItems: number;
}

export interface ContextSizeEstimate {
  messageCount: number;
  messageChars: number;
  reasoningChars: number;
  toolCallChars: number;
  systemPromptChars: number;
  toolCount: number;
  toolSchemaChars: number;
  totalChars: number;
  approxTokens: number;
}

export interface ContextCompactionRecord {
  id: string;
  kind: "context_compaction";
  createdAt: number;
  /** Hash of the canonical message prefix this record summarizes. */
  sourceHash: string;
  sourceMessageCount: number;
  retainedStartIndex: number;
  retainedTurns: number;
  summarizedMessages: number;
  originalApproxTokens: number;
  compactedApproxTokens: number;
  droppedReasoningChars: number;
  summarizedToolOutputChars: number;
  summary: string;
  summaryMode?: "model" | "deterministic";
}

export interface ContextProjection {
  compacted: boolean;
  systemPrompt: string;
  turnMessages: TurnMessage[];
  /** Number of projected messages that stand in for the canonical base. */
  baseTurnMessageCount: number;
  retainedStartIndex: number;
  summarizedMessages: number;
  droppedReasoningChars: number;
  summarizedToolOutputChars: number;
  originalSize: ContextSizeEstimate;
  compactedSize: ContextSizeEstimate;
  record?: ContextCompactionRecord;
  reusedRecord?: boolean;
}

export type ContextSummarizer = (input: {
  transcript: string;
  priorSummary: string | null;
  messageCount: number;
  maxSummaryChars: number;
}) => Promise<string | null>;

export interface BuildContextProjectionInput {
  messages: TurnMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
  plan?: unknown[];
  artifacts?: unknown[];
  workspaceFiles?: string[];
  compactions?: unknown[];
  now?: number;
  config?: Partial<ContextCompactionConfig> & { contextWindow?: number };
  /** Compact even below the pressure threshold (/compact, overflow recovery). */
  force?: boolean;
  /** Model-backed summarizer; deterministic fallback when absent or failing. */
  summarize?: ContextSummarizer;
}

const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_RETAIN_RATIO = 0.2;
const DEFAULT_TRIGGER_CAP_TOKENS = 80_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_KEEP_TURNS = 6;
const DEFAULT_MAX_SUMMARY_CHARS = 12_000;
const DEFAULT_MAX_SUMMARY_INPUT_CHARS = 60_000;
const DEFAULT_PRUNE_THRESHOLD_CHARS = 8_192;
const DEFAULT_PRUNE_HEAD_CHARS = 4_096;
const DEFAULT_PRUNE_TAIL_CHARS = 1_024;
const DEFAULT_MAX_LIST_ITEMS = 80;

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getContextCompactionConfig(
  overrides: Partial<ContextCompactionConfig> & { contextWindow?: number } = {},
): ContextCompactionConfig {
  const enabledEnv = process.env.CONTEXT_COMPACTION_ENABLED;
  const enabled = enabledEnv === undefined
    ? true
    : !["0", "false", "off", "no"].includes(enabledEnv.toLowerCase());
  const { contextWindow, ...rest } = overrides;
  const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  const cap = envInt("CONTEXT_COMPACTION_TRIGGER_TOKENS", DEFAULT_TRIGGER_CAP_TOKENS);
  const trigger = Math.max(4_000, Math.min(cap, Math.floor(window * DEFAULT_THRESHOLD_RATIO)));
  const base: ContextCompactionConfig = {
    enabled,
    triggerApproxTokens: trigger,
    keepTurns: envInt("CONTEXT_COMPACTION_KEEP_TURNS", DEFAULT_KEEP_TURNS),
    retainApproxTokens: Math.floor(trigger * DEFAULT_RETAIN_RATIO),
    maxSummaryChars: envInt("CONTEXT_COMPACTION_MAX_SUMMARY_CHARS", DEFAULT_MAX_SUMMARY_CHARS),
    maxSummaryInputChars: envInt("CONTEXT_COMPACTION_MAX_SUMMARY_INPUT_CHARS", DEFAULT_MAX_SUMMARY_INPUT_CHARS),
    pruneThresholdChars: envInt("CONTEXT_COMPACTION_PRUNE_THRESHOLD_CHARS", DEFAULT_PRUNE_THRESHOLD_CHARS),
    pruneHeadChars: envInt("CONTEXT_COMPACTION_PRUNE_HEAD_CHARS", DEFAULT_PRUNE_HEAD_CHARS),
    pruneTailChars: envInt("CONTEXT_COMPACTION_PRUNE_TAIL_CHARS", DEFAULT_PRUNE_TAIL_CHARS),
    maxListItems: envInt("CONTEXT_COMPACTION_MAX_LIST_ITEMS", DEFAULT_MAX_LIST_ITEMS),
  };
  const merged = { ...base, ...rest };
  if (rest.triggerApproxTokens !== undefined && rest.retainApproxTokens === undefined) {
    merged.retainApproxTokens = Math.max(1, Math.floor(rest.triggerApproxTokens * DEFAULT_RETAIN_RATIO));
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function contentLength(content: TurnMessage["content"]): number {
  if (typeof content === "string") return content.length;
  if (!content) return 0;
  return safeJson(content).length;
}

export function estimateContextSize(
  messages: TurnMessage[],
  systemPrompt: string,
  tools: ToolDefinition[] = [],
): ContextSizeEstimate {
  const toolSchemaChars = safeJson(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }))).length;
  const messageChars = messages.reduce((sum, message) => sum + contentLength(message.content), 0);
  const reasoningChars = messages.reduce((sum, message) => sum + (message.reasoning_content?.length ?? 0), 0);
  const toolCallChars = messages.reduce((sum, message) => sum + (message.tool_calls ? safeJson(message.tool_calls).length : 0), 0);
  const systemPromptChars = systemPrompt.length;
  const totalChars = messageChars + reasoningChars + toolCallChars + systemPromptChars + toolSchemaChars;
  return {
    messageCount: messages.length,
    messageChars,
    reasoningChars,
    toolCallChars,
    systemPromptChars,
    toolCount: tools.length,
    toolSchemaChars,
    totalChars,
    approxTokens: Math.ceil(totalChars / 4),
  };
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function isToolResultUserMessage(message: TurnMessage): boolean {
  if (message.role !== "user" || !Array.isArray(message.content)) return false;
  return message.content.some((block) => block?.type === "tool_result");
}

function isHumanUserMessage(message: TurnMessage): boolean {
  return message.role === "user" && !isToolResultUserMessage(message);
}

function blockText(block: Record<string, unknown>): string {
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((item) => {
      if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
        return item.text;
      }
      return safeJson(item);
    }).join("\n");
  }
  return safeJson(block);
}

function messageText(message: TurnMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!message.content) return "";
  return message.content
    .map((block) => {
      if (block.type === "text") return blockText(block);
      if (block.type === "tool_use") return `[tool_use ${String(block.name || "")}] ${safeJson(block.input || {})}`;
      if (block.type === "tool_result") return `[tool_result ${String(block.tool_use_id || "")}] ${blockText(block)}`;
      return blockText(block);
    })
    .filter(Boolean)
    .join("\n");
}

function oneLine(text: string, max = 500): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Head + marker + tail, as in dsh-compaction-tool-result-pruner. */
export function pruneToolText(text: string, config: Pick<ContextCompactionConfig, "pruneThresholdChars" | "pruneHeadChars" | "pruneTailChars">): { text: string; prunedChars: number } {
  const chars = Array.from(text);
  if (chars.length <= config.pruneThresholdChars) return { text, prunedChars: 0 };
  const head = chars.slice(0, config.pruneHeadChars).join("").trimEnd();
  const tail = chars.slice(-config.pruneTailChars).join("").trimStart();
  const removed = chars.length - config.pruneHeadChars - config.pruneTailChars;
  const marker = `\n\n[... ${removed} chars pruned from the middle of this tool result; the full output is kept in the session log — re-run the tool or read the file if you need it ...]\n\n`;
  return { text: `${head}${marker}${tail}`, prunedChars: removed };
}

function collectToolCallNames(messages: TurnMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const toolCall of message.tool_calls || []) {
      const id = typeof toolCall.id === "string" ? toolCall.id : "";
      const fn = toolCall.function as Record<string, unknown> | undefined;
      const name = typeof fn?.name === "string" ? fn.name : "";
      if (id && name) names.set(id, name);
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        const id = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "";
        if (id && name) names.set(id, name);
      }
    }
  }
  return names;
}

function toolOutputsFromMessage(
  message: TurnMessage,
  toolCallNames: Map<string, string>,
): Array<{ label: string; text: string }> {
  if (message.role === "tool") {
    const id = message.tool_call_id || "";
    const name = toolCallNames.get(id) || "tool";
    return [{ label: name, text: typeof message.content === "string" ? message.content : messageText(message) }];
  }
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter((block) => block.type === "tool_result")
    .map((block) => {
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const name = toolCallNames.get(id) || "tool";
      return { label: name, text: blockText(block) };
    });
}

function toolCallsFromMessage(message: TurnMessage): Array<{ name: string; args: string }> {
  const calls: Array<{ name: string; args: string }> = [];
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function as Record<string, unknown> | undefined;
    calls.push({ name: typeof fn?.name === "string" ? fn.name : "tool", args: typeof fn?.arguments === "string" ? fn.arguments : safeJson(fn?.arguments || {}) });
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "tool_use") calls.push({ name: String(block.name || "tool"), args: safeJson(block.input || {}) });
    }
  }
  return calls;
}

function formatPlan(plan: unknown[] | undefined, maxItems: number): string[] {
  if (!Array.isArray(plan) || plan.length === 0) return [];
  return plan.slice(0, maxItems).map((step, index) => {
    if (!step || typeof step !== "object") return `${index + 1}. ${oneLine(String(step), 180)}`;
    const record = step as Record<string, unknown>;
    const title = oneLine(String(record.title || record.id || `Step ${index + 1}`), 140);
    const status = typeof record.status === "string" ? ` [${record.status}]` : "";
    return `${index + 1}. ${title}${status}`;
  });
}

function formatArtifacts(artifacts: unknown[] | undefined, maxItems: number): string[] {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return [];
  return artifacts.slice(0, maxItems).map((artifact) => {
    if (!artifact || typeof artifact !== "object") return oneLine(String(artifact), 180);
    const record = artifact as Record<string, unknown>;
    const name = String(record.name || record.path || "artifact");
    const type = record.type ? ` (${String(record.type)})` : "";
    const path = record.path ? ` - ${String(record.path)}` : "";
    return oneLine(`${name}${type}${path}`, 240);
  });
}

// ---------------------------------------------------------------------------
// Transcript rendering (input for the summarizing model)
// ---------------------------------------------------------------------------

/** Compact textual rendering of a message span for the summarizer. */
export function renderTranscript(messages: TurnMessage[], maxChars: number): string {
  const toolCallNames = collectToolCallNames(messages);
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "tool" || isToolResultUserMessage(message)) {
      for (const output of toolOutputsFromMessage(message, toolCallNames)) {
        const pruned = pruneToolText(output.text.trim(), { pruneThresholdChars: 2_400, pruneHeadChars: 1_800, pruneTailChars: 400 });
        lines.push(`[tool result: ${output.label}]\n${pruned.text}`);
      }
      continue;
    }
    if (message.role === "assistant") {
      const text = typeof message.content === "string" ? message.content : messageText(message);
      if (text.trim()) lines.push(`[assistant]\n${text.trim().slice(0, 6_000)}`);
      for (const call of toolCallsFromMessage(message)) {
        lines.push(`[assistant → tool ${call.name}] ${call.args.slice(0, 600)}`);
      }
      continue;
    }
    if (message.role === "user") {
      lines.push(`[user]\n${messageText(message).trim().slice(0, 6_000)}`);
      continue;
    }
    lines.push(`[${message.role}]\n${messageText(message).slice(0, 2_000)}`);
  }
  const joined = lines.join("\n\n");
  if (joined.length <= maxChars) return joined;
  return `[earlier part of this span omitted: ${joined.length - maxChars} chars]\n\n${joined.slice(-maxChars)}`;
}

// ---------------------------------------------------------------------------
// Deterministic fallback summary
// ---------------------------------------------------------------------------

function appendBounded(lines: string[], line: string, maxChars: number): boolean {
  const nextLength = lines.join("\n").length + line.length + 1;
  if (nextLength > maxChars) return false;
  lines.push(line);
  return true;
}

function buildDeterministicSummary(messages: TurnMessage[], config: ContextCompactionConfig): { summary: string; summarizedToolOutputChars: number } {
  const lines: string[] = [
    "Deterministic summary of earlier conversation (no model was available to condense it). Recent messages below are authoritative.",
    "",
  ];
  const maxChars = config.maxSummaryChars;
  const toolCallNames = collectToolCallNames(messages);
  let summarizedToolOutputChars = 0;

  const userGoals = messages.filter(isHumanUserMessage).map((m) => oneLine(messageText(m), 360)).filter(Boolean).slice(-config.maxListItems);
  if (userGoals.length > 0) {
    appendBounded(lines, "### Earlier user requests", maxChars);
    for (const goal of userGoals) if (!appendBounded(lines, `- ${goal}`, maxChars)) break;
    appendBounded(lines, "", maxChars);
  }
  const assistantNotes = messages
    .filter((m) => m.role === "assistant")
    .map((m) => oneLine(typeof m.content === "string" ? m.content : messageText(m), 420))
    .filter(Boolean)
    .slice(-config.maxListItems);
  if (assistantNotes.length > 0) {
    appendBounded(lines, "### Earlier assistant conclusions", maxChars);
    for (const note of assistantNotes) if (!appendBounded(lines, `- ${note}`, maxChars)) break;
    appendBounded(lines, "", maxChars);
  }
  const toolSummaries: string[] = [];
  for (const message of messages) {
    for (const output of toolOutputsFromMessage(message, toolCallNames)) {
      summarizedToolOutputChars += output.text.length;
      const pruned = pruneToolText(output.text, { pruneThresholdChars: 600, pruneHeadChars: 420, pruneTailChars: 120 });
      toolSummaries.push(`- ${output.label}: ${oneLine(pruned.text, 620)}`);
    }
  }
  if (toolSummaries.length > 0) {
    appendBounded(lines, "### Earlier tool outputs (abridged)", maxChars);
    for (const line of toolSummaries.slice(-config.maxListItems)) if (!appendBounded(lines, line, maxChars)) break;
  }
  return { summary: lines.join("\n").trim(), summarizedToolOutputChars };
}

// ---------------------------------------------------------------------------
// Model summarizer
// ---------------------------------------------------------------------------

/** Summarizer backed by the configured (fast) model; returns null on failure. */
export function createModelSummarizer(apiConfig: ApiConfig | null | undefined): ContextSummarizer {
  return async ({ transcript, priorSummary, messageCount, maxSummaryChars }) => {
    if (!apiConfig?.key || !apiConfig.url) return null;
    try {
      const { text } = await completeText({
        apiConfig,
        system:
          "You condense an AI research agent's conversation so it can continue with less context. " +
          "Write a faithful, compact summary in the same language the user wrote in. Use these sections, omitting empty ones: " +
          "Goal; Constraints & preferences; Work done (tools run, key results with exact numbers, IDs, scores); " +
          "Files & artifacts (exact paths and what they contain); Open problems & next steps; Things the user asked to remember. " +
          "Preserve identifiers, file paths, commands, PDB/UniProt IDs and numeric results exactly. Abbreviate long sequences as first 10 + '...' + last 10 residues with the length. " +
          `Do not add commentary or preamble. Stay under ${maxSummaryChars} characters.`,
        user: [
          priorSummary ? `Previous summary (already condensed, keep its facts):\n${priorSummary}\n\n---\n` : "",
          `Transcript to condense (${messageCount} messages):\n${transcript}`,
        ].join(""),
        maxTokens: Math.min(8192, Math.max(1024, Math.ceil(maxSummaryChars / 2))),
        temperature: 0.1,
        timeoutMs: 120_000,
      });
      const cleaned = text.trim();
      return cleaned ? cleaned.slice(0, maxSummaryChars) : null;
    } catch (err) {
      console.error("Context summarizer failed; using deterministic summary:", err);
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function prefixHash(messages: TurnMessage[], count: number): string {
  return crypto.createHash("sha256").update(safeJson({ count, messages: messages.slice(0, count) }), "utf8").digest("hex");
}

function normalizeRecords(records: unknown[] | undefined): ContextCompactionRecord[] {
  if (!Array.isArray(records)) return [];
  return records.filter((record): record is ContextCompactionRecord => (
    !!record &&
    typeof record === "object" &&
    (record as Record<string, unknown>).kind === "context_compaction" &&
    typeof (record as Record<string, unknown>).sourceHash === "string" &&
    typeof (record as Record<string, unknown>).summary === "string" &&
    typeof (record as Record<string, unknown>).retainedStartIndex === "number"
  ));
}

/** The persisted record (largest prefix) that still matches the canonical transcript. */
export function findApplicableRecord(records: unknown[] | undefined, messages: TurnMessage[]): ContextCompactionRecord | null {
  const candidates = normalizeRecords(records)
    .filter((record) => record.retainedStartIndex > 0 && record.retainedStartIndex <= messages.length)
    .sort((a, b) => b.retainedStartIndex - a.retainedStartIndex || b.createdAt - a.createdAt);
  for (const record of candidates) {
    if (prefixHash(messages, record.retainedStartIndex) === record.sourceHash) return record;
  }
  return null;
}

function sanitizeRetainedMessages(messages: TurnMessage[], config: ContextCompactionConfig): { messages: TurnMessage[]; droppedReasoningChars: number; summarizedToolOutputChars: number } {
  let droppedReasoningChars = 0;
  let summarizedToolOutputChars = 0;
  const sanitized = messages.map((message) => {
    droppedReasoningChars += message.reasoning_content?.length ?? 0;
    let content = message.content;
    if (message.role === "tool" && typeof content === "string") {
      const pruned = pruneToolText(content, config);
      summarizedToolOutputChars += pruned.prunedChars;
      content = pruned.text;
    } else if (isToolResultUserMessage(message) && Array.isArray(content)) {
      content = content.map((block) => {
        if (block.type !== "tool_result") return block;
        const text = blockText(block);
        const pruned = pruneToolText(text, config);
        if (pruned.prunedChars === 0) return block;
        summarizedToolOutputChars += pruned.prunedChars;
        return { ...block, content: pruned.text };
      });
    }
    const next: TurnMessage = { ...message, content };
    delete next.reasoning_content;
    return next;
  });
  return { messages: sanitized, droppedReasoningChars, summarizedToolOutputChars };
}

function buildStateSection(input: BuildContextProjectionInput, config: ContextCompactionConfig): string {
  const lines: string[] = [];
  const planLines = formatPlan(input.plan, Math.min(config.maxListItems, 30));
  if (planLines.length > 0) lines.push("### Current plan", ...planLines.map((l) => `- ${l}`), "");
  const artifactLines = formatArtifacts(input.artifacts, config.maxListItems);
  if (artifactLines.length > 0) lines.push("### Artifacts", ...artifactLines.map((l) => `- ${l}`), "");
  const files = Array.isArray(input.workspaceFiles) ? [...input.workspaceFiles].sort().slice(0, config.maxListItems) : [];
  if (files.length > 0) lines.push("### Workspace files", ...files.map((f) => `- ${f}`), "");
  return lines.join("\n").trim();
}

function buildSummaryMessage(summary: string, state: string): TurnMessage {
  const parts = [
    "[Context notice: the earlier part of this conversation was compacted. The summary below replaces it; the messages after it are verbatim and authoritative.]",
    "<compacted_summary>",
    summary.trim(),
    "</compacted_summary>",
  ];
  if (state) parts.push("", state);
  return { role: "user", content: parts.join("\n") };
}

function retainedStartForTurns(messages: TurnMessage[], keepTurns: number): number {
  let turns = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!isHumanUserMessage(messages[index])) continue;
    turns++;
    if (turns >= keepTurns) return index;
  }
  return 0;
}

/**
 * Start index of the verbatim tail: `keepTurns` human turns, reduced while
 * the (pruned) tail exceeds the retain budget, never below one turn, and
 * always strictly after `minStart` so each compaction makes progress.
 */
function retainedStartForBudget(messages: TurnMessage[], config: ContextCompactionConfig, minStart: number): number {
  for (let turns = Math.max(1, config.keepTurns); turns >= 1; turns--) {
    const start = retainedStartForTurns(messages, turns);
    if (start <= minStart) continue;
    const tail = sanitizeRetainedMessages(messages.slice(start), config).messages;
    const tailTokens = estimateContextSize(tail, "", []).approxTokens;
    if (tailTokens <= config.retainApproxTokens || turns === 1) return start;
  }
  const last = retainedStartForTurns(messages, 1);
  return last > minStart ? last : -1;
}

function uncompacted(input: BuildContextProjectionInput, size: ContextSizeEstimate): ContextProjection {
  return {
    compacted: false,
    systemPrompt: input.systemPrompt,
    turnMessages: [...input.messages],
    baseTurnMessageCount: input.messages.length,
    retainedStartIndex: 0,
    summarizedMessages: 0,
    droppedReasoningChars: 0,
    summarizedToolOutputChars: 0,
    originalSize: size,
    compactedSize: size,
  };
}

function assemble(
  input: BuildContextProjectionInput,
  config: ContextCompactionConfig,
  record: ContextCompactionRecord,
  originalSize: ContextSizeEstimate,
  reused: boolean,
): ContextProjection {
  const retained = sanitizeRetainedMessages(input.messages.slice(record.retainedStartIndex), config);
  const summaryMessage = buildSummaryMessage(record.summary, buildStateSection(input, config));
  const turnMessages = [summaryMessage, ...retained.messages];
  const compactedSize = estimateContextSize(turnMessages, input.systemPrompt, input.tools);
  return {
    compacted: true,
    systemPrompt: input.systemPrompt,
    turnMessages,
    baseTurnMessageCount: turnMessages.length,
    retainedStartIndex: record.retainedStartIndex,
    summarizedMessages: record.summarizedMessages,
    droppedReasoningChars: record.droppedReasoningChars + retained.droppedReasoningChars,
    summarizedToolOutputChars: record.summarizedToolOutputChars + retained.summarizedToolOutputChars,
    originalSize,
    compactedSize,
    reusedRecord: reused,
    ...(reused ? {} : { record }),
  };
}

export async function buildContextProjection(input: BuildContextProjectionInput): Promise<ContextProjection> {
  const config = getContextCompactionConfig(input.config);
  const messages = input.messages;
  const originalSize = estimateContextSize(messages, input.systemPrompt, input.tools);
  if (!config.enabled) return uncompacted(input, originalSize);

  // 1. Reuse the persisted compaction that still matches the transcript.
  const applicable = findApplicableRecord(input.compactions, messages);
  const base = applicable ? assemble(input, config, applicable, originalSize, true) : uncompacted(input, originalSize);
  const currentTokens = base.compactedSize.approxTokens;
  if (!input.force && currentTokens < config.triggerApproxTokens) return base;

  // 2. Under pressure (or forced): condense a larger prefix.
  const minStart = applicable?.retainedStartIndex ?? 0;
  const newStart = retainedStartForBudget(messages, config, minStart);
  if (newStart <= minStart) return base; // nothing more can be condensed safely

  const spanStart = applicable ? applicable.retainedStartIndex : 0;
  const span = messages.slice(spanStart, newStart);
  const transcript = renderTranscript(span, config.maxSummaryInputChars);
  const priorSummary = applicable?.summary ?? null;
  let summary: string | null = null;
  let summaryMode: "model" | "deterministic" = "deterministic";
  if (input.summarize) {
    summary = await input.summarize({ transcript, priorSummary, messageCount: span.length, maxSummaryChars: config.maxSummaryChars });
    if (summary) summaryMode = "model";
  }
  let summarizedToolOutputChars = 0;
  if (!summary) {
    const deterministic = buildDeterministicSummary(span, config);
    summarizedToolOutputChars = deterministic.summarizedToolOutputChars;
    summary = priorSummary ? `${priorSummary}\n\n---\n\n${deterministic.summary}` : deterministic.summary;
  }
  const droppedReasoningChars = span.reduce((sum, m) => sum + (m.reasoning_content?.length ?? 0), 0) + (applicable?.droppedReasoningChars ?? 0);

  const record: ContextCompactionRecord = {
    id: crypto.randomUUID(),
    kind: "context_compaction",
    createdAt: input.now ?? Date.now(),
    sourceHash: prefixHash(messages, newStart),
    sourceMessageCount: messages.length,
    retainedStartIndex: newStart,
    retainedTurns: config.keepTurns,
    summarizedMessages: newStart,
    originalApproxTokens: originalSize.approxTokens,
    compactedApproxTokens: 0,
    droppedReasoningChars,
    summarizedToolOutputChars: summarizedToolOutputChars + (applicable?.summarizedToolOutputChars ?? 0),
    summary,
    summaryMode,
  };
  const projection = assemble(input, config, record, originalSize, false);
  record.compactedApproxTokens = projection.compactedSize.approxTokens;
  return projection;
}

export function mergeProjectedTurnMessages(
  canonicalBaseMessages: TurnMessage[],
  projectedBaseMessageCount: number,
  projectedMessages: TurnMessage[],
): TurnMessage[] {
  return [
    ...canonicalBaseMessages,
    ...projectedMessages.slice(projectedBaseMessageCount),
  ];
}

/** Keep the record list small: newest first, drop records for prefixes that no longer apply is the reader's job. */
export function appendCompactionRecord(existing: unknown[] | undefined, record: ContextCompactionRecord, max = 12): ContextCompactionRecord[] {
  const records = normalizeRecords(existing).filter((r) => r.id !== record.id);
  return [...records, record].slice(-max);
}
