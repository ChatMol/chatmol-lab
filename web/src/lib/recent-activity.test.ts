import { describe, expect, it } from "vitest";
import {
  buildFallbackRecentActivityReport,
  buildRecentActivityContext,
  buildRecentActivityPrompt,
  RECENT_ACTIVITY_WELCOME,
} from "./recent-activity";

describe("recent activity summaries", () => {
  it("builds dashboard context from messages, plans, artifacts, and tools", () => {
    const context = buildRecentActivityContext(
      [
        {
          id: "s1",
          title: "WeMol antibody design",
          updatedAt: "2026-07-05T08:00:00.000Z",
          messages: [
            { role: "user", content: "Run WeMol antibody humanization and monitor the result." },
            {
              role: "assistant",
              content: "Submitted job 318296 and saved the humanized sequence report.",
              toolCalls: [{ name: "wemol_cli", status: "completed" }],
            },
          ],
          plan: [{ title: "Submit WeMol job", status: "completed" }],
          artifacts: [{ name: "humanized_antibody.csv", type: "csv", path: "outputs/humanized_antibody.csv" }],
        },
      ],
      { apiCalls: 3, inputTokens: 1200, outputTokens: 800 },
      new Date("2026-07-05T09:00:00.000Z"),
    );

    expect(context.sessions).toHaveLength(1);
    expect(context.sessions[0].recentUserRequests[0]).toContain("antibody humanization");
    expect(context.sessions[0].recentAssistantResults[0]).toContain("Submitted job 318296");
    expect(context.sessions[0].planItems[0]).toContain("Submit WeMol job");
    expect(context.sessions[0].artifactItems[0]).toContain("humanized_antibody.csv");
    expect(context.sessions[0].toolItems[0]).toContain("wemol_cli");

    const prompt = buildRecentActivityPrompt(context);
    expect(prompt).toContain("WeMol antibody design");
    expect(prompt).toContain("humanized_antibody.csv");
    expect(prompt).toContain("Do not invent experiments");

    const fallback = buildFallbackRecentActivityReport(context);
    expect(fallback).toContain("ChatMol Lab helped you do the following things in the last week:");
    expect(fallback).toContain("WeMol antibody design");
    expect(fallback).toContain("2,000 tokens");
  });

  it("returns the welcome text when there is no activity", () => {
    const context = buildRecentActivityContext(
      [],
      { apiCalls: 0, inputTokens: 0, outputTokens: 0 },
      new Date("2026-07-05T09:00:00.000Z"),
    );

    expect(buildFallbackRecentActivityReport(context)).toBe(RECENT_ACTIVITY_WELCOME);
  });
});
