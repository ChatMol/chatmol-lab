import { afterEach, describe, expect, it } from "vitest";

import { terminalJob, type ComputeProvider } from "./provider";
import { COMPUTE_TOOL_TIMEOUTS, isComputeCapability, isRetiredCapability, resolveComputeProvider, runComputeCapability, setComputeProviderResolver } from "./registry";

afterEach(() => {
  setComputeProviderResolver(null);
  delete process.env.CHATMOL_GATEWAY_TOKEN;
});

describe("compute registry", () => {
  it("answers a withdrawn endpoint with what to use instead", async () => {
    expect(isRetiredCapability("nvidia_esmfold")).toBe(true);
    expect(isRetiredCapability("nvidia_openfold2")).toBe(false);
    // Still routable, so an old plan that names it gets the explanation
    // rather than "Unknown tool".
    expect(isComputeCapability("nvidia_esmfold")).toBe(true);
    const result = await runComputeCapability("nvidia_esmfold", { sequence: "MKT" }, { sessionWorkspace: "/tmp", sessionId: "s", userId: null });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/retired the ESMFold/i);
    expect(result.output).toMatch(/nvidia_openfold2/);
  });

  it("knows which tools are compute capabilities", () => {
    expect(isComputeCapability("nvidia_openfold2")).toBe(true);
    expect(isComputeCapability("wemol_cli")).toBe(true);
    expect(isComputeCapability("bash")).toBe(false);
    expect(Object.keys(COMPUTE_TOOL_TIMEOUTS)).toContain("nvidia_boltz2");
  });

  it("serves capabilities from the direct providers by default", async () => {
    const nvidia = await resolveComputeProvider("nvidia_openfold2", "direct");
    expect(nvidia.provider?.id).toBe("nvidia-direct");
    const wemol = await resolveComputeProvider("wemol_cli", "direct");
    expect(wemol.provider?.id).toBe("wemol-direct");
    const none = await resolveComputeProvider("nope", "direct");
    expect(none.provider).toBeNull();
  });

  it("fails closed instead of moving a ChatMol Cloud run onto the user's own account", async () => {
    const resolved = await resolveComputeProvider("nvidia_openfold2", "chatmol-cloud");
    expect(resolved.provider).toBeNull();
    const reason = "reason" in resolved ? resolved.reason : "";
    expect(reason).toMatch(/not connected/i);
    expect(reason).toMatch(/stopped rather than moved/);
    // The alternative is named, but the user has to choose it.
    expect(reason).toMatch(/Switch Compute backend to Direct|switch Compute backend to Direct/);
  });

  it("runs a capability through the resolved provider and reports availability", async () => {
    const calls: string[] = [];
    const fake: ComputeProvider = {
      id: "fake",
      label: "Fake",
      kind: "direct",
      capabilities: () => ["nvidia_openfold2"],
      async availability() { return { ok: true }; },
      async submit(request) { calls.push(request.capability); return terminalJob("fake", request.capability, { output: "folded", success: true }); },
      async getJob() { return null; },
      async cancel() {},
    };
    setComputeProviderResolver(() => fake);
    const result = await runComputeCapability("nvidia_openfold2", { sequence: "MKT" }, { sessionWorkspace: "/tmp", sessionId: "s", userId: null });
    expect(result).toEqual({ output: "folded", success: true, computeJob: undefined });
    expect(calls).toEqual(["nvidia_openfold2"]);

    setComputeProviderResolver(() => ({ ...fake, async availability() { return { ok: false, reason: "no key" }; } }));
    const blocked = await runComputeCapability("nvidia_openfold2", {}, { sessionWorkspace: "/tmp", sessionId: "s", userId: null });
    expect(blocked).toEqual({ output: "no key", success: false });
  });
});
