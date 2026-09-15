import { describe, expect, it } from "vitest";

import { parseDistillOutput, renderRecentTranscript, shouldDistill, userMessageText, verifyFeedbackType } from "./memory-distill";

describe("memory distillation", () => {
  it("parses a JSON array, tolerating fences and prose, dropping invalid items", () => {
    const text = 'Here you go:\n```json\n[\n {"name": "Prefers OpenFold2", "description": "d", "type": "user", "scope": "global", "content": "c"},\n {"name": "wemol-flow", "description": "flow id", "type": "reference", "scope": "workspace", "content": "flow nb_humanize_v2"},\n {"name": "leak", "description": "d", "type": "user", "scope": "global", "content": "token = abcdefghijklmnopqrstuvwxyz"},\n {"name": "bad type", "description": "d", "type": "x", "scope": "global", "content": "c"},\n {"name": "ok-default", "description": "d", "content": "c"}\n]\n```';
    const parsed = parseDistillOutput(text);
    expect(parsed.map((p) => [p.name, p.type, p.scope])).toEqual([
      ["wemol-flow", "reference", "workspace"],
      ["ok-default", "project", "workspace"],
    ]);
    expect(parseDistillOutput("[]")).toEqual([]);
    expect(parseDistillOutput("no json here")).toEqual([]);
    expect(parseDistillOutput('[{"name":"a","description":"d","type":"user","scope":"global","content":"c"},{"name":"b","description":"d","type":"user","scope":"global","content":"c"}]', 1)).toHaveLength(1);
  });

  it("only distills runs that did real work", () => {
    expect(shouldDistill([{ role: "user", content: "hi" }])).toBe(false);
    expect(shouldDistill([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }])).toBe(false);
    expect(shouldDistill([
      { role: "user", content: "fold this" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", function: { name: "nvidia_openfold2" } }] },
      { role: "tool", content: "done", tool_call_id: "1" },
    ])).toBe(true);
  });

  it("renders the transcript tail within a budget, skipping hidden messages", () => {
    const text = renderRecentTranscript([
      { role: "user", content: "old ".repeat(100), hidden: true },
      { role: "user", content: "first" },
      { role: "assistant", content: "x".repeat(300) },
      { role: "user", content: "last" },
    ], 330);
    expect(text).toContain("[user] last");
    expect(text).toContain("[assistant]");
    expect(text).not.toContain("first");
    expect(text).not.toContain("old old");
  });
});

describe("feedback provenance", () => {
  const userText = "please always report pLDDT per chain, not just the mean";

  it("keeps feedback the user actually gave", () => {
    expect(verifyFeedbackType({ type: "feedback", user_quote: "always report pLDDT per chain" }, userText)).toBe("keep");
  });

  it("downgrades feedback the model invented about its own approach", () => {
    expect(verifyFeedbackType({ type: "feedback", user_quote: "" }, userText)).toBe("downgrade");
    expect(verifyFeedbackType({ type: "feedback" }, userText)).toBe("downgrade");
    expect(verifyFeedbackType({ type: "feedback", user_quote: "list accession, protein name and function" }, userText)).toBe("downgrade");
    // Too short to be evidence of anything.
    expect(verifyFeedbackType({ type: "feedback", user_quote: "ok" }, userText)).toBe("downgrade");
  });

  it("leaves the other types alone", () => {
    for (const type of ["user", "project", "reference"]) {
      expect(verifyFeedbackType({ type }, "")).toBe("keep");
    }
  });

  it("files an unsupported feedback entry as reference instead of dropping it", () => {
    const json = '[{"name":"uniprot-lookup-format","description":"d","type":"feedback","scope":"global","content":"c"}]';
    expect(parseDistillOutput(json, 3, userText)[0].type).toBe("reference");
    const supported = '[{"name":"plddt-per-chain","description":"d","type":"feedback","scope":"global","content":"c","user_quote":"always report pLDDT per chain"}]';
    expect(parseDistillOutput(supported, 3, userText)[0].type).toBe("feedback");
  });

  it("collects only user messages as the evidence pool", () => {
    const text = userMessageText([
      { role: "user", content: "use boltz2 for complexes" },
      { role: "assistant", content: "I will use openfold2" },
      { role: "tool", content: "done" },
    ]);
    expect(text).toContain("use boltz2");
    expect(text).not.toContain("openfold2");
  });
});
