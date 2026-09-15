import { describe, expect, it } from "vitest";

import { resolveFirstRunningToolCall } from "./store";
import type { ToolCall } from "./types";

const call = (id: string, name: string, status: ToolCall["status"]): ToolCall => ({ id, name, arguments: {}, status });

describe("resolving tool results to their call", () => {
  it("completes the oldest running call of that name", () => {
    const calls = [call("a", "run_subagent", "running"), call("b", "run_subagent", "running")];
    const afterFirst = resolveFirstRunningToolCall(calls, "run_subagent", "result for a", true);
    expect(afterFirst[0]).toMatchObject({ id: "a", status: "completed", result: "result for a" });
    expect(afterFirst[1].status).toBe("running");

    const afterSecond = resolveFirstRunningToolCall(afterFirst, "run_subagent", "result for b", true);
    expect(afterSecond[1]).toMatchObject({ id: "b", status: "completed", result: "result for b" });
  });

  it("leaves finished calls and other tools alone", () => {
    const calls = [call("a", "bash", "completed"), call("b", "bash", "running"), call("c", "fetch_pdb", "running")];
    const next = resolveFirstRunningToolCall(calls, "bash", "out", false);
    expect(next[0].status).toBe("completed");
    expect(next[1]).toMatchObject({ status: "error", errorOutput: "out" });
    expect(next[2].status).toBe("running");
  });

  it("returns the list unchanged when nothing matches", () => {
    const calls = [call("a", "bash", "completed")];
    expect(resolveFirstRunningToolCall(calls, "bash", "out", true)).toBe(calls);
  });
});
