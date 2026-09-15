import { afterEach, describe, expect, it } from "vitest";

import type { ComputeOffering, ComputeProvider } from "./provider";
import { setCatalogProviders } from "./registry";
import { COMPUTE_TOOL_DEFINITIONS, buildComputePromptSection, executeGenericComputeTool, isGenericComputeTool } from "./tools";

const offering: ComputeOffering = {
  id: "fake/fold",
  provider: "fake",
  name: "fold",
  label: "fold",
  description: "Predict a protein structure",
  category: "structure",
  inputSchema: { type: "object", properties: { sequence: { type: "string" } }, required: ["sequence"] },
};

function fakeProvider(): ComputeProvider & { submitted: string[]; cancelled: string[] } {
  const provider = {
    id: "fake",
    label: "Fake Cloud",
    kind: "gateway" as const,
    submitted: [] as string[],
    cancelled: [] as string[],
    capabilities: () => ["fake/fold"],
    async availability() { return { ok: true }; },
    async catalog() { return [offering]; },
    async getOffering(id: string) { return id === offering.id ? offering : null; },
    async submit(request: { capability: string; sessionId: string }) {
      provider.submitted.push(request.capability);
      return {
        id: "j1", provider: "fake", capability: request.capability, status: "queued" as const, output: "queued j1", artifacts: [],
        trackedJob: { id: "j1", provider: "chatmol-router" as const, sessionId: request.sessionId, label: "x", status: "pending" as const, submittedAt: 1, updatedAt: 1 },
      };
    },
    async getJob(id: string) { return { id, provider: "fake", capability: "fake/fold", status: "running" as const, output: "still running", artifacts: [] }; },
    async cancel(id: string) { provider.cancelled.push(id); },
    async downloadArtifacts() { return ["/ws/out.pdb"]; },
  };
  return provider;
}

const ctx = { sessionWorkspace: "/ws", sessionId: "s1", userId: null };

afterEach(() => setCatalogProviders(null));

describe("generic compute tools", () => {
  it("declares the seven Router-style tools", () => {
    expect(COMPUTE_TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      "search_compute_capabilities", "get_compute_offering", "quote_compute_job", "submit_compute_job", "get_compute_job", "cancel_compute_job", "import_compute_artifacts",
    ]);
    expect(isGenericComputeTool("submit_compute_job")).toBe(true);
    expect(isGenericComputeTool("bash")).toBe(false);
    expect(buildComputePromptSection([])).toBe("");
  });

  it("explains when no catalog is connected", async () => {
    setCatalogProviders([]);
    const result = await executeGenericComputeTool("search_compute_capabilities", { query: "fold" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/No compute catalog/);
  });

  it("searches, reads, submits (returning a tracked job), checks, imports and cancels", async () => {
    const provider = fakeProvider();
    setCatalogProviders([provider]);

    const search = await executeGenericComputeTool("search_compute_capabilities", { query: "structure" }, ctx);
    expect(search.output).toContain("fake/fold");
    expect((await executeGenericComputeTool("search_compute_capabilities", { query: "docking" }, ctx)).output).toMatch(/No offering matches/);

    const detail = await executeGenericComputeTool("get_compute_offering", { offering: "fake/fold" }, ctx);
    expect(detail.output).toContain("\"sequence\"");

    const submit = await executeGenericComputeTool("submit_compute_job", { offering: "fake/fold", inputs: { sequence: "MKT" }, label: "fold MKT" }, ctx);
    expect(submit.success).toBe(true);
    expect(submit.computeJob).toMatchObject({ id: "j1", label: "fold MKT", sessionId: "s1" });
    expect(provider.submitted).toEqual(["fake/fold"]);

    const status = await executeGenericComputeTool("get_compute_job", { provider: "fake", job_id: "j1" }, ctx);
    expect(status.output).toContain("Tracked status: running");

    const imported = await executeGenericComputeTool("import_compute_artifacts", { provider: "fake", job_id: "j1" }, ctx);
    expect(imported.output).toContain("/ws/out.pdb");

    await executeGenericComputeTool("cancel_compute_job", { provider: "fake", job_id: "j1" }, ctx);
    expect(provider.cancelled).toEqual(["j1"]);
  });
});
