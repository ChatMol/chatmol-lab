import { describe, expect, it } from "vitest";

import { buildComputeCostPolicySection, normalizeWemolComputeProfile } from "./wemol-policy";

describe("compute cost policy", () => {
  it("normalizes the profile to the two supported values", () => {
    expect(normalizeWemolComputeProfile("industrial")).toBe("industrial");
    expect(normalizeWemolComputeProfile("pre_experiment")).toBe("pre_experiment");
    for (const value of [undefined, null, "", "INDUSTRIAL", "other", 7, {}]) {
      expect(normalizeWemolComputeProfile(value)).toBe("pre_experiment");
    }
  });

  it("depends only on the profile, never on the request", () => {
    // The section takes no message. Requests that used to change the tool set
    // (English verb vs Chinese noun for the same task) must read identically.
    const industrial = buildComputeCostPolicySection("industrial");
    const preExperiment = buildComputeCostPolicySection("pre_experiment");
    expect(buildComputeCostPolicySection("industrial")).toBe(industrial);
    expect(industrial).not.toBe(preExperiment);
    expect(buildComputeCostPolicySection("nonsense")).toBe(preExperiment);
  });

  it("states the preference without hiding anything", () => {
    for (const profile of ["industrial", "pre_experiment"]) {
      const text = buildComputeCostPolicySection(profile);
      expect(text).toContain("## Compute Cost Policy");
      expect(text).toContain("every tool is available on every request");
      expect(text).not.toMatch(/hidden|not exposed|only these/i);
    }
  });

  it("prefers WeMol for production runs only in the industrial profile", () => {
    expect(buildComputeCostPolicySection("industrial")).toMatch(/prefer a validated WeMol/i);
    expect(buildComputeCostPolicySection("pre_experiment")).toMatch(/Prefer free NVIDIA/i);
  });
});
