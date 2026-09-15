import { describe, expect, it } from "vitest";
import * as path from "path";

import {
  buildMcpPromptSection,
  buildMcpToolName,
  flattenMcpCallResult,
  isMcpToolName,
  parseMcpToolName,
  toMcpToolDefinitions,
} from "./mcp";

describe("mcp tool naming", () => {
  it("namespaces tools the same way dsh / Claude Code do", () => {
    expect(buildMcpToolName("pymol", "run_pymol_command")).toBe("mcp__pymol__run_pymol_command");
    expect(buildMcpToolName("my server!", "a.b")).toBe("mcp__my_server___a_b");
    expect(isMcpToolName("mcp__pymol__open_pymol")).toBe(true);
    expect(isMcpToolName("bash")).toBe(false);
    expect(parseMcpToolName("mcp__chimerax__save_image")).toEqual({ serverId: "chimerax", toolName: "save_image" });
    expect(parseMcpToolName("mcp__broken")).toBeNull();
  });

  it("converts tools/list entries into tool definitions with object schemas", () => {
    const defs = toMcpToolDefinitions("pymol", "PyMOL", [
      { name: "open_pymol", description: "open pymol" },
      { name: "run_pymol_command", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "run_pymol_command" },
    ]);
    expect(defs.map((d) => d.name)).toEqual(["mcp__pymol__open_pymol", "mcp__pymol__run_pymol_command"]);
    expect(defs[0].description).toBe("[PyMOL] open pymol");
    expect(defs[0].input_schema).toEqual({ type: "object", properties: {} });
    expect(defs[1].input_schema.required).toEqual(["command"]);
  });
});

describe("mcp result flattening", () => {
  it("joins text and writes images into the workspace", () => {
    const written: Array<{ p: string; size: number }> = [];
    const result = flattenMcpCallResult(
      {
        content: [
          { type: "text", text: "Image saved to /ws/view.png" },
          { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" },
        ],
      },
      "pymol",
      "save_image",
      "/ws",
      (p, d) => written.push({ p, size: d.length }),
    );
    expect(result.success).toBe(true);
    expect(result.imagePaths).toHaveLength(1);
    expect(result.imagePaths[0].startsWith("mcp-images/pymol-save_image-")).toBe(true);
    expect(written[0].p).toBe(path.join("/ws", result.imagePaths[0]));
    expect(written[0].size).toBe("png-bytes".length);
    expect(result.output).toContain("Image saved to /ws/view.png");
    expect(result.output).toContain("save_artifact");
  });

  it("reports isError and empty content", () => {
    const err = flattenMcpCallResult({ isError: true, content: [{ type: "text", text: "boom" }] }, "s", "t", "/ws", () => {});
    expect(err.success).toBe(false);
    expect(err.output).toBe("boom");
    const empty = flattenMcpCallResult({ content: [] }, "s", "t", "/ws", () => {});
    expect(empty.output).toBe("(no content)");
  });
});

describe("mcp prompt section", () => {
  it("lists servers with hints and failures", () => {
    const text = buildMcpPromptSection(
      {
        definitions: [],
        servers: [
          { id: "pymol", label: "PyMOL", preset: "pymol", toolCount: 7 },
          { id: "chimerax", label: "UCSF ChimeraX", preset: "chimerax", toolCount: 0, error: "ChimeraX not found" },
        ],
      },
      { pymol: "Call open_pymol first." },
    );
    expect(text).toContain("## MCP Servers");
    expect(text).toContain("PyMOL (pymol): 7 tools. Call open_pymol first.");
    expect(text).toContain("unavailable — ChimeraX not found");
    expect(buildMcpPromptSection({ definitions: [], servers: [] }, {})).toBe("");
  });
});
