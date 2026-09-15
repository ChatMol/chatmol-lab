import { describe, expect, it } from "vitest";
import * as path from "path";

import { fakeFs } from "./testing/fake-fs";
import {
  buildFixedSubagentPrompt,
  buildRunSubagentToolDefinition,
  getSubagentApiConfig,
  listFixedSubagents,
  normalizeFixedSubagentIds,
  RUN_SUBAGENT_TOOL_NAME,
  SUBAGENT_MAX_LOOPS,
  SUBAGENT_MAX_OUTPUT_TOKENS,
  type SubagentLookup,
} from "./subagents";

/** The bundled plugin as shipped in the repository (plugins/chatmol/agents). */
const BUNDLED: SubagentLookup = {
  registry: {
    env: { CHATMOL_HOME: "/nonexistent" },
    homedir: "/nonexistent",
    plugins: [{
      name: "chatmol",
      key: "bundled:chatmol",
      dir: path.resolve(__dirname, "../../../plugins/chatmol"),
      source: "bundled",
      enabled: true,
      mcpServers: [],
      agentsDir: path.resolve(__dirname, "../../../plugins/chatmol/agents"),
    }],
  },
};

describe("subagents", () => {
  it("offers the runtime's general agent plus the bundled plugin's WeMol agents", () => {
    const agents = listFixedSubagents(BUNDLED);
    expect(agents.map((agent) => [agent.id, agent.source])).toEqual([
      ["general", "built-in"],
      ["wemol-docs", "plugin:bundled:chatmol"],
      ["wemol-monitor", "plugin:bundled:chatmol"],
    ]);
    expect(SUBAGENT_MAX_LOOPS).toBeGreaterThan(8);
  });

  it("runs subagents on the chat model with a larger budget, honouring model overrides", () => {
    const deepseek = getSubagentApiConfig({
      provider: "deepseek",
      url: "https://api.deepseek.com/chat/completions",
      key: "test",
      model: "deepseek-v4-pro",
      isAnthropic: false,
      maxOutputTokens: 8192,
    });
    expect(deepseek.model).toBe("deepseek-v4-pro");
    expect(deepseek.maxOutputTokens).toBe(SUBAGENT_MAX_OUTPUT_TOKENS);
    expect(deepseek.thinking).toEqual({ type: "enabled" });
    expect(deepseek.reasoningEffort).toBe("high");

    const anthropic = getSubagentApiConfig({
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      key: "test",
      model: "claude-sonnet-5",
      isAnthropic: true,
      maxOutputTokens: 8192,
    });
    expect(anthropic.model).toBe("claude-sonnet-5");
    expect(anthropic.thinking).toBeUndefined();
    expect(anthropic.reasoningEffort).toBeUndefined();

    const main = { provider: "deepseek" as const, url: "u", key: "k", model: "main-model", isAnthropic: false, maxOutputTokens: 100 };
    const fast = { ...main, model: "fast-model" };
    expect(getSubagentApiConfig(main, { model: "fast" }, fast).model).toBe("fast-model");
    expect(getSubagentApiConfig(main, { model: "fast" }).model).toBe("main-model");
    expect(getSubagentApiConfig(main, { model: "deepseek-v4-flash" }, fast).model).toBe("deepseek-v4-flash");
  });

  it("normalizes only known subagent ids", () => {
    expect(normalizeFixedSubagentIds(["wemol-docs", "unknown", "wemol-docs", "wemol-monitor"], BUNDLED))
      .toEqual(["wemol-docs", "wemol-monitor"]);
    expect(normalizeFixedSubagentIds("nope", BUNDLED)).toEqual([]);
  });

  it("builds a run_subagent tool restricted to enabled ids with their descriptions", () => {
    const tool = buildRunSubagentToolDefinition(["wemol-docs"], BUNDLED);

    expect(tool?.name).toBe(RUN_SUBAGENT_TOOL_NAME);
    const properties = tool?.input_schema.properties as Record<string, unknown>;
    const agentId = properties.agent_id as { enum: string[] };
    expect(agentId.enum).toEqual(["wemol-docs"]);
    expect(tool?.description).toContain("before proposing payload keys");
    expect(buildRunSubagentToolDefinition([], BUNDLED)).toBeNull();
  });

  it("describes enabled agents in the system prompt without their private persona", () => {
    const prompt = buildFixedSubagentPrompt(["wemol-monitor"], BUNDLED);
    expect(prompt).toContain("## Enabled Subagents");
    expect(prompt).toContain("`wemol-monitor`");
    expect(prompt).toContain("Progress 100%");
    expect(prompt).not.toContain("job diagnose");
    expect(buildFixedSubagentPrompt([], BUNDLED)).toBe("");
  });

  it("restricts WeMol subagents to wemol_cli only", () => {
    const wemolAgents = listFixedSubagents(BUNDLED).filter((agent) => agent.id.startsWith("wemol-"));
    expect(wemolAgents).toHaveLength(2);
    for (const agent of wemolAgents) expect(agent.toolNames).toEqual(["wemol_cli"]);
    expect(listFixedSubagents(BUNDLED).find((agent) => agent.id === "general")?.toolNames).toEqual(["*"]);
  });

  it("keeps the built-in general agent even with no plugins, and lets workspace files add agents", () => {
    const fs = fakeFs({
      "/ws/.chatmol/agents/reviewer.md": "---\ndescription: local reviewer\n---\nbody",
    });
    const agents = listFixedSubagents({
      cwd: "/ws",
      registry: { fs, env: { CHATMOL_HOME: "/nonexistent" }, homedir: "/nonexistent", plugins: [] },
    });
    expect(agents.map((agent) => [agent.id, agent.source])).toEqual([["general", "built-in"], ["reviewer", "project-chatmol"]]);
  });
});
