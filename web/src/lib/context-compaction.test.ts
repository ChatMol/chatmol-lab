import { describe, expect, it } from "vitest";

import {
  buildContextProjection,
  findApplicableRecord,
  getContextCompactionConfig,
  mergeProjectedTurnMessages,
  pruneToolText,
  type ContextCompactionRecord,
} from "./context-compaction";
import type { ToolDefinition, TurnMessage } from "./tools";

const tools: ToolDefinition[] = [
  {
    name: "bash",
    description: "Run a command",
    input_schema: { type: "object", properties: { command: { type: "string" } } },
  },
];

function sampleMessages(): TurnMessage[] {
  return [
    { role: "user", content: "Find a protein design workflow for target A." },
    {
      role: "assistant",
      content: "We decided to use RFdiffusion then ProteinMPNN.",
      reasoning_content: "old private reasoning should not be kept",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "bash", arguments: "{\"command\":\"cat long.log\"}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: `${"alpha ".repeat(600)}\nimportant tail result`,
    },
    { role: "user", content: "Now inspect the generated PDB files." },
    {
      role: "assistant",
      content: "The current artifact is model_1.pdb.",
      reasoning_content: "recent reasoning should also be stripped from prompt projection",
    },
    { role: "user", content: "Summarize the current state." },
  ];
}

const tinyConfig = { triggerApproxTokens: 1, keepTurns: 1, retainApproxTokens: 100_000, pruneThresholdChars: 240, pruneHeadChars: 100, pruneTailChars: 50 };

describe("compaction config", () => {
  it("derives the trigger from the model context window with a cap", () => {
    expect(getContextCompactionConfig({ contextWindow: 200_000 }).triggerApproxTokens).toBe(80_000);
    expect(getContextCompactionConfig({ contextWindow: 32_000 }).triggerApproxTokens).toBe(25_600);
    expect(getContextCompactionConfig({ contextWindow: 32_000 }).retainApproxTokens).toBe(5_120);
  });

  it("prunes oversized tool text to head + marker + tail", () => {
    const pruned = pruneToolText("x".repeat(1000), { pruneThresholdChars: 300, pruneHeadChars: 200, pruneTailChars: 50 });
    expect(pruned.prunedChars).toBe(750);
    expect(pruned.text.startsWith("x".repeat(200))).toBe(true);
    expect(pruned.text.endsWith("x".repeat(50))).toBe(true);
    expect(pruned.text).toContain("pruned from the middle");
    expect(pruneToolText("short", { pruneThresholdChars: 300, pruneHeadChars: 200, pruneTailChars: 50 }).prunedChars).toBe(0);
  });
});

describe("buildContextProjection", () => {
  it("compacts old messages into a summary message and appends live state", async () => {
    const projection = await buildContextProjection({
      messages: sampleMessages(),
      systemPrompt: "System prompt",
      tools,
      plan: [{ title: "Inspect structures", status: "in_progress" }],
      artifacts: [{ name: "model_1.pdb", type: "pdb", path: "outputs/model_1.pdb" }],
      workspaceFiles: ["outputs/model_1.pdb", "logs/run.log"],
      config: tinyConfig,
      now: 1234,
    });

    expect(projection.compacted).toBe(true);
    expect(projection.turnMessages).toHaveLength(2);
    expect(projection.turnMessages[0].role).toBe("user");
    const summary = String(projection.turnMessages[0].content);
    expect(summary).toContain("<compacted_summary>");
    expect(summary).toContain("Find a protein design workflow");
    expect(summary).toContain("Inspect structures");
    expect(summary).toContain("outputs/model_1.pdb");
    expect(summary).not.toContain("old private reasoning");
    expect(projection.turnMessages[1].content).toBe("Summarize the current state.");
    expect(projection.systemPrompt).toBe("System prompt");
    expect(projection.record?.summarizedMessages).toBe(5);
    expect(projection.record?.summaryMode).toBe("deterministic");
  });

  it("uses the model summarizer when it returns text", async () => {
    let received: { priorSummary: string | null; transcript: string } | null = null;
    const projection = await buildContextProjection({
      messages: sampleMessages(),
      systemPrompt: "System prompt",
      tools,
      config: tinyConfig,
      summarize: async (input) => {
        received = { priorSummary: input.priorSummary, transcript: input.transcript };
        return "MODEL SUMMARY: chose RFdiffusion → ProteinMPNN; artifact model_1.pdb";
      },
    });
    expect(projection.record?.summaryMode).toBe("model");
    expect(String(projection.turnMessages[0].content)).toContain("MODEL SUMMARY");
    expect(received!.priorSummary).toBeNull();
    expect(received!.transcript).toContain("[tool result: bash]");
    expect(received!.transcript).toContain("Find a protein design workflow");
  });

  it("keeps the recent tail while stripping reasoning and pruning long retained tool output", async () => {
    const messages: TurnMessage[] = [
      ...sampleMessages(),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "bash", arguments: "{\"command\":\"cat huge.out\"}" },
          },
        ],
        reasoning_content: "new reasoning",
      },
      { role: "tool", tool_call_id: "call_2", content: "zeta ".repeat(1000) },
    ];

    const projection = await buildContextProjection({
      messages,
      systemPrompt: "System prompt",
      tools,
      config: tinyConfig,
    });

    expect(projection.compacted).toBe(true);
    expect(projection.turnMessages.some((message) => !!message.reasoning_content)).toBe(false);
    const retainedTool = projection.turnMessages.find((message) => message.role === "tool");
    expect(String(retainedTool?.content)).toContain("pruned from the middle");
    expect(String(retainedTool?.content).length).toBeLessThan(500);
  });

  it("reuses a persisted record whose prefix still matches, even below the threshold", async () => {
    const first = await buildContextProjection({
      messages: sampleMessages(),
      systemPrompt: "System prompt",
      tools,
      config: tinyConfig,
    });
    expect(first.record).toBeDefined();

    const grown = [...sampleMessages(), { role: "assistant", content: "Done." } as TurnMessage, { role: "user", content: "Next?" } as TurnMessage];
    const second = await buildContextProjection({
      messages: grown,
      systemPrompt: "System prompt",
      tools,
      compactions: [first.record as ContextCompactionRecord],
      config: { ...tinyConfig, triggerApproxTokens: 1_000_000 },
    });

    expect(second.compacted).toBe(true);
    expect(second.reusedRecord).toBe(true);
    expect(second.record).toBeUndefined();
    expect(second.turnMessages).toHaveLength(1 + (grown.length - first.record!.retainedStartIndex));
    expect(findApplicableRecord([first.record], grown)?.id).toBe(first.record!.id);
    // A changed prefix invalidates the record.
    const edited = [...grown];
    edited[0] = { role: "user", content: "Something else entirely." };
    expect(findApplicableRecord([first.record], edited)).toBeNull();
  });

  it("condenses further on top of an existing record and passes the prior summary", async () => {
    const base = sampleMessages();
    const first = await buildContextProjection({
      messages: base,
      systemPrompt: "System prompt",
      tools,
      config: { ...tinyConfig, keepTurns: 2 },
      summarize: async () => "FIRST SUMMARY",
    });
    const grown = [...base, { role: "assistant", content: "Reply." } as TurnMessage, { role: "user", content: "One more request." } as TurnMessage, { role: "assistant", content: "Ok." } as TurnMessage, { role: "user", content: "And another." } as TurnMessage];
    let prior: string | null = "unset";
    const second = await buildContextProjection({
      messages: grown,
      systemPrompt: "System prompt",
      tools,
      compactions: [first.record as ContextCompactionRecord],
      config: { ...tinyConfig, keepTurns: 1 },
      summarize: async (input) => { prior = input.priorSummary; return "SECOND SUMMARY"; },
    });
    expect(second.record).toBeDefined();
    expect(second.record!.retainedStartIndex).toBeGreaterThan(first.record!.retainedStartIndex);
    expect(prior).toBe("FIRST SUMMARY");
    expect(String(second.turnMessages[0].content)).toContain("SECOND SUMMARY");
  });

  it("merges projected run output without losing or duplicating canonical history", async () => {
    const canonical = sampleMessages();
    const projection = await buildContextProjection({
      messages: canonical,
      systemPrompt: "System prompt",
      tools,
      config: tinyConfig,
    });
    const projectedAfterRun = [
      ...projection.turnMessages,
      { role: "assistant", content: "New final answer." } as TurnMessage,
    ];

    const merged = mergeProjectedTurnMessages(
      canonical,
      projection.baseTurnMessageCount,
      projectedAfterRun,
    );

    expect(merged).toHaveLength(canonical.length + 1);
    expect(merged.slice(0, canonical.length)).toEqual(canonical);
    expect(merged[merged.length - 1]).toEqual({ role: "assistant", content: "New final answer." });
  });
});
