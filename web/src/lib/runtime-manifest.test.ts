import { describe, expect, it } from "vitest";

import {
  buildProbeScript,
  commandChangesEnvironment,
  findToolsOnPath,
  formatRuntimeManifest,
  parseProbeOutput,
  resolveCuratedPackages,
  type RuntimeManifest,
} from "./runtime-manifest";

describe("runtime manifest", () => {
  it("builds a probe that asks for every curated distribution", () => {
    const script = buildProbeScript();
    expect(script).toContain("importlib.metadata");
    expect(script).toContain('"biopython"');
    expect(script).toContain('"rdkit-pypi"');
  });

  it("parses the probe's JSON line even when warnings precede it", () => {
    const stdout = [
      "WARNING: some conda banner",
      '{"version": "3.13.1", "executable": "/rt/bin/python", "count": 66, "packages": {"biopython": null, "numpy": "2.1.0"}}',
    ].join("\n");
    const parsed = parseProbeOutput(stdout);
    expect(parsed?.version).toBe("3.13.1");
    expect(parsed?.packages.numpy).toBe("2.1.0");
    expect(parseProbeOutput("Traceback (most recent call last)")).toBeNull();
  });

  it("maps distribution aliases onto curated labels", () => {
    const packages = resolveCuratedPackages({ "rdkit-pypi": "2024.3", biopython: "1.84" });
    expect(packages["rdkit"]).toBe("2024.3");
    expect(packages["biopython (import Bio)"]).toBe("1.84");
    expect(packages["numpy"]).toBeNull();
  });

  it("finds tools on PATH without spawning", () => {
    const present = new Set(["/rt/bin/wemol-cli", "/usr/bin/curl"]);
    const tools = findToolsOnPath("/rt/bin:/usr/bin", ["wemol-cli", "curl", "hmmsearch"], "linux", (p) => present.has(p));
    expect(tools["wemol-cli"]).toBe("/rt/bin/wemol-cli");
    expect(tools["curl"]).toBe("/usr/bin/curl");
    expect(tools["hmmsearch"]).toBeNull();
  });

  it("tries Windows executable suffixes", () => {
    const present = new Set(["C:\\rt\\Scripts\\wemol-cli.exe"]);
    const tools = findToolsOnPath("C:\\rt\\Scripts", ["wemol-cli"], "win32", (p) => present.has(p));
    expect(tools["wemol-cli"]).toMatch(/wemol-cli\.exe$/);
  });

  it("renders installed and missing packages so the model installs before importing", () => {
    const manifest: RuntimeManifest = {
      probedAt: 0,
      python: { executable: "/rt/bin/python", version: "3.13.1", packageCount: 66 },
      packages: { "biopython (import Bio)": null, numpy: "2.1.0", requests: "2.32.0" },
      tools: { "wemol-cli": "/rt/bin/wemol-cli", hmmsearch: null },
    };
    const text = formatRuntimeManifest(manifest);
    expect(text).toContain("## Runtime Environment");
    expect(text).toContain("Python 3.13.1");
    expect(text).toContain("Installed: numpy 2.1.0, requests 2.32.0");
    expect(text).toContain("NOT installed: biopython (import Bio)");
    expect(text).toContain("CLI tools on PATH: wemol-cli");
    expect(text).toContain("CLI tools NOT on PATH: hmmsearch");
    expect(text).toContain("pip install");
  });

  it("degrades honestly when the probe failed", () => {
    const text = formatRuntimeManifest({ probedAt: 0, python: null, packages: {}, tools: { curl: "/usr/bin/curl" }, error: "probe timed out" });
    expect(text).toContain("could not be probed");
    expect(text).toContain("probe timed out");
    expect(formatRuntimeManifest(null)).toBe("");
  });

  it("recognizes commands that change the environment", () => {
    expect(commandChangesEnvironment("pip install biopython numpy")).toBe(true);
    expect(commandChangesEnvironment("conda install -y -c conda-forge hmmer")).toBe(true);
    expect(commandChangesEnvironment("python -m pip install anarci")).toBe(true);
    expect(commandChangesEnvironment("pip list | grep numpy")).toBe(false);
    expect(commandChangesEnvironment("python analyze.py")).toBe(false);
  });
});
