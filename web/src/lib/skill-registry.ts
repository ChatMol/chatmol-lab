/**
 * Skill registry (Agent Skills standard, dsh-style consumption).
 *
 * A skill is `<root>/<name>/SKILL.md` or `<root>/<name>.md` with YAML
 * frontmatter (`name`, `description`, optional `whenToUse`,
 * `disable-model-invocation`, `user-invocable`, `category`, `tags`,
 * `metadata`). The same files load unchanged in Claude Code, Codex and
 * DeepSeek Harness, and their `.agents/skills` roots are scanned here too.
 *
 * Roots are ranked; the lowest rank wins a duplicate name. The catalog
 * (summaries only) is cached for a few seconds; bodies are re-read on every
 * `getSkill` so edits show up in the next tool call.
 *
 * The model sees a `<available_skills>` catalog of names + descriptions and
 * loads a body on demand through the `skill` tool (progressive disclosure).
 */
import * as fsImpl from "fs";
import * as os from "os";
import * as path from "path";
import matter from "gray-matter";

import { listEnabledPlugins, type PluginFsLike, type PluginRecord, getChatmolHome } from "./plugins";

export interface SkillRoot {
  rank: number;
  source: string;
  root: string;
}

export interface SkillSummary {
  /** Directory (or flat-file) name; the identifier used by the `skill` tool. */
  id: string;
  /** Display name from frontmatter (falls back to the id). */
  name: string;
  description: string;
  whenToUse?: string;
  category: string;
  tags: string[];
  source: string;
  rank: number;
  /** Absolute path of the instruction file. */
  path: string;
  /** Base directory for relative resources referenced by the body. */
  dir: string;
  modelInvocable: boolean;
  userInvocable: boolean;
  metadata?: Record<string, unknown>;
}

export interface SkillDefinition extends SkillSummary {
  content: string;
}

type EnvLike = Record<string, string | undefined>;

export interface SkillRegistryOptions {
  /** Session workspace; enables the project-level roots. */
  cwd?: string;
  env?: EnvLike;
  homedir?: string;
  fs?: PluginFsLike;
  /** Override plugin discovery (tests). */
  plugins?: PluginRecord[];
  now?: () => number;
}

export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
export const CATALOG_DESCRIPTION_MAX_LENGTH = 500;
const CATALOG_TTL_MS = 5_000;

function opts(o: SkillRegistryOptions) {
  return {
    env: o.env ?? process.env,
    homedir: o.homedir ?? os.homedir(),
    fs: o.fs ?? (fsImpl as unknown as PluginFsLike),
    now: o.now ?? Date.now,
  };
}

function isDir(fs: PluginFsLike, p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(fs: PluginFsLike, p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Ranked roots for the given lookup context (see the design spec table). */
export function resolveSkillRoots(o: SkillRegistryOptions = {}): SkillRoot[] {
  const { env, homedir, fs } = opts(o);
  const roots: SkillRoot[] = [];
  if (o.cwd) {
    roots.push({ rank: 100, source: "project-chatmol", root: path.join(o.cwd, ".chatmol", "skills") });
    roots.push({ rank: 200, source: "project-agents", root: path.join(o.cwd, ".agents", "skills") });
    roots.push({ rank: 250, source: "project-claude", root: path.join(o.cwd, ".claude", "skills") });
  }
  const custom = (env.CHATMOL_SKILL_DIRS || "").split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  custom.forEach((dir, index) => roots.push({ rank: 300 + index, source: "custom", root: dir }));
  roots.push({ rank: 400, source: "user-chatmol", root: path.join(getChatmolHome({ env, homedir, fs }), "skills") });
  roots.push({ rank: 500, source: "user-agents", root: path.join(homedir, ".agents", "skills") });
  roots.push({ rank: 550, source: "user-claude", root: path.join(homedir, ".claude", "skills") });
  const plugins = o.plugins ?? listEnabledPlugins({ env, homedir, fs });
  plugins.forEach((plugin, index) => {
    if (plugin.skillsDir) roots.push({ rank: 600 + index, source: `plugin:${plugin.key}`, root: plugin.skillsDir });
  });
  return roots;
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes)$/i.test(value.trim())) return true;
    if (/^(false|no)$/i.test(value.trim())) return false;
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

function frontmatterString(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function frontmatterTags(data: Record<string, unknown>): string[] {
  const value = data.tags;
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((tag) => tag.trim()).filter(Boolean);
  return [];
}

/** Parse one SKILL.md. Returns null (after a console warning) when unusable. */
export function parseSkillFile(raw: string, id: string, filePath: string, dir: string, root: SkillRoot): SkillDefinition | null {
  let parsed: { data: Record<string, unknown>; content: string };
  try {
    const result = matter(raw);
    parsed = { data: (result.data || {}) as Record<string, unknown>, content: result.content };
  } catch (err) {
    console.warn(`[skills] ${filePath} ignored: invalid YAML frontmatter (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  const data = parsed.data;
  const description = frontmatterString(data, "description");
  if (!description) {
    console.warn(`[skills] ${filePath} ignored: frontmatter requires a description`);
    return null;
  }
  let modelInvocable = true;
  let userInvocable = true;
  try {
    const disableModel = frontmatterBoolean(data, "disable-model-invocation");
    if (disableModel !== undefined) modelInvocable = !disableModel;
    const userFlag = frontmatterBoolean(data, "user-invocable");
    if (userFlag !== undefined) userInvocable = userFlag;
  } catch (err) {
    console.warn(`[skills] ${filePath} ignored: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
    ? data.metadata as Record<string, unknown>
    : undefined;
  return {
    id,
    name: frontmatterString(data, "name") || id,
    description,
    ...(frontmatterString(data, "whenToUse", "when-to-use") ? { whenToUse: frontmatterString(data, "whenToUse", "when-to-use") } : {}),
    category: frontmatterString(data, "category") || "general",
    tags: frontmatterTags(data),
    source: root.source,
    rank: root.rank,
    path: filePath,
    dir,
    modelInvocable,
    userInvocable,
    ...(metadata ? { metadata } : {}),
    content: parsed.content.trim(),
  };
}

/** Scan one root: `<name>/SKILL.md` bundles and flat `<name>.md` files. */
export function scanSkillRoot(root: SkillRoot, fs: PluginFsLike): SkillDefinition[] {
  if (!isDir(fs, root.root)) return [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root.root);
  } catch {
    return [];
  }
  const skills: SkillDefinition[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    const full = path.join(root.root, entry);
    let filePath: string | null = null;
    let id = entry;
    let dir = full;
    if (isDir(fs, full)) {
      const bundle = path.join(full, "SKILL.md");
      if (isFile(fs, bundle)) filePath = bundle;
    } else if (entry.toLowerCase().endsWith(".md") && isFile(fs, full)) {
      id = entry.slice(0, -3);
      dir = root.root;
      filePath = full;
    }
    if (!filePath || !SKILL_ID_PATTERN.test(id)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const skill = parseSkillFile(raw, id, filePath, dir, root);
    if (skill) skills.push(skill);
  }
  return skills;
}

let catalogCache: Map<string, { at: number; skills: SkillSummary[] }> = new Map();

export function invalidateSkillCache(): void {
  catalogCache = new Map();
}

function toSummary(skill: SkillDefinition): SkillSummary {
  const summary: SkillSummary & { content?: string } = { ...skill };
  delete summary.content;
  return summary;
}

/** Sorted, de-duplicated summaries for the lookup context (cached briefly). */
export function listSkills(o: SkillRegistryOptions = {}): SkillSummary[] {
  const { fs, now } = opts(o);
  const roots = resolveSkillRoots(o);
  const key = roots.map((root) => `${root.rank}:${root.root}`).join("|");
  const cached = catalogCache.get(key);
  if (cached && now() - cached.at < CATALOG_TTL_MS) return cached.skills;

  const winners = new Map<string, SkillDefinition>();
  for (const root of [...roots].sort((a, b) => a.rank - b.rank)) {
    for (const skill of scanSkillRoot(root, fs)) {
      if (!winners.has(skill.id)) winners.set(skill.id, skill);
    }
  }
  const skills = Array.from(winners.values())
    .map(toSummary)
    .sort((a, b) => a.id.localeCompare(b.id));
  catalogCache.set(key, { at: now(), skills });
  return skills;
}

/** Full definition; the body is re-read from disk on every call. */
export function getSkill(id: string, o: SkillRegistryOptions = {}): SkillDefinition | undefined {
  const { fs } = opts(o);
  const summary = listSkills(o).find((skill) => skill.id === id);
  if (!summary) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(summary.path, "utf-8");
  } catch {
    invalidateSkillCache();
    return undefined;
  }
  const parsed = parseSkillFile(raw, summary.id, summary.path, summary.dir, { rank: summary.rank, source: summary.source, root: path.dirname(summary.dir) });
  if (!parsed) {
    invalidateSkillCache();
    return undefined;
  }
  return parsed;
}

/**
 * Read a resource file that lives inside a skill's directory (or, for the
 * `_shared`-style sibling convention, inside the same root). Rejects paths
 * that escape the root.
 */
export function readSkillResource(skill: SkillSummary, relative: string, o: SkillRegistryOptions = {}): { path: string; content: string } {
  const { fs } = opts(o);
  const base = path.resolve(skill.dir);
  const rootDir = path.resolve(path.dirname(base));
  const target = path.resolve(base, relative);
  const inside = (parent: string) => target === parent || target.startsWith(parent + path.sep);
  if (!inside(base) && !inside(rootDir)) {
    throw new Error(`resource path escapes the skill directory: ${relative}`);
  }
  if (!isFile(fs, target)) throw new Error(`resource not found: ${relative}`);
  return { path: target, content: fs.readFileSync(target, "utf-8") };
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/** Description as shown in the catalog: single line, clipped. */
export function catalogDescription(description: string, max = CATALOG_DESCRIPTION_MAX_LENGTH): string {
  const single = description.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return single.slice(0, Math.max(3, max - 1)).trimEnd() + "…";
}

/** dsh-compatible rendering returned by the `skill` tool and for user invocation. */
export function renderSkillContent(skill: Pick<SkillDefinition, "id" | "dir" | "content">): string {
  return [
    `<skill_content name="${escapeAttr(skill.id)}">`,
    "<skill_resources>",
    `Base directory for this skill: ${escapeText(skill.dir)}`,
    "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed: call the `skill` tool again with the same name and a `resource` path (for example `references/notes.md` or `scripts/run.py`) to read a file from that directory.",
    "</skill_resources>",
    "",
    "<skill_instructions>",
    skill.content,
    "</skill_instructions>",
    "</skill_content>",
  ].join("\n");
}

export const SKILL_TOOL_NAME = "skill";

/** System-prompt catalog of model-invocable skills. Empty string when none. */
export function buildSkillCatalogSection(skills: SkillSummary[]): string {
  const visible = skills.filter((skill) => skill.modelInvocable);
  if (visible.length === 0) return "";
  const entries = visible.map((skill) => `- \`${skill.id}\`: ${escapeText(catalogDescription(skill.description))}`);
  return [
    "",
    "",
    "## Skills",
    "<available_skills>",
    ...entries,
    "</available_skills>",
    `If the user names a skill, or the task clearly matches a skill's description, call the \`${SKILL_TOOL_NAME}\` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. Skill bodies are not in this prompt until loaded.`,
    "A skill the user invoked directly appears as a <skill_content> block in this conversation; follow it and do not load it again.",
  ].join("\n");
}

/** Section holding explicitly invoked skills (picker selection or `/name`). */
export function buildInvokedSkillsSection(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";
  return "\n\n## Invoked Skills\nThe user invoked these skills for this request. Follow their instructions.\n\n" +
    skills.map(renderSkillContent).join("\n\n");
}

/**
 * `/name` at the start of the first line of a user message is an explicit
 * skill invocation (dsh / Claude Code convention). Returns the names in order.
 */
export function parseInvokedSkillNames(message: string): string[] {
  const firstLine = (message || "").split(/\r?\n/, 1)[0] || "";
  if (!firstLine.startsWith("/")) return [];
  const names: string[] = [];
  for (const token of firstLine.split(/\s+/)) {
    if (!token.startsWith("/")) break;
    const name = token.slice(1);
    if (!SKILL_ID_PATTERN.test(name)) break;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Strip the leading `/name` tokens so the model sees the actual request. */
export function stripInvokedSkillNames(message: string, names: string[]): string {
  if (names.length === 0) return message;
  const lines = (message || "").split(/\r?\n/);
  let first = lines[0] || "";
  for (const name of names) {
    if (first.startsWith(`/${name}`)) first = first.slice(name.length + 1).trimStart();
  }
  lines[0] = first;
  const joined = lines.join("\n").trim();
  return joined || names.map((name) => `Use the ${name} skill.`).join(" ");
}
