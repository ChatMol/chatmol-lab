import { describe, expect, it } from "vitest";

import { getDeploymentMode, isHostedDeployment, isLocalDeployment } from "./deployment";

describe("deployment mode", () => {
  it("is local unless CHATMOL_DEPLOYMENT=hosted", () => {
    expect(getDeploymentMode({})).toBe("local");
    expect(getDeploymentMode({ NEXT_PUBLIC_IS_ELECTRON: "true" })).toBe("local");
    expect(getDeploymentMode({ CHATMOL_DEPLOYMENT: "local" })).toBe("local");
    expect(getDeploymentMode({ CHATMOL_DEPLOYMENT: "hosted" })).toBe("hosted");
    expect(getDeploymentMode({ CHATMOL_DEPLOYMENT: "Hosted" })).toBe("local");
  });

  it("exposes the two predicates as complements", () => {
    expect(isLocalDeployment({})).toBe(true);
    expect(isHostedDeployment({})).toBe(false);
    expect(isLocalDeployment({ CHATMOL_DEPLOYMENT: "hosted" })).toBe(false);
    expect(isHostedDeployment({ CHATMOL_DEPLOYMENT: "hosted" })).toBe(true);
  });
});
