/**
 * Display model for a stored chat transcript.
 *
 * The server stores the canonical LLM transcript: one assistant message per
 * model turn (OpenAI-style `tool_calls`) followed by `role: "tool"` results.
 * While a run streams, the UI instead builds ONE assistant message whose
 * content blocks interleave text and tool calls, so consecutive calls fold into
 * a single activity line. Reloading used to turn every stored turn into its own
 * message, which rendered one "Ran 1 command" line per call. Stored turns are
 * now converted and then merged per stretch between user messages, so a
 * reloaded conversation groups exactly like a live one.
 */
import type { ContentBlock, Message, ToolCall } from "./types";

type RawRecord = Record<string, unknown>;

export type RenderSegment =
  | { kind: "text"; key: string; text: string }
  | { kind: "activity"; key: string; toolCalls: ToolCall[]; subagentCount: number; thinking: boolean };

function isRecord(value: unknown): value is RawRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseToolArguments(call: RawRecord): Record<string, unknown> {
  const fn = isRecord(call.function) ? call.function : {};
  const raw = fn.arguments ?? call.arguments;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(raw) ? raw : {};
}

/**
 * Stored transcripts keep the tool's output but not whether the call failed, so
 * status has to be re-derived on reload. Scanning the whole output for "error"
 * marks any result that merely contains the word: across the 1460 stored tool
 * results here it flagged 155, including fetched PDB files whose HEADER says
 * SIGNALING PROTEIN, SPAdes runs that finished, and a subagent reporting
 * "Status: success". Real failures announce themselves on the first line
 * ("Error (exit code 1)", "ESMFold error:", "WeMol login failed:"), so only
 * that line is read — 22 fewer false failures, no true one lost.
 */
function looksFailed(result: string): boolean {
  const firstLine = result.slice(0, 200).split("\n", 1)[0].toLowerCase();
  return firstLine.includes("error") || firstLine.includes("failed");
}

/** Blocks for a message that predates contentBlocks: its calls, then its text (the legacy render order). */
function legacyBlocks(message: Message): ContentBlock[] {
  const blocks: ContentBlock[] = (message.toolCalls || []).map((tc) => ({ type: "tool_use", toolCallId: tc.id }));
  if (message.content.trim()) blocks.push({ type: "text", text: message.content });
  return blocks;
}

function combine(first: Message, next: Message): Message {
  const contentBlocks = [...(first.contentBlocks ?? legacyBlocks(first)), ...(next.contentBlocks ?? legacyBlocks(next))];
  const toolCalls = [...(first.toolCalls || []), ...(next.toolCalls || [])];
  const artifacts = [...(first.artifacts || []), ...(next.artifacts || [])];
  const merged: Message = { ...first, content: [first.content, next.content].filter((text) => text.trim()).join("\n\n") };
  delete merged.toolCalls;
  delete merged.artifacts;
  delete merged.contentBlocks;
  if (toolCalls.length > 0) merged.toolCalls = toolCalls;
  if (artifacts.length > 0) merged.artifacts = artifacts;
  if (contentBlocks.length > 0) merged.contentBlocks = contentBlocks;
  return merged;
}

/**
 * Merge consecutive assistant messages (everything the agent did between two
 * user messages) into one. Messages still streaming are never merged.
 */
export function mergeAssistantTurns(messages: Message[]): Message[] {
  const merged: Message[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.role === "assistant" &&
      message.role === "assistant" &&
      !previous.isStreaming &&
      !message.isStreaming
    ) {
      merged[merged.length - 1] = combine(previous, message);
    } else {
      merged.push(message);
    }
  }
  return merged;
}

/** Text carried by a message content field that may be a string or a block array. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.trim())
    .join("\n");
}

/**
 * Tool output by call id, from either wire format: OpenAI sends one
 * `role: "tool"` message per result, Anthropic rides them back as tool_result
 * blocks inside the next user message.
 */
function collectToolResults(records: RawRecord[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const record of records) {
    if (record.role === "tool" && typeof record.tool_call_id === "string") {
      results.set(record.tool_call_id, typeof record.content === "string" ? record.content : "");
      continue;
    }
    if (!Array.isArray(record.content)) continue;
    for (const block of record.content) {
      if (isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        results.set(block.tool_use_id, blockText(block.content));
      }
    }
  }
  return results;
}

function toolCallFrom(
  id: string,
  name: string,
  args: Record<string, unknown>,
  results: Map<string, string>,
): ToolCall {
  const result = results.get(id) || "";
  const hasError = looksFailed(result);
  return { id, name, arguments: args, result, status: hasError ? "error" : "completed", ...(hasError ? { errorOutput: result } : {}) };
}

/**
 * An Anthropic assistant turn: `content` is the model's own block array, so the
 * real interleaving of prose and calls survives — unlike the OpenAI shape,
 * where text and tool_calls are separate fields and the order has to be
 * reconstructed.
 */
function anthropicBlocks(
  record: RawRecord,
  index: number,
  sessionId: string,
  results: Map<string, string>,
): { contentBlocks: ContentBlock[]; toolCalls: ToolCall[]; text: string } {
  const contentBlocks: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];
  const texts: string[] = [];
  for (const block of (record.content as unknown[]).filter(isRecord)) {
    if (block.type === "text" && typeof block.text === "string") {
      if (!block.text.trim()) continue;
      texts.push(block.text);
      contentBlocks.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      contentBlocks.push({ type: "reasoning", text: block.thinking });
    } else if (block.type === "tool_use") {
      const id = typeof block.id === "string" && block.id ? block.id : `tc-${sessionId}-${index}-${toolCalls.length}`;
      const toolCall = toolCallFrom(id, String(block.name || "unknown"), isRecord(block.input) ? block.input : {}, results);
      toolCalls.push(toolCall);
      contentBlocks.push({ type: "tool_use", toolCallId: id });
    }
  }
  return { contentBlocks, toolCalls, text: texts.join("\n\n") };
}

/**
 * Convert a stored transcript into display messages. Both wire formats appear
 * here: OpenAI-compatible providers store `tool_calls` plus `role: "tool"`
 * results, Anthropic stores block arrays and returns results inside a user
 * message. A session can contain both if the provider was switched, so the
 * shape is decided per record rather than for the transcript as a whole.
 */
export function rawTranscriptToMessages(raw: unknown[], sessionId: string, now = Date.now()): Message[] {
  const records = raw.filter(isRecord);
  const toolResults = collectToolResults(records);

  const converted: Message[] = [];
  records.forEach((record, index) => {
    if (record.role !== "user" && record.role !== "assistant") return;

    let content: string;
    let toolCalls: ToolCall[];
    let contentBlocks: ContentBlock[];

    if (Array.isArray(record.content)) {
      // Anthropic. A user message here is the tool_result carrier, not a turn
      // the user typed: it becomes an empty bubble unless it is dropped.
      const blocks = anthropicBlocks(record, index, sessionId, toolResults);
      if (record.role === "user" && blocks.toolCalls.length === 0 && !blocks.text.trim()) return;
      content = blocks.text;
      toolCalls = blocks.toolCalls;
      contentBlocks = blocks.contentBlocks;
    } else {
      content = typeof record.content === "string" ? record.content : "";
      const rawCalls = Array.isArray(record.tool_calls) ? record.tool_calls.filter(isRecord) : [];
      toolCalls = rawCalls.map((call, callIndex) => {
        const fn = isRecord(call.function) ? call.function : {};
        const id = typeof call.id === "string" && call.id ? call.id : `tc-${sessionId}-${index}-${callIndex}`;
        return toolCallFrom(id, String(fn.name || call.name || "unknown"), parseToolArguments(call), toolResults);
      });
      contentBlocks = [];
      const reasoning = record.reasoning_content || record.reasoning;
      if (typeof reasoning === "string" && reasoning) contentBlocks.push({ type: "reasoning", text: reasoning });
      if (content) contentBlocks.push({ type: "text", text: content });
      for (const toolCall of toolCalls) contentBlocks.push({ type: "tool_use", toolCallId: toolCall.id });
    }

    const message: Message = {
      id: typeof record.id === "string" && record.id ? record.id : `db-${sessionId}-${index}`,
      role: record.role,
      content,
      timestamp: typeof record.timestamp === "number" ? record.timestamp : now,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
    };
    // Tool-only turns with nothing displayable are dropped.
    if (message.role === "user" || message.content || toolCalls.length > 0) converted.push(message);
  });

  return mergeAssistantTurns(converted);
}

/** Session payload from the server (raw transcript or frontend snapshot) to display messages. */
export function transcriptToDisplayMessages(raw: unknown[], sessionId: string, now = Date.now()): Message[] {
  // A stored transcript announces itself by a `role: "tool"` result (OpenAI) or
  // by block-array content (Anthropic). Frontend snapshots always hold a string.
  const isStoredTranscript = raw.some(
    (record) => isRecord(record) && (record.role === "tool" || Array.isArray(record.content)),
  );
  if (isStoredTranscript) return rawTranscriptToMessages(raw, sessionId, now);
  const messages = raw.filter(isRecord).map((record, index): Message => ({
    id: typeof record.id === "string" && record.id ? record.id : `db-${sessionId}-${index}`,
    role: record.role === "user" || record.role === "system" ? record.role : "assistant",
    content: typeof record.content === "string" ? record.content : "",
    timestamp: typeof record.timestamp === "number" ? record.timestamp : now,
    ...(Array.isArray(record.toolCalls) ? { toolCalls: record.toolCalls as ToolCall[] } : {}),
    ...(Array.isArray(record.artifacts) ? { artifacts: record.artifacts as Message["artifacts"] } : {}),
    ...(Array.isArray(record.contentBlocks) ? { contentBlocks: record.contentBlocks as ContentBlock[] } : {}),
  }));
  return mergeAssistantTurns(messages);
}

/**
 * Turn interleaved content blocks into prose segments and activity groups:
 * consecutive tool calls / reasoning collapse into one group, text stays prose.
 */
export function segmentBlocks(message: Message): RenderSegment[] {
  const toolCallsMap = new Map((message.toolCalls || []).map((tc) => [tc.id, tc]));
  const blocks = message.contentBlocks || [];
  const segments: RenderSegment[] = [];
  let group: { toolCalls: ToolCall[]; subagentCount: number; thinking: boolean } | null = null;
  const flush = (index: number) => {
    if (group) {
      segments.push({ kind: "activity", key: `a-${index}`, ...group });
      group = null;
    }
  };
  blocks.forEach((block, i) => {
    if (block.type === "text") {
      if (!block.text.trim()) return; // whitespace-only text never splits a group
      flush(i);
      segments.push({ kind: "text", key: `t-${i}`, text: block.text });
      return;
    }
    if (!group) group = { toolCalls: [], subagentCount: 0, thinking: false };
    if (block.type === "reasoning") {
      const isLast = i === blocks.length - 1;
      if (isLast && message.isStreaming) group.thinking = true;
      return;
    }
    if (block.type === "tool_use") {
      const tc = toolCallsMap.get(block.toolCallId);
      if (!tc) return;
      if (tc.name === "run_subagent") group.subagentCount += 1;
      else group.toolCalls.push(tc);
    }
  });
  flush(blocks.length);
  return segments;
}
