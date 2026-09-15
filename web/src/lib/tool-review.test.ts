import { describe, expect, it } from "vitest";

import {
  buildToolReviewApprovalToken,
  effectiveToolReviewMode,
  isToolCallReviewApproved,
  normalizeToolReviewMode,
  summarizeToolCallForReview,
  type ToolReviewDecision,
} from "./tool-review";

describe("tool review helpers", () => {
  it("normalizes review modes with auto as the default", () => {
    expect(normalizeToolReviewMode("manual")).toBe("manual");
    expect(normalizeToolReviewMode("reviewer")).toBe("reviewer");
    expect(normalizeToolReviewMode("auto")).toBe("auto");
    expect(normalizeToolReviewMode("unrestricted")).toBe("unrestricted");
    expect(normalizeToolReviewMode("off")).toBe("unrestricted");
    expect(normalizeToolReviewMode("unknown")).toBe("auto");
    expect(normalizeToolReviewMode(undefined)).toBe("auto");
  });

  it("builds stable approval tokens independent of argument key order", () => {
    const a = buildToolReviewApprovalToken("wemol_cli", { b: 2, a: 1 });
    const b = buildToolReviewApprovalToken("wemol_cli", { a: 1, b: 2 });

    expect(a).toBe(b);
    expect(a).toMatch(/^__tool_review__:[a-f0-9]{32}$/);
    expect(isToolCallReviewApproved([a], "wemol_cli", { a: 1, b: 2 })).toBe(true);
  });

  it("summarizes tool calls without exposing the internal approval token", () => {
    const summary = summarizeToolCallForReview("read_file", { path: "result.json" });

    expect(summary).toContain("read_file");
    expect(summary).toContain("result.json");
    expect(summary).not.toContain("__tool_review__");
  });

  it("can distinguish reviewer uncertainty from an explicit denial", () => {
    const reviewerFailure: ToolReviewDecision = {
      approved: false,
      reason: "Reviewer did not return JSON.",
      uncertain: true,
    };
    const denial: ToolReviewDecision = {
      approved: false,
      reason: "Tool call tries to read credentials.",
    };

    expect(reviewerFailure.uncertain).toBe(true);
    expect(denial.uncertain).toBeUndefined();
  });
});

describe("reviewer JSON extraction", () => {
  it("reads a bare object, a fenced object, and an object wrapped in prose", async () => {
    const { extractReviewerJson } = await import("./tool-review");
    expect(extractReviewerJson('{"approved":true,"reason":"ok"}')).toEqual({ approved: true, reason: "ok" });
    expect(extractReviewerJson('Sure.\n```json\n{"approved": false, "uncertain": true, "reason": "odd"}\n```')).toMatchObject({ approved: false, uncertain: true });
    expect(extractReviewerJson('The call looks fine {"approved":true,"reason":"scoped"} — done.')).toMatchObject({ approved: true });
  });

  it("returns null when there is no JSON object", async () => {
    const { extractReviewerJson } = await import("./tool-review");
    expect(extractReviewerJson("I approve this command.")).toBeNull();
    expect(extractReviewerJson("")).toBeNull();
    expect(extractReviewerJson("[1,2]")).toBeNull();
  });
});

describe("sandbox escalation review", () => {
  it("runs low and medium risk retries without asking, asks for critical", async () => {
    const { escalationOutcomeFor } = await import("./tool-review");
    expect(escalationOutcomeFor("low", "unknown")).toBe("allow");
    expect(escalationOutcomeFor("medium", "low")).toBe("allow");
    expect(escalationOutcomeFor("critical", "high")).toBe("ask");
  });

  it("lets high risk through only with clear user authorization", async () => {
    const { escalationOutcomeFor } = await import("./tool-review");
    expect(escalationOutcomeFor("high", "high")).toBe("allow");
    expect(escalationOutcomeFor("high", "medium")).toBe("allow");
    expect(escalationOutcomeFor("high", "low")).toBe("ask");
    expect(escalationOutcomeFor("high", "unknown")).toBe("ask");
  });

  it("treats a missing or malformed verdict as uncertain and asks", async () => {
    const { parseEscalationReview } = await import("./tool-review");
    expect(parseEscalationReview(null)).toMatchObject({ outcome: "ask", uncertain: true });
    expect(parseEscalationReview({ risk_level: "banana", user_authorization: "high" })).toMatchObject({ outcome: "ask", uncertain: true });
    const ok = parseEscalationReview({ risk_level: "Low", user_authorization: "HIGH", rationale: "creates one file the user named" });
    expect(ok).toMatchObject({ outcome: "allow", riskLevel: "low", userAuthorization: "high" });
    expect(ok.uncertain).toBeUndefined();
  });
});

describe("effective review mode", () => {
  it("keeps the configured mode while an OS sandbox is enforcing", () => {
    for (const mode of ["manual", "reviewer", "auto", "unrestricted"] as const) {
      expect(effectiveToolReviewMode(mode, { toolName: "bash", sandboxEnforcing: true })).toBe(mode);
    }
  });

  it("forces bash to manual approval when nothing sandboxes the host", () => {
    for (const mode of ["reviewer", "auto", "unrestricted"] as const) {
      expect(effectiveToolReviewMode(mode, { toolName: "bash", sandboxEnforcing: false })).toBe("manual");
    }
  });

  it("leaves non-shell tools alone", () => {
    expect(effectiveToolReviewMode("auto", { toolName: "read_file", sandboxEnforcing: false })).toBe("auto");
    expect(effectiveToolReviewMode("unrestricted", { toolName: "analyze_structure", sandboxEnforcing: false })).toBe("unrestricted");
  });
});
