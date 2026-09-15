import { describe, it, expect } from "vitest";
import {
  parseWemolJobId,
  summarizeWemolSubmit,
  isTrackableSubmit,
  parseWemolStatus,
  parseWemolProgressPercent,
} from "./wemol-jobs";

describe("parseWemolJobId", () => {
  it("parses a JSON job_id from real `job submit` output", () => {
    // Shape observed from wemol-cli in local history (job 318296).
    const out = '{\n  "job_id": 318296,\n  "next_commands": ["wemol-cli job status 318296"]\n}';
    expect(parseWemolJobId(out)).toBe("318296");
  });

  it("parses a labeled 'Job ID:' line", () => {
    expect(parseWemolJobId("Submitted. Job ID: abc-123_XYZ done")).toBe("abc-123_XYZ");
  });

  it("falls back to a UUID", () => {
    expect(parseWemolJobId("created 550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000"
    );
  });

  it("returns null when there is no id", () => {
    expect(parseWemolJobId("Preview validation passed. Remove --dry-run.")).toBeNull();
  });
});

describe("isTrackableSubmit", () => {
  it("tracks a real job submit", () => {
    expect(isTrackableSubmit("job submit --module-id 226 --params-file p.json")).toBe(true);
  });
  it("does NOT track a dry-run", () => {
    expect(isTrackableSubmit("job submit --module-id 226 --params-file p.json --dry-run")).toBe(false);
  });
  it("does NOT track non-submit commands", () => {
    expect(isTrackableSubmit("job status 318296")).toBe(false);
    expect(isTrackableSubmit("docs search ESMFold")).toBe(false);
  });
});

describe("summarizeWemolSubmit", () => {
  it("extracts the module id", () => {
    expect(summarizeWemolSubmit("job submit --module-id 226 --params-file p.json")).toBe("226");
  });
  it("extracts a flow id", () => {
    expect(summarizeWemolSubmit("job submit --flow-id 695 --params-file p.json")).toBe("695");
  });
  it("falls back to a generic label", () => {
    expect(summarizeWemolSubmit("job submit --params-file p.json")).toBe("WeMol job");
  });
});

describe("parseWemolStatus", () => {
  it("maps done/finished", () => {
    expect(parseWemolStatus('{"Status":"Done","Failure Reason":""}')).toBe("done");
    expect(parseWemolStatus("job finished successfully")).toBe("done");
  });
  it("maps failure before success words", () => {
    expect(parseWemolStatus("Status: failed")).toBe("failed");
  });
  it("maps running and pending", () => {
    expect(parseWemolStatus("state: running")).toBe("running");
    expect(parseWemolStatus("queued, waiting for a worker")).toBe("pending");
  });
  it("returns unknown for unrecognized text", () => {
    expect(parseWemolStatus("¯\\_(ツ)_/¯")).toBe("unknown");
  });
});

describe("parseWemolProgressPercent", () => {
  it("parses JSON-style Progress values", () => {
    expect(parseWemolProgressPercent('{"Progress":"100%","Status":"Done"}')).toBe(100);
    expect(parseWemolProgressPercent('{"Progress": "72.5%"}')).toBe(72.5);
  });

  it("parses labeled text progress", () => {
    expect(parseWemolProgressPercent("Progress: 35%")).toBe(35);
    expect(parseWemolProgressPercent("Progress = \"99%\"")).toBe(99);
  });

  it("returns null when progress is absent", () => {
    expect(parseWemolProgressPercent("Status: Done")).toBeNull();
  });
});
