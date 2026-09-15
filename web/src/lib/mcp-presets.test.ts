import { describe, expect, it } from "vitest";
import * as path from "path";

import {
  describePresetStatus,
  discoverViewerBinary,
  resolveMcpServersDir,
  resolvePresetLaunch,
  resolvePresetPython,
} from "./mcp-presets";

function fakeFs(files: string[], dirs: Record<string, string[]> = {}) {
  const set = new Set(files.map((f) => path.normalize(f)));
  return {
    existsSync: (p: string) => set.has(path.normalize(p)) || Object.keys(dirs).some((d) => path.normalize(d) === path.normalize(p)),
    readdirSync: (p: string) => dirs[path.normalize(p)] ?? [],
  };
}

describe("mcp presets", () => {
  it("finds the bundled server scripts relative to cwd or via env", () => {
    const fs = fakeFs(["/app/web/mcp-servers/pymol_server.py"]);
    expect(resolveMcpServersDir({ cwd: "/app/web", fs, env: {} })).toBe(path.join("/app/web", "mcp-servers"));
    expect(resolveMcpServersDir({ cwd: "/app", fs, env: {} })).toBe(path.join("/app", "web", "mcp-servers"));
    expect(resolveMcpServersDir({ cwd: "/elsewhere", fs, env: { CHATMOL_MCP_SERVERS_DIR: "/app/web/mcp-servers" } }))
      .toBe("/app/web/mcp-servers");
    expect(resolveMcpServersDir({ cwd: "/elsewhere", fs, env: {} })).toBeNull();
  });

  it("prefers the bundled conda python", () => {
    const fs = fakeFs(["/rt/env/bin/python"]);
    expect(resolvePresetPython({ env: { CHATMOL_CONDA_PREFIX: "/rt/env" }, platform: "darwin", fs })).toBe("/rt/env/bin/python");
    expect(resolvePresetPython({ env: {}, platform: "darwin", fs })).toBe("python3");
    expect(resolvePresetPython({ env: {}, platform: "win32", fs })).toBe("python");
  });

  it("discovers viewer apps per platform", () => {
    const macFs = fakeFs(
      ["/Applications/ChimeraX-1.9.app/Contents/bin/ChimeraX", "/Applications/PyMOL.app/Contents/MacOS/PyMOL"],
      { "/Applications": ["ChimeraX-1.9.app", "PyMOL.app", "Other.app"] },
    );
    expect(discoverViewerBinary("chimerax", { platform: "darwin", fs: macFs, env: {}, homedir: "/Users/x" }))
      .toBe("/Applications/ChimeraX-1.9.app/Contents/bin/ChimeraX");
    expect(discoverViewerBinary("pymol", { platform: "darwin", fs: macFs, env: {}, homedir: "/Users/x" }))
      .toBe("/Applications/PyMOL.app/Contents/MacOS/PyMOL");

    const winFs = fakeFs(
      ["C:\\Program Files\\ChimeraX 1.9\\bin\\ChimeraX.exe"],
      { "C:\\Program Files": ["ChimeraX 1.9"] },
    );
    expect(discoverViewerBinary("chimerax", { platform: "win32", fs: winFs, env: { ProgramFiles: "C:\\Program Files" }, homedir: "C:\\Users\\x" }))
      .toBe("C:\\Program Files\\ChimeraX 1.9\\bin\\ChimeraX.exe");

    expect(discoverViewerBinary("pymol", { platform: "linux", fs: fakeFs([]), env: {}, homedir: "/home/x" })).toBeNull();
    expect(discoverViewerBinary("pymol", { platform: "linux", fs: fakeFs(["/custom/pymol"]), env: { CHATMOL_PYMOL_BIN: "/custom/pymol" }, homedir: "/home/x" }))
      .toBe("/custom/pymol");
  });

  it("builds a launch spec that passes the workspace and viewer path", () => {
    const fs = fakeFs(["/app/web/mcp-servers/pymol_server.py", "/rt/env/bin/python", "/rt/env/bin/pymol"]);
    const result = resolvePresetLaunch("pymol", "/ws/s1", {
      cwd: "/app/web",
      fs,
      platform: "linux",
      env: { CHATMOL_CONDA_PREFIX: "/rt/env" },
      homedir: "/home/x",
    });
    expect("launch" in result).toBe(true);
    if ("launch" in result) {
      expect(result.launch.command).toBe("/rt/env/bin/python");
      expect(result.launch.args).toEqual([path.join("/app/web", "mcp-servers", "pymol_server.py")]);
      expect(result.launch.env.CHATMOL_MCP_WORKSPACE).toBe("/ws/s1");
      expect(result.launch.env.CHATMOL_PYMOL_BIN).toBe("/rt/env/bin/pymol");
    }
    const missing = resolvePresetLaunch("chimerax", "/ws", { cwd: "/nowhere", fs: fakeFs([]), env: {}, platform: "linux", homedir: "/home/x" });
    expect("error" in missing).toBe(true);
  });

  it("reports readiness with actionable hints", () => {
    const status = describePresetStatus("chimerax", true, false, { cwd: "/nowhere", fs: fakeFs([]), env: {}, platform: "linux", homedir: "/home/x" });
    expect(status.ready).toBe(false);
    expect(status.hints.join(" ")).toMatch(/mcp/);
    expect(status.hints.join(" ")).toMatch(/ChimeraX/);
  });
});
