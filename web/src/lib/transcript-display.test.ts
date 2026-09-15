import { describe, expect, it } from "vitest";

import { mergeAssistantTurns, segmentBlocks, transcriptToDisplayMessages } from "./transcript-display";
import type { Message } from "./types";

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const result = (id: string, content: string) => ({ role: "tool", tool_call_id: id, content });

describe("reloaded transcripts group like live runs", () => {
  it("folds the tool-only turns between two agent texts into one activity line", () => {
    const raw = [
      { role: "user", content: "Design a binder for 1PGA" },
      { role: "assistant", content: "", tool_calls: [call("c1", "fetch_pdb", { pdb_id: "1PGA" })] },
      result("c1", "Downloaded 1PGA.pdb"),
      { role: "assistant", content: "", tool_calls: [call("c2", "bash", { command: "ls" })] },
      result("c2", "1PGA.pdb"),
      { role: "assistant", content: "", tool_calls: [call("c3", "inspect_structure", { path: "1PGA.pdb" })] },
      result("c3", "chain A: 56 residues"),
      { role: "assistant", content: "ipTM improved to 0.48. Now compute Rg:" },
      { role: "assistant", content: "", tool_calls: [call("c4", "bash", { command: "python rg.py" })] },
      result("c4", "Rg=12.2"),
      { role: "assistant", content: "", tool_calls: [call("c5", "bash", { command: "python redesign.py" })] },
      result("c5", "done"),
      { role: "assistant", content: "Redesign finished." },
    ];

    const messages = transcriptToDisplayMessages(raw, "s1", 0);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const segments = segmentBlocks(messages[1]);
    expect(segments.map((s) => s.kind)).toEqual(["activity", "text", "activity", "text"]);
    const [first, , second] = segments;
    expect(first.kind === "activity" ? first.toolCalls.map((tc) => tc.id) : null).toEqual(["c1", "c2", "c3"]);
    expect(second.kind === "activity" ? second.toolCalls.map((tc) => tc.name) : null).toEqual(["bash", "bash"]);
  });

  it("keeps every user turn as its own boundary", () => {
    const raw = [
      { role: "user", content: "first" },
      { role: "assistant", content: "", tool_calls: [call("a", "bash", { command: "pwd" })] },
      result("a", "/ws"),
      { role: "assistant", content: "done" },
      { role: "user", content: "second" },
      { role: "assistant", content: "", tool_calls: [call("b", "bash", { command: "ls" })] },
      result("b", "x"),
    ];
    const messages = transcriptToDisplayMessages(raw, "s2", 0);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[3].toolCalls?.map((tc) => tc.id)).toEqual(["b"]);
  });

  it("attaches results, keeps a turn's text before its calls and flags failures", () => {
    const raw = [
      { role: "user", content: "check" },
      { role: "assistant", content: "Let me look.", tool_calls: [call("ok", "read_file", { path: "a.txt" }), call("bad", "bash", { command: "false" })] },
      result("ok", "hello"),
      result("bad", "Error (exit code 1)"),
    ];
    const [, assistant] = transcriptToDisplayMessages(raw, "s3", 0);
    expect(assistant.contentBlocks?.map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
    expect(assistant.toolCalls?.map((tc) => [tc.name, tc.status, tc.result])).toEqual([
      ["read_file", "completed", "hello"],
      ["bash", "error", "Error (exit code 1)"],
    ]);
    expect(assistant.toolCalls?.[0].arguments).toEqual({ path: "a.txt" });
  });

  it("reads failure from the first line, not from anywhere in the output", () => {
    const raw = [
      { role: "user", content: "fetch and run" },
      { role: "assistant", content: "", tool_calls: [
        call("pdb", "fetch_pdb", { pdb_id: "5DXW" }),
        call("cli", "wemol_cli", { args: "login" }),
        call("sh", "bash", { command: "false" }),
      ] },
      // A real PDB file: the word appears deep in the body, the call succeeded.
      result("pdb", "HEADER    SIGNALING PROTEIN\nREMARK   3   ERROR ESTIMATES\nATOM      1  N"),
      result("cli", "WeMol login failed: Error: [AUTH_REQUIRED]"),
      result("sh", "Error (exit code 1):\nStderr: no such file"),
    ];
    const [, assistant] = transcriptToDisplayMessages(raw, "s5", 0);
    expect(assistant.toolCalls?.map((tc) => tc.status)).toEqual(["completed", "error", "error"]);
  });

  it("merges frontend-format snapshots and their artifacts as well", () => {
    const messages = transcriptToDisplayMessages([
      { id: "u", role: "user", content: "go" },
      { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "t1", name: "bash", arguments: {}, status: "completed" }], contentBlocks: [{ type: "tool_use", toolCallId: "t1" }] },
      { id: "a2", role: "assistant", content: "Result.", artifacts: [{ id: "art", name: "x.pdb", type: "pdb", path: "x.pdb" }] },
    ], "s4", 0);
    expect(messages.map((m) => m.id)).toEqual(["u", "a1"]);
    expect(messages[1].content).toBe("Result.");
    expect(messages[1].artifacts?.map((a) => a.id)).toEqual(["art"]);
    expect(segmentBlocks(messages[1]).map((s) => s.kind)).toEqual(["activity", "text"]);
  });

  it("reads an Anthropic transcript, whose results ride back in a user message", () => {
    const raw = [
      { role: "user", content: "fetch 1UBQ and look at it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Fetching it." },
          { type: "tool_use", id: "tu1", name: "fetch_pdb", input: { pdb_id: "1UBQ" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Downloaded 1UBQ.pdb" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu2", name: "bash", input: { command: "ls" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "1UBQ.pdb" }] },
      { role: "assistant", content: [{ type: "text", text: "It is a 76-residue chain." }] },
    ];

    const messages = transcriptToDisplayMessages(raw, "an1", 0);
    // The tool_result carriers are not user turns and must not become bubbles.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1].toolCalls?.map((tc) => [tc.name, tc.result])).toEqual([
      ["fetch_pdb", "Downloaded 1UBQ.pdb"],
      ["bash", "1UBQ.pdb"],
    ]);
    expect(messages[1].toolCalls?.[0].arguments).toEqual({ pdb_id: "1UBQ" });
    expect(segmentBlocks(messages[1]).map((s) => s.kind)).toEqual(["text", "activity", "text"]);
  });

  it("keeps the model's own block order in an Anthropic turn", () => {
    const raw = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan it" },
          { type: "tool_use", id: "a", name: "bash", input: { command: "pwd" } },
          { type: "text", text: "Now the second step." },
          { type: "tool_use", id: "b", name: "bash", input: { command: "ls" } },
        ],
      },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "a", content: "/ws" },
        { type: "tool_result", tool_use_id: "b", content: "x" },
      ] },
    ];
    const [, assistant] = transcriptToDisplayMessages(raw, "an2", 0);
    expect(assistant.contentBlocks?.map((b) => b.type)).toEqual(["reasoning", "tool_use", "text", "tool_use"]);
    // Text between two calls splits them, exactly as it does in a live run.
    expect(segmentBlocks(assistant).map((s) => s.kind)).toEqual(["activity", "text", "activity"]);
  });

  it("handles a session whose provider changed mid-conversation", () => {
    const raw = [
      { role: "user", content: "start" },
      { role: "assistant", content: "", tool_calls: [call("oa", "bash", { command: "pwd" })] },
      result("oa", "/ws"),
      { role: "assistant", content: [{ type: "tool_use", id: "an", name: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "an", content: "x" }] },
    ];
    const [, assistant] = transcriptToDisplayMessages(raw, "mix", 0);
    expect(assistant.toolCalls?.map((tc) => [tc.id, tc.result])).toEqual([["oa", "/ws"], ["an", "x"]]);
  });

  it("never merges a message that is still streaming", () => {
    const done: Message = { id: "a", role: "assistant", content: "earlier", timestamp: 0 };
    const live: Message = { id: "b", role: "assistant", content: "", timestamp: 1, isStreaming: true };
    expect(mergeAssistantTurns([done, live]).map((m) => m.id)).toEqual(["a", "b"]);
  });
});
