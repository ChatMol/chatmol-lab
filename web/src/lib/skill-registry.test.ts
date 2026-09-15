import { beforeEach, describe, expect, it } from "vitest";
import * as path from "path";

import { fakeFs } from "./testing/fake-fs";
import {
  buildInvokedSkillsSection,
  buildSkillCatalogSection,
  catalogDescription,
  getSkill,
  invalidateSkillCache,
  listSkills,
  parseInvokedSkillNames,
  readSkillResource,
  renderSkillContent,
  resolveSkillRoots,
  stripInvokedSkillNames,
} from "./skill-registry";

const HOME = "/home/u";
const env = { CHATMOL_HOME: "/home/u/.chatmol-lab" };

function skillMd(description: string, extra = "", body = "Do the thing.") {
  return `---\nname: Display\ndescription: ${description}\n${extra}---\n\n${body}\n`;
}

describe("skill registry", () => {
  beforeEach(() => invalidateSkillCache());

  it("ranks project, custom, user and plugin roots in that order", () => {
    const roots = resolveSkillRoots({
      cwd: "/ws",
      env: { ...env, CHATMOL_SKILL_DIRS: "/custom/a" },
      homedir: HOME,
      fs: fakeFs({}),
      plugins: [
        { name: "one", key: "installed:one", dir: "/p/one", source: "installed", enabled: true, mcpServers: [], skillsDir: "/p/one/skills" },
        { name: "two", key: "bundled:two", dir: "/p/two", source: "bundled", enabled: true, mcpServers: [] },
      ],
    });
    expect(roots.map((r) => [r.source, r.root])).toEqual([
      ["project-chatmol", path.join("/ws", ".chatmol", "skills")],
      ["project-agents", path.join("/ws", ".agents", "skills")],
      ["project-claude", path.join("/ws", ".claude", "skills")],
      ["custom", "/custom/a"],
      ["user-chatmol", path.join("/home/u/.chatmol-lab", "skills")],
      ["user-agents", path.join(HOME, ".agents", "skills")],
      ["user-claude", path.join(HOME, ".claude", "skills")],
      ["plugin:installed:one", "/p/one/skills"],
    ]);
    expect(roots.map((r) => r.rank)).toEqual([...roots.map((r) => r.rank)].sort((a, b) => a - b));
  });

  it("discovers bundles and flat files, skips _ dirs, and lets the nearest root win", () => {
    const fs = fakeFs({
      "/ws/.agents/skills/uniprot/SKILL.md": skillMd("workspace override"),
      "/home/u/.agents/skills/flat.md": skillMd("flat file skill"),
      "/home/u/.agents/skills/_shared/SKILL.md": skillMd("hidden helper"),
      "/home/u/.agents/skills/nodesc/SKILL.md": "---\nname: x\n---\nno description",
      "/p/skills/uniprot/SKILL.md": skillMd("plugin version", "category: databases\ntags: [uniprot, api]\ndisable-model-invocation: true\n"),
      "/p/skills/protein-qc/SKILL.md": skillMd("QC metrics", "user-invocable: false\n"),
    });
    const o = { cwd: "/ws", env, homedir: HOME, fs, plugins: [{ name: "chatmol", key: "bundled:chatmol", dir: "/p", source: "bundled" as const, enabled: true, mcpServers: [], skillsDir: "/p/skills" }] };
    const skills = listSkills(o);
    expect(skills.map((s) => s.id)).toEqual(["flat", "protein-qc", "uniprot"]);

    const uniprot = skills.find((s) => s.id === "uniprot")!;
    expect(uniprot.description).toBe("workspace override");
    expect(uniprot.source).toBe("project-agents");
    expect(uniprot.modelInvocable).toBe(true);
    expect(uniprot.dir).toBe(path.normalize("/ws/.agents/skills/uniprot"));

    const flat = skills.find((s) => s.id === "flat")!;
    expect(flat.path).toBe(path.normalize("/home/u/.agents/skills/flat.md"));
    expect(flat.dir).toBe(path.normalize("/home/u/.agents/skills"));

    const qc = skills.find((s) => s.id === "protein-qc")!;
    expect(qc.userInvocable).toBe(false);
    expect(qc.modelInvocable).toBe(true);
  });

  it("reads invocation flags, category and tags from frontmatter", () => {
    const fs = fakeFs({
      "/p/skills/uniprot/SKILL.md": skillMd("plugin version", "category: databases\ntags: [uniprot, api]\ndisable-model-invocation: true\n"),
    });
    const o = { env, homedir: HOME, fs, plugins: [{ name: "chatmol", key: "bundled:chatmol", dir: "/p", source: "bundled" as const, enabled: true, mcpServers: [], skillsDir: "/p/skills" }] };
    const [uniprot] = listSkills(o);
    expect(uniprot.category).toBe("databases");
    expect(uniprot.tags).toEqual(["uniprot", "api"]);
    expect(uniprot.modelInvocable).toBe(false);
    expect(uniprot.userInvocable).toBe(true);
    expect(uniprot.name).toBe("Display");
  });

  it("re-reads the body on getSkill and caches the catalog briefly", () => {
    const files: Record<string, string> = { "/p/skills/a/SKILL.md": skillMd("first", "", "v1") };
    const fs = fakeFs(files);
    let now = 1_000;
    const o = { env, homedir: HOME, fs, now: () => now, plugins: [{ name: "x", key: "bundled:x", dir: "/p", source: "bundled" as const, enabled: true, mcpServers: [], skillsDir: "/p/skills" }] };
    expect(getSkill("a", o)?.content).toBe("v1");

    // Body edits are visible immediately; the catalog is served from cache.
    files[path.normalize("/p/skills/a/SKILL.md")] = skillMd("first", "", "v2");
    const fs2 = fakeFs(files);
    expect(getSkill("a", { ...o, fs: fs2 })?.content).toBe("v2");
    expect(getSkill("missing", o)).toBeUndefined();

    // A new skill appears once the TTL passes.
    files[path.normalize("/p/skills/b/SKILL.md")] = skillMd("second");
    const fs3 = fakeFs(files);
    expect(listSkills({ ...o, fs: fs3 }).map((s) => s.id)).toEqual(["a"]);
    now += 10_000;
    expect(listSkills({ ...o, fs: fs3 }).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("reads resources inside the skill dir or its root, never outside", () => {
    const fs = fakeFs({
      "/p/skills/a/SKILL.md": skillMd("a"),
      "/p/skills/a/references/notes.md": "notes",
      "/p/skills/_shared/SKILL.md": "shared",
      "/p/secret.txt": "nope",
    });
    const o = { env, homedir: HOME, fs, plugins: [{ name: "x", key: "bundled:x", dir: "/p", source: "bundled" as const, enabled: true, mcpServers: [], skillsDir: "/p/skills" }] };
    const [a] = listSkills(o);
    expect(readSkillResource(a, "references/notes.md", o).content).toBe("notes");
    expect(readSkillResource(a, "../_shared/SKILL.md", o).content).toBe("shared");
    expect(() => readSkillResource(a, "../../secret.txt", o)).toThrow(/escapes/);
    expect(() => readSkillResource(a, "missing.md", o)).toThrow(/not found/);
  });

  it("renders the dsh skill_content block and the catalog section", () => {
    const rendered = renderSkillContent({ id: "uniprot", dir: "/p/skills/uniprot", content: "Fetch <entries>." });
    expect(rendered).toContain('<skill_content name="uniprot">');
    expect(rendered).toContain("Base directory for this skill: /p/skills/uniprot");
    expect(rendered).toContain("<skill_instructions>\nFetch <entries>.\n</skill_instructions>");

    const base = { name: "n", category: "general", tags: [], source: "bundled", rank: 600, path: "", dir: "", userInvocable: true };
    const section = buildSkillCatalogSection([
      { ...base, id: "visible", description: "Look <up> things", modelInvocable: true },
      { ...base, id: "hidden", description: "user only", modelInvocable: false },
    ]);
    expect(section).toContain("<available_skills>\n- `visible`: Look &lt;up&gt; things\n</available_skills>");
    expect(section).not.toContain("hidden");
    expect(section).toContain("call the `skill` tool");
    expect(buildSkillCatalogSection([{ ...base, id: "hidden", description: "x", modelInvocable: false }])).toBe("");

    expect(buildInvokedSkillsSection([])).toBe("");
    expect(buildInvokedSkillsSection([{ ...base, id: "a", description: "d", modelInvocable: true, content: "body" }]))
      .toContain("## Invoked Skills");
  });

  it("clips catalog descriptions to a single line", () => {
    expect(catalogDescription("  multi\nline   text ")).toBe("multi line text");
    expect(catalogDescription("x".repeat(600)).length).toBe(500);
  });

  it("parses /name invocations on the first line only", () => {
    expect(parseInvokedSkillNames("/uniprot fetch P69905")).toEqual(["uniprot"]);
    expect(parseInvokedSkillNames("/a /b then do it")).toEqual(["a", "b"]);
    expect(parseInvokedSkillNames("hello\n/uniprot")).toEqual([]);
    expect(parseInvokedSkillNames("/compact")).toEqual(["compact"]);
    expect(parseInvokedSkillNames("/ nope")).toEqual([]);
    expect(stripInvokedSkillNames("/uniprot fetch P69905", ["uniprot"])).toBe("fetch P69905");
    expect(stripInvokedSkillNames("/uniprot", ["uniprot"])).toBe("Use the uniprot skill.");
    expect(stripInvokedSkillNames("/a /b go", ["a", "b"])).toBe("go");
  });
});
