import { describe, expect, it } from "vitest";

import { composeShellPath, getRuntimeSubprocessEnv } from "./runtime";

describe("runtime PATH composition", () => {
  it("puts the bundled runtime first, then extras, then the inherited PATH, deduplicated", () => {
    const result = composeShellPath({
      runtimeBinDirs: ["/rt/mambaforge/bin", "/rt/mambaforge/condabin"],
      extra: "/opt/homebrew/bin:/Users/me/miniforge3/bin:/rt/mambaforge/bin",
      base: "/Users/me/miniforge3/bin:/usr/bin:/bin",
      delimiter: ":",
    });
    expect(result).toBe("/rt/mambaforge/bin:/rt/mambaforge/condabin:/opt/homebrew/bin:/Users/me/miniforge3/bin:/usr/bin:/bin");
  });

  it("pins subprocesses to the bundled env when the desktop runtime is configured", () => {
    const env = getRuntimeSubprocessEnv(
      "/Users/me/miniforge3/bin",
      "/usr/bin:/bin",
      { CHATMOL_CONDA_PREFIX: "/rt/mambaforge", CHATMOL_CONDA_BIN: "/rt/mambaforge/bin" },
      "darwin",
    );
    expect(env.PATH.startsWith("/rt/mambaforge/bin:")).toBe(true);
    expect(env.PATH).toContain("/Users/me/miniforge3/bin");
    expect(env.CONDA_PREFIX).toBe("/rt/mambaforge");
    expect(env.CONDA_DEFAULT_ENV).toBe("base");
    expect(env.PYTHONNOUSERSITE).toBe("1");
    expect(env.CHATMOL_PYTHON).toBe("/rt/mambaforge/bin/python");
  });

  it("falls back to extras + inherited PATH off the desktop", () => {
    const env = getRuntimeSubprocessEnv("/opt/homebrew/bin", "/usr/bin:/bin", {}, "linux");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(env.CONDA_PREFIX).toBeUndefined();
  });
});
