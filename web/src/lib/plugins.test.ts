import { describe, expect, it } from "vitest";
import * as path from "path";

import { fakeFs } from "./testing/fake-fs";
import {
  describePluginDir,
  listPlugins,
  loadPluginState,
  parseMcpServersObject,
  pluginMcpServerConfigs,
  resolveBundledPluginsDir,
} from "./plugins";

const HOME = "/home/u";
const env = { CHATMOL_HOME: "/home/u/.chatmol-lab" };

describe("plugin discovery", () => {
  it("finds the bundled plugins dir via env or relative to cwd", () => {
    const fs = fakeFs({ "/app/plugins/chatmol/plugin.json": "{}" });
    expect(resolveBundledPluginsDir({ cwd: "/app/web", fs, env: {} })).toBe(path.normalize("/app/web/../plugins"));
    expect(resolveBundledPluginsDir({ cwd: "/app", fs, env: {} })).toBe(path.normalize("/app/plugins"));
    expect(resolveBundledPluginsDir({ cwd: "/x", fs, env: { CHATMOL_BUNDLED_PLUGINS_DIR: "/app/plugins" } })).toBe("/app/plugins");
    expect(resolveBundledPluginsDir({ cwd: "/x", fs, env: {} })).toBeNull();
  });

  it("reads Claude Code, Codex and ChatMol manifest locations", () => {
    const fs = fakeFs({
      "/p/a/plugin.json": JSON.stringify({ name: "alpha", version: "1.0.0", skills: "./my-skills/" }),
      "/p/a/my-skills/x/SKILL.md": "---\ndescription: d\n---\nbody",
      "/p/b/.claude-plugin/plugin.json": JSON.stringify({ name: "beta" }),
      "/p/b/agents/helper.md": "---\ndescription: d\n---\nbody",
      "/p/c/.codex-plugin/plugin.json": JSON.stringify({ name: "gamma", description: "codex plugin" }),
      "/p/c/skills/y/SKILL.md": "---\ndescription: d\n---\nbody",
    });
    const [a] = describePluginDir("/p/a", "a", "bundled", { fs });
    expect(a.name).toBe("alpha");
    expect(a.version).toBe("1.0.0");
    expect(a.skillsDir).toBe(path.resolve("/p/a/my-skills"));
    expect(a.agentsDir).toBeUndefined();

    const [b] = describePluginDir("/p/b", "b", "bundled", { fs });
    expect(b.name).toBe("beta");
    expect(b.agentsDir).toBe(path.resolve("/p/b/agents"));

    const [c] = describePluginDir("/p/c", "c", "bundled", { fs });
    expect(c.name).toBe("gamma");
    expect(c.description).toBe("codex plugin");
    expect(c.skillsDir).toBe(path.resolve("/p/c/skills"));
  });

  it("treats a manifest-less directory with skills/ as a plugin and ignores empty dirs", () => {
    const fs = fakeFs({
      "/p/plain/skills/s/SKILL.md": "---\ndescription: d\n---\nbody",
      "/p/empty/README.md": "nothing",
    });
    expect(describePluginDir("/p/plain", "plain", "linked", { fs })[0].name).toBe("plain");
    expect(describePluginDir("/p/empty", "empty", "linked", { fs })).toEqual([]);
    expect(describePluginDir("/p/missing", "missing", "linked", { fs })[0].error).toMatch(/not found/);
  });

  it("expands a marketplace.json (ChatMol-Skills layout)", () => {
    const fs = fakeFs({
      "/m/marketplace.json": JSON.stringify({
        name: "chatmol-skills",
        plugins: [{ name: "chatmol", source: { source: "local", path: "./plugins/chatmol" } }],
      }),
      "/m/plugins/chatmol/.codex-plugin/plugin.json": JSON.stringify({ name: "chatmol", version: "0.1.0" }),
      "/m/plugins/chatmol/skills/wemol-cli-official/SKILL.md": "---\ndescription: d\n---\nbody",
    });
    const records = describePluginDir("/m", "m", "linked", { fs });
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("chatmol");
    expect(records[0].dir).toBe(path.resolve("/m/plugins/chatmol"));
    expect(records[0].skillsDir).toBe(path.resolve("/m/plugins/chatmol/skills"));
  });

  it("parses .mcp.json and expands the plugin root variable", () => {
    const servers = parseMcpServersObject(
      { mcpServers: { pymol: { command: "python", args: ["${CLAUDE_PLUGIN_ROOT}/server.py"], env: { ROOT: "${CHATMOL_PLUGIN_ROOT}" } }, bad: {} } },
      "/p/x",
    );
    expect(servers).toEqual([{ id: "pymol", command: "python", args: ["/p/x/server.py"], env: { ROOT: "/p/x" } }]);
  });

  it("merges installed rows over bundled plugins and honours the disabled list", () => {
    const fs = fakeFs({
      "/app/plugins/chatmol/plugin.json": JSON.stringify({ name: "chatmol", version: "bundled" }),
      "/app/plugins/chatmol/skills/a/SKILL.md": "---\ndescription: d\n---\nbody",
      "/app/plugins/extra/skills/b/SKILL.md": "---\ndescription: d\n---\nbody",
      "/home/u/.chatmol-lab/plugins.json": JSON.stringify({
        installed: [
          { name: "chatmol", source: "git", origin: "https://github.com/ChatMol/ChatMol-Skills", path: "/home/u/.chatmol-lab/plugins/chatmol", installedAt: "2026-09-13" },
          { name: "linked", source: "local", origin: "/work/linked", path: "/work/linked" },
        ],
        disabled: ["extra"],
      }),
      "/home/u/.chatmol-lab/plugins/chatmol/plugin.json": JSON.stringify({ name: "chatmol", version: "installed" }),
      "/home/u/.chatmol-lab/plugins/chatmol/.mcp.json": JSON.stringify({ mcpServers: { viewer: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/viewer.js"] } } }),
      "/work/linked/agents/x.md": "---\ndescription: d\n---\nbody",
    });
    const state = loadPluginState({ fs, env, homedir: HOME });
    expect(state.installed).toHaveLength(2);
    expect(state.disabled).toEqual(["extra"]);

    const plugins = listPlugins({ fs, env, homedir: HOME, cwd: "/app/web" });
    // Same-name plugins from different sources coexist under distinct keys.
    expect(plugins.map((p) => [p.key, p.source, p.enabled, p.version])).toEqual([
      ["installed:chatmol", "installed", true, "installed"],
      ["installed:linked", "linked", true, undefined],
      ["bundled:chatmol", "bundled", true, "bundled"],
      ["bundled:extra", "bundled", false, undefined],
    ]);
    expect(plugins[0].origin).toBe("https://github.com/ChatMol/ChatMol-Skills");

    const mcp = pluginMcpServerConfigs({ fs, env, homedir: HOME, cwd: "/app/web" });
    expect(mcp).toEqual([{
      id: "chatmol-viewer",
      name: "viewer (chatmol)",
      plugin: "chatmol",
      command: "node",
      args: [path.normalize("/home/u/.chatmol-lab/plugins/chatmol") + "/viewer.js"],
    }]);
  });
});
