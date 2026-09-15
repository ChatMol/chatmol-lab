import { beforeEach, describe, expect, it } from "vitest";
import * as path from "path";

import { fakeFs } from "./testing/fake-fs";
import { getAgent, invalidateAgentCache, listAgents, parseAgentFile, resolveAgentRoots } from "./agent-registry";

const HOME = "/home/u";
const env = { CHATMOL_HOME: "/home/u/.chatmol-lab" };
const plugin = { name: "chatmol", key: "bundled:chatmol", dir: "/p", source: "bundled" as const, enabled: true, mcpServers: [], agentsDir: "/p/agents" };

describe("agent registry", () => {
  beforeEach(() => invalidateAgentCache());

  it("ranks workspace, user and plugin roots", () => {
    const roots = resolveAgentRoots({ cwd: "/ws", env, homedir: HOME, fs: fakeFs({}), plugins: [plugin] });
    expect(roots.map((r) => [r.source, r.root])).toEqual([
      ["project-chatmol", path.join("/ws", ".chatmol", "agents")],
      ["project-claude", path.join("/ws", ".claude", "agents")],
      ["user-chatmol", path.join("/home/u/.chatmol-lab", "agents")],
      ["user-claude", path.join(HOME, ".claude", "agents")],
      ["plugin:bundled:chatmol", "/p/agents"],
    ]);
  });

  it("parses Claude Code style frontmatter", () => {
    const root = { rank: 600, source: "plugin:chatmol", root: "/p/agents" };
    const agent = parseAgentFile(
      "---\nname: WeMol Docs\ndescription: Explore WeMol schemas.\ntools: wemol_cli, read_file\nmodel: fast\nskills: wemol-cli, uniprot\n---\nRole: explorer.\n",
      "wemol-docs",
      "/p/agents/wemol-docs.md",
      root,
    );
    expect(agent).toMatchObject({
      id: "wemol-docs",
      name: "WeMol Docs",
      description: "Explore WeMol schemas.",
      prompt: "Role: explorer.",
      toolNames: ["wemol_cli", "read_file"],
      model: "fast",
      skills: ["wemol-cli", "uniprot"],
      source: "plugin:chatmol",
    });

    const minimal = parseAgentFile("---\ndescription: d\n---\nbody", "general", "/p/agents/general.md", root)!;
    expect(minimal.name).toBe("general");
    expect(minimal.toolNames).toEqual(["*"]);
    expect(minimal.model).toBe("main");
    expect(minimal.skills).toEqual([]);

    expect(parseAgentFile("---\ntools: [bash, \"*\"]\ndescription: d\n---\n", "x", "/x.md", root)!.toolNames).toEqual(["*"]);
    expect(parseAgentFile("---\nname: nodesc\n---\nbody", "x", "/x.md", root)).toBeNull();
    expect(parseAgentFile("---\ndescription: [\n---\nbody", "x", "/x.md", root)).toBeNull();
  });

  it("lists built-ins first, lets the nearest root win, and ignores non-markdown or hidden entries", () => {
    const fs = fakeFs({
      "/ws/.claude/agents/reviewer.md": "---\ndescription: workspace reviewer\n---\nlocal",
      "/p/agents/reviewer.md": "---\ndescription: bundled reviewer\n---\nbundled",
      "/p/agents/general.md": "---\ndescription: tries to shadow the built-in\n---\nnope",
      "/p/agents/wemol-docs.md": "---\ndescription: docs\ntools: wemol_cli\n---\nbody",
      "/p/agents/_draft.md": "---\ndescription: hidden\n---\nbody",
      "/p/agents/notes.txt": "not an agent",
    });
    const agents = listAgents({ cwd: "/ws", env, homedir: HOME, fs, plugins: [plugin] });
    expect(agents.map((a) => [a.id, a.source])).toEqual([
      ["general", "built-in"],
      ["reviewer", "project-claude"],
      ["wemol-docs", "plugin:bundled:chatmol"],
    ]);
    expect(agents[0].toolNames).toEqual(["*"]);
    expect(agents[1].description).toBe("workspace reviewer");
    expect(getAgent("wemol-docs", { cwd: "/ws", env, homedir: HOME, fs, plugins: [plugin] })?.toolNames).toEqual(["wemol_cli"]);
    expect(getAgent("nope", { env, homedir: HOME, fs, plugins: [plugin] })).toBeUndefined();
  });
});
