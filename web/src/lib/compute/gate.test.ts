import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { getComputeGate, isMeteredTool, openComputeGate, setComputeGate, type ComputeGate } from "./gate";
import { executeTool } from "../tools";

afterEach(() => {
  setComputeGate(null);
  delete process.env.CHATMOL_DEPLOYMENT;
});

describe("ComputeGate", () => {
  it("is open in local mode", async () => {
    delete process.env.CHATMOL_DEPLOYMENT;
    expect(await getComputeGate()).toBe(openComputeGate);
    expect(await openComputeGate.beforeChatRun({ userId: "u", sessionId: "s" })).toEqual({ allowed: true });
    expect(await openComputeGate.beforeToolRun({ userId: "u", sessionId: "s", tool: "nvidia_openfold2" })).toEqual({ allowed: true });
  });

  it("only meters NVIDIA NIM tools", () => {
    expect(isMeteredTool("nvidia_openfold2")).toBe(true);
    expect(isMeteredTool("bash")).toBe(false);
    expect(isMeteredTool("wemol_cli")).toBe(false);
    expect(isMeteredTool("mcp__pymol__render")).toBe(false);
  });

  it("uses an installed gate over the deployment default", async () => {
    const custom: ComputeGate = { ...openComputeGate, async beforeChatRun() { return { allowed: false, reason: "nope", code: "quota" }; } };
    setComputeGate(custom);
    expect(await getComputeGate()).toBe(custom);
  });

  it("stops a metered tool before it runs when the gate denies it", async () => {
    const calls: string[] = [];
    setComputeGate({
      ...openComputeGate,
      async beforeToolRun({ tool }) { calls.push(`before:${tool}`); return { allowed: false, reason: "Daily cap reached", code: "daily_cap" }; },
      async afterToolRun({ tool }) { calls.push(`after:${tool}`); },
    });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cm-gate-"));
    try {
      const result = await executeTool("nvidia_openfold2", { sequence: "MKT" }, workspace, "session-1", [], "user-1");
      expect(result.success).toBe(false);
      expect(result.output).toBe("Daily cap reached");
      expect(calls).toEqual(["before:nvidia_openfold2"]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not consult the gate for unmetered tools", async () => {
    const calls: string[] = [];
    setComputeGate({
      ...openComputeGate,
      async beforeToolRun({ tool }) { calls.push(tool); return { allowed: false, reason: "never" }; },
    });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cm-gate-"));
    try {
      fs.writeFileSync(path.join(workspace, "a.txt"), "hello");
      const result = await executeTool("read_file", { path: "a.txt" }, workspace, "session-2", [], "user-1");
      expect(result.success).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
