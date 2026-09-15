import type { SubagentRun, SubagentTraceItem } from "./types";

/**
 * A rendered unit of a subagent trace: either a tool call paired with its
 * result, or a single user / assistant / status message.
 */
export type SubagentTraceEntry =
  | { kind: "tool"; call?: SubagentTraceItem; result?: SubagentTraceItem }
  | { kind: "message"; item: SubagentTraceItem };

/**
 * Group a raw trace into renderable entries. A `tool_result` is paired with the
 * most recent `tool_call` for the same tool only when nothing else happened in
 * between; otherwise each side becomes its own entry so nothing is hidden.
 */
export function groupSubagentTrace(trace: SubagentTraceItem[]): SubagentTraceEntry[] {
  const entries: SubagentTraceEntry[] = [];
  for (const item of trace) {
    if (item.type === "tool_call") {
      entries.push({ kind: "tool", call: item, result: undefined });
      continue;
    }
    if (item.type === "tool_result") {
      const last = entries[entries.length - 1];
      if (
        last &&
        last.kind === "tool" &&
        last.call &&
        !last.result &&
        (last.call.toolName || "") === (item.toolName || "")
      ) {
        last.result = item;
      } else {
        entries.push({ kind: "tool", call: undefined, result: item });
      }
      continue;
    }
    entries.push({ kind: "message", item });
  }
  return entries;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function countToolCalls(trace: SubagentTraceItem[]): number {
  return trace.reduce((count, item) => (item.type === "tool_call" ? count + 1 : count), 0);
}

const ARGS_PREVIEW_LIMIT = 120;
const ARG_VALUE_LIMIT = 40;

/** One-line preview of tool arguments, mirroring the chat panel's tool blocks. */
export function formatToolArgsPreview(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "";
  if (toolName === "bash" && typeof args.command === "string") {
    return args.command.length > ARGS_PREVIEW_LIMIT
      ? `${args.command.slice(0, ARGS_PREVIEW_LIMIT - 1)}…`
      : args.command;
  }
  const joined = Object.entries(args)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const clipped = text.length > ARG_VALUE_LIMIT ? `${text.slice(0, ARG_VALUE_LIMIT - 1)}…` : text;
      return `${key}=${clipped}`;
    })
    .join(" ");
  return joined.length > ARGS_PREVIEW_LIMIT ? `${joined.slice(0, ARGS_PREVIEW_LIMIT - 1)}…` : joined;
}

function firstLine(text: string | undefined): string {
  return (text || "").split("\n").map((line) => line.trim()).filter(Boolean)[0] || "";
}

function oneLine(text: string | undefined): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

/** Short status line for a run row: what the subagent is doing or how it ended. */
export function describeLastActivity(run: SubagentRun): string {
  if (run.status === "error" && run.error) return firstLine(run.error) || "Failed";
  if (run.status === "completed" && run.summary) return firstLine(run.summary) || "Completed";

  for (let i = run.trace.length - 1; i >= 0; i -= 1) {
    const item = run.trace[i];
    if (item.type === "tool_call") return `Calling ${item.toolName || "tool"}…`;
    if (item.type === "tool_result") {
      return `${item.toolName || "tool"} ${item.success === false ? "failed" : "finished"}`;
    }
    if (item.type === "assistant" || item.type === "user") {
      const text = oneLine(item.content);
      if (text) return text;
    }
    if (item.type === "status" && item.title && item.title !== "Task") {
      return oneLine(item.content) || item.title;
    }
  }

  if (run.status === "error") return "Failed";
  if (run.status === "completed") return "Completed";
  return "Starting…";
}
