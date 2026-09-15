import { describe, expect, it } from "vitest";

import {
  countToolCalls,
  describeLastActivity,
  formatDuration,
  formatToolArgsPreview,
  groupSubagentTrace,
} from "./subagent-trace";
import type { SubagentRun, SubagentTraceItem } from "./types";

function item(partial: Partial<SubagentTraceItem> & Pick<SubagentTraceItem, "type">): SubagentTraceItem {
  return { id: `${partial.type}-${Math.random()}`, ts: 1000, ...partial };
}

function run(partial: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "run-1",
    agentId: "general",
    name: "通用子 Agent",
    task: "Refold 1PGA with OpenFold2",
    status: "running",
    startedAt: 0,
    updatedAt: 0,
    trace: [],
    ...partial,
  };
}

describe("groupSubagentTrace", () => {
  it("pairs a tool call with the following result for the same tool", () => {
    const call = item({ type: "tool_call", toolName: "bash", arguments: { command: "ls" } });
    const result = item({ type: "tool_result", toolName: "bash", content: "a.txt", success: true });
    const entries = groupSubagentTrace([call, result]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool", call, result });
  });

  it("leaves a tool call unpaired while its result is still pending", () => {
    const call = item({ type: "tool_call", toolName: "bash" });
    const entries = groupSubagentTrace([call]);
    expect(entries).toEqual([{ kind: "tool", call, result: undefined }]);
  });

  it("does not pair results across an intervening assistant message or a different tool", () => {
    const call = item({ type: "tool_call", toolName: "bash" });
    const other = item({ type: "tool_result", toolName: "read_file", content: "x" });
    const text = item({ type: "assistant", title: "Assistant", content: "thinking" });
    const late = item({ type: "tool_result", toolName: "bash", content: "done" });
    const entries = groupSubagentTrace([call, other, text, late]);
    expect(entries.map((e) => e.kind)).toEqual(["tool", "tool", "message", "tool"]);
    expect(entries[0]).toMatchObject({ kind: "tool", call, result: undefined });
    // an orphan result becomes its own tool entry without a call
    expect(entries[1]).toMatchObject({ kind: "tool", call: undefined, result: other });
    expect(entries[3]).toMatchObject({ kind: "tool", call: undefined, result: late });
  });

  it("keeps user, assistant and status items as message entries in order", () => {
    const task = item({ type: "status", title: "Task", content: "do it" });
    const user = item({ type: "user", title: "You", content: "hi" });
    const entries = groupSubagentTrace([task, user]);
    expect(entries).toEqual([
      { kind: "message", item: task },
      { kind: "message", item: user },
    ]);
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-50)).toBe("0s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
  });
});

describe("countToolCalls", () => {
  it("counts only tool_call items", () => {
    const trace = [
      item({ type: "tool_call", toolName: "bash" }),
      item({ type: "tool_result", toolName: "bash" }),
      item({ type: "tool_call", toolName: "read_file" }),
      item({ type: "assistant", content: "ok" }),
    ];
    expect(countToolCalls(trace)).toBe(2);
  });
});

describe("formatToolArgsPreview", () => {
  it("shows the bash command verbatim", () => {
    expect(formatToolArgsPreview("bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("joins other arguments as key=value pairs and truncates long values", () => {
    const preview = formatToolArgsPreview("nvidia_openfold2", { sequence: "M".repeat(100), name: "1pga" });
    expect(preview.startsWith("sequence=MMMM")).toBe(true);
    expect(preview).toContain("name=1pga");
    expect(preview.length).toBeLessThanOrEqual(120);
  });

  it("returns an empty string when there are no arguments", () => {
    expect(formatToolArgsPreview("wait", {})).toBe("");
    expect(formatToolArgsPreview("wait", undefined)).toBe("");
  });
});

describe("describeLastActivity", () => {
  it("prefers the error message for failed runs", () => {
    expect(describeLastActivity(run({ status: "error", error: "boom" }))).toBe("boom");
  });

  it("prefers the summary for completed runs", () => {
    expect(describeLastActivity(run({ status: "completed", summary: "All done.\nDetails..." }))).toBe("All done.");
  });

  it("describes a pending tool call while running", () => {
    const trace = [item({ type: "tool_call", toolName: "nvidia_proteinmpnn" })];
    expect(describeLastActivity(run({ trace }))).toBe("Calling nvidia_proteinmpnn…");
  });

  it("describes a finished tool call while running", () => {
    const trace = [
      item({ type: "tool_call", toolName: "bash" }),
      item({ type: "tool_result", toolName: "bash", success: false }),
    ];
    expect(describeLastActivity(run({ trace }))).toBe("bash failed");
  });

  it("falls back to the latest assistant text, collapsed to one line", () => {
    const trace = [item({ type: "assistant", content: "Line one\nline two" })];
    expect(describeLastActivity(run({ trace }))).toBe("Line one line two");
  });

  it("uses a placeholder when nothing has happened yet", () => {
    expect(describeLastActivity(run())).toBe("Starting…");
  });
});
