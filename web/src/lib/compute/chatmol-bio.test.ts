import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { MAX_ARCHIVE_BYTES, chatmolBioProvider, mapBioStatus, offeringId, toOffering, toolNameFromOffering, unsafeArchiveEntry } from "./chatmol-bio";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CHATMOL_API_KEY;
  delete process.env.CHATMOL_API_URL;
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("ChatMol Bio provider", () => {
  it("maps the Bio API status vocabulary onto the unified state machine", () => {
    expect(mapBioStatus("submitted")).toBe("queued");
    expect(mapBioStatus("running")).toBe("running");
    expect(mapBioStatus("completed")).toBe("succeeded");
    expect(mapBioStatus("failed")).toBe("failed");
    expect(mapBioStatus("cancelled")).toBe("cancelled");
  });

  it("names offerings `chatmol-bio/<tool>` and accepts bare tool names", () => {
    expect(offeringId("esmfold_predict_structure")).toBe("chatmol-bio/esmfold_predict_structure");
    expect(toolNameFromOffering("chatmol-bio/esmfold_predict_structure")).toBe("esmfold_predict_structure");
    expect(toolNameFromOffering("esmfold_predict_structure")).toBe("esmfold_predict_structure");
    expect(toolNameFromOffering("nvidia/esmfold")).toBeNull();
  });

  it("turns a tool detail into an offering with a JSON input schema", () => {
    const offering = toOffering({
      tool_name: "esmfold_predict_structure",
      category: "structure",
      description: "Predict a structure",
      gpu_type: "A10G",
      accepts_files: true,
      parameters: [
        { name: "sequence", type: "str", required: true, description: "Protein sequence" },
        { name: "num_recycles", type: "int", default: "3" },
      ],
    });
    expect(offering.id).toBe("chatmol-bio/esmfold_predict_structure");
    expect(offering.inputSchema).toEqual({
      type: "object",
      properties: {
        sequence: { type: "string", description: "Protein sequence" },
        num_recycles: { type: "integer", description: "", default: "3" },
        files: { type: "array", items: { type: "string" }, description: "Workspace paths of input files to upload with the job." },
      },
      required: ["sequence"],
    });
    expect(offering.priceModel?.kind).toBe("usage");
  });

  it("submits a multipart job with workspace files and returns a tracked queued job", async () => {
    process.env.CHATMOL_API_KEY = "cmol_test";
    process.env.CHATMOL_API_URL = "https://bio.example";
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cm-bio-"));
    fs.writeFileSync(path.join(workspace, "input.pdb"), "ATOM");
    const calls: Array<{ url: string; method?: string; headers: Record<string, string>; form?: FormData }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method, headers: init?.headers as Record<string, string>, form: init?.body as FormData });
      if (url.endsWith("/v1/jobs")) return jsonResponse({ job_id: "job-1", status: "submitted", tool: "esmfold_predict_structure", created_at: "now" }, { status: 202 });
      if (url.endsWith("/v1/jobs/job-1")) return jsonResponse({ job_id: "job-1", status: "completed", tool: "esmfold_predict_structure", gpu_seconds: 12.5 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    try {
      const job = await chatmolBioProvider.submit({
        capability: "chatmol-bio/esmfold_predict_structure",
        inputs: { sequence: "MKT", files: ["input.pdb"] },
        sessionWorkspace: workspace,
        sessionId: "s1",
        userId: null,
      });
      expect(job.status).toBe("queued");
      expect(job.trackedJob).toMatchObject({ id: "job-1", provider: "chatmol-bio", sessionId: "s1", status: "pending", label: "esmfold_predict_structure" });
      expect(calls[0].headers["X-API-Key"]).toBe("cmol_test");
      expect(calls[0].url).toBe("https://bio.example/v1/jobs");
      const form = calls[0].form!;
      expect(JSON.parse(String(form.get("request")))).toEqual({ tool: "esmfold_predict_structure", params: { sequence: "MKT" } });
      expect((form.getAll("files")[0] as File).name).toBe("input.pdb");

      const status = await chatmolBioProvider.getJob("job-1");
      expect(status?.status).toBe("succeeded");
      expect(status?.output).toContain("GPU seconds: 12.5");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reports a missing key as unavailable", async () => {
    const availability = await chatmolBioProvider.availability({ userId: null });
    expect(availability.ok).toBe(false);
    expect(availability.reason).toMatch(/API key/);
  });
});

describe("archive safety", () => {
  it("refuses entries that would escape the extraction directory", () => {
    const bad = [
      "-rw-r--r--  0 user staff  120 2026-09-13 10:00 ../../etc/passwd",
      "-rw-r--r--  0 user staff  120 2026-09-13 10:00 /etc/passwd",
      "lrwxr-xr-x  0 user staff    0 2026-09-13 10:00 link -> /etc/passwd",
      "hrw-r--r--  0 user staff    0 2026-09-13 10:00 hard",
      "../evil.pdb",
    ];
    for (const line of bad) expect(unsafeArchiveEntry(line)).toBeTruthy();
  });

  it("accepts ordinary relative entries", () => {
    const good = [
      "-rw-r--r--  0 user staff  120 2026-09-13 10:00 results/model_1.pdb",
      "drwxr-xr-x  0 user staff    0 2026-09-13 10:00 results/",
      "results/scores.csv",
      "a..b/model.pdb",
    ];
    for (const line of good) expect(unsafeArchiveEntry(line)).toBeNull();
    expect(unsafeArchiveEntry("   ")).toBeNull();
  });

  it("caps how large a result archive may be", () => {
    expect(MAX_ARCHIVE_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024 * 1024);
    expect(MAX_ARCHIVE_BYTES).toBeGreaterThan(0);
  });
});
