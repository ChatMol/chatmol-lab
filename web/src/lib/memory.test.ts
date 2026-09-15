import { describe, expect, it } from "vitest";
import * as path from "path";

import { fakeWritableFs } from "./testing/fake-fs";
import {
  buildMemorySection,
  deleteMemory,
  findSecret,
  getMemory,
  listMemories,
  memoryDir,
  saveMemory,
  validateMemoryInput,
} from "./memory";

const env = { CHATMOL_HOME: "/home/u/.chatmol-lab" };
const base = { env, homedir: "/home/u", cwd: "/ws", now: () => new Date("2026-09-13T00:00:00Z") };

describe("memory", () => {
  it("resolves scope directories, per user on servers", () => {
    expect(memoryDir("global", { env, homedir: "/home/u" })).toBe(path.join("/home/u/.chatmol-lab", "memory"));
    expect(memoryDir("global", { env, homedir: "/home/u", userId: "usr/1" })).toBe(path.join("/home/u/.chatmol-lab", "memory", "users", "usr_1"));
    expect(memoryDir("workspace", { cwd: "/ws" })).toBe(path.join("/ws", ".chatmol", "memory"));
    expect(memoryDir("workspace", {})).toBeNull();
  });

  it("saves entries, regenerates the index, and lets workspace shadow global", () => {
    const files: Record<string, string> = {};
    const fs = fakeWritableFs(files);
    const o = { ...base, fs };

    saveMemory({ name: "petase-goal", description: "User wants thermostable PETase variants", type: "project", scope: "global", content: "Target Tm > 70 °C." }, o);
    saveMemory({ name: "petase-goal", description: "Workspace-specific goal", type: "project", scope: "workspace", content: "Focus on the 2X PETase scaffold." }, o);
    saveMemory({ name: "dry-run-first", description: "Always dry-run WeMol submits", type: "feedback", scope: "global", content: "The user was burned by a bad payload." }, o);

    const entries = listMemories(o);
    expect(entries.map((e) => [e.name, e.scope])).toEqual([["petase-goal", "workspace"], ["dry-run-first", "global"]]);
    expect(getMemory("petase-goal", o)?.content).toBe("Focus on the 2X PETase scaffold.");
    expect(getMemory("petase-goal", o, "global")?.content).toBe("Target Tm > 70 °C.");

    const globalIndex = files[path.normalize("/home/u/.chatmol-lab/memory/MEMORY.md")];
    expect(globalIndex).toContain("- [dry-run-first](dry-run-first.md) — Always dry-run WeMol submits");
    expect(globalIndex).toContain("- [petase-goal](petase-goal.md) — User wants thermostable PETase variants");
    const file = files[path.normalize("/home/u/.chatmol-lab/memory/dry-run-first.md")];
    expect(file).toContain("type: feedback");
    expect(file).toContain("updatedAt: '2026-09-13T00:00:00.000Z'");

    expect(deleteMemory("petase-goal", "workspace", o)).toBe(true);
    expect(deleteMemory("petase-goal", "workspace", o)).toBe(false);
    expect(getMemory("petase-goal", o)?.scope).toBe("global");
    expect(files[path.normalize("/ws/.chatmol/memory/MEMORY.md")]).not.toContain("petase-goal");
  });

  it("reads hand-written Claude Code style files", () => {
    const fs = fakeWritableFs({
      "/home/u/.chatmol-lab/memory/MEMORY.md": "# Memory\n\n- [x](x.md) — stale index\n",
      "/home/u/.chatmol-lab/memory/prefers-openfold.md": "---\nname: prefers-openfold\ndescription: Prefers OpenFold2 over WeMol for quick folds\ntype: user\n---\n\nUse nvidia_openfold2 first.\n",
      "/home/u/.chatmol-lab/memory/notes.md": "---\ndescription: no name field\n---\nbody",
      "/home/u/.chatmol-lab/memory/Bad Name.md": "---\ndescription: d\n---\nbody",
    });
    const entries = listMemories({ ...base, fs });
    expect(entries.map((e) => [e.name, e.type])).toEqual([["notes", "project"], ["prefers-openfold", "user"]]);
  });

  it("rejects bad input and credentials", () => {
    expect(() => validateMemoryInput({ name: "Bad Name", description: "d", type: "user", scope: "global", content: "c" })).toThrow(/kebab-case/);
    expect(() => validateMemoryInput({ name: "ok", description: "", type: "user", scope: "global", content: "c" })).toThrow(/description/);
    expect(() => validateMemoryInput({ name: "ok", description: "d", type: "nope" as never, scope: "global", content: "c" })).toThrow(/type/);
    expect(() => validateMemoryInput({ name: "ok", description: "d", type: "user", scope: "global", content: "api_key = sk-abcdefghijklmnopqrstuvwxyz" })).toThrow(/credential/);
    expect(findSecret("NVIDIA key nvapi-abcdefghijklmnopqrstuvwxyz1234")).toMatch(/credential/);
    expect(findSecret("job id 8f0c655fbb01 progress 100%")).toBeNull();
    expect(validateMemoryInput({ name: "OK-Name", description: "  d  ", type: "user", scope: "global", content: " c " })).toEqual({ name: "ok-name", description: "d", type: "user", scope: "global", content: "c" });
  });

  it("renders a bounded prompt section", () => {
    const entry = (i: number) => ({ name: `e-${i}`, description: `desc <${i}>`, type: "reference" as const, scope: "global" as const, path: "", content: "" });
    const section = buildMemorySection([entry(1), entry(2), entry(3)], 2);
    expect(section).toContain("- `e-1` (reference, global): desc &lt;1&gt;");
    expect(section).toContain("1 older global entries omitted");
    expect(section).not.toContain("e-3");
    expect(buildMemorySection([])).toContain("Nothing is remembered yet.");
    expect(buildMemorySection([])).toContain('action "save"');
  });
});
