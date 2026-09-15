/**
 * Subagent definitions as files (`agents/<name>.md`, Claude Code layout).
 *
 * ```markdown
 * ---
 * name: wemol-docs
 * description: When to delegate to this agent (shown to the main agent).
 * tools: wemol_cli, read_file      # comma list or "*" (default: "*")
 * model: main                      # main | fast | <exact model id>
 * skills: wemol-cli                # skills whose bodies are preloaded
 * ---
 * Persona / instructions for the subagent.
 * ```
 *
 * Roots (rank order, lowest wins duplicates): workspace `.chatmol/agents`,
 * workspace `.claude/agents`, `<CHATMOL_HOME>/agents`, `~/.claude/agents`,
 * then `agents/` of every enabled plugin (installed before bundled).
 * Runtime built-ins (`./builtin-agents`) come first and cannot be shadowed.
 */
import * as fsImpl from "fs";
import * as os from "os";
import * as path from "path";
import matter from "gray-matter";

import { getChatmolHome, listEnabledPlugins, type PluginFsLike, type PluginRecord } from "./plugins";
import { BUILTIN_AGENTS } from "./builtin-agents";
import { ALL_TOOLS_SENTINEL } from "./subagent-defaults";

export interface AgentRoot {
  rank: number;
  source: string;
  root: string;
}

export interface AgentDefinition {
  /** File name without `.md`; the id used by run_subagent. */
  id: string;
  name: string;
  description: string;
  /** Persona / instructions (markdown body). */
  prompt: string;
  /** Allowed tool names, or `["*"]` for everything except plan control and recursion. */
  toolNames: string[];
  /** `main` (default), `fast`, or an exact model id. */
  model: string;
  /** Skills preloaded into the subagent prompt. */
  skills: string[];
  source: string;
  rank: number;
  path: string;
}

type EnvLike = Record<string, string | undefined>;

export interface AgentRegistryOptions {
  cwd?: string;
  env?: EnvLike;
  homedir?: string;
  fs?: PluginFsLike;
  plugins?: PluginRecord[];
  now?: () => number;
}

export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const CATALOG_TTL_MS = 5_000;

function opts(o: AgentRegistryOptions) {
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

export function resolveAgentRoots(o: AgentRegistryOptions = {}): AgentRoot[] {
  const { env, homedir, fs } = opts(o);
  const roots: AgentRoot[] = [];
  if (o.cwd) {
    roots.push({ rank: 100, source: "project-chatmol", root: path.join(o.cwd, ".chatmol", "agents") });
    roots.push({ rank: 200, source: "project-claude", root: path.join(o.cwd, ".claude", "agents") });
  }
  roots.push({ rank: 400, source: "user-chatmol", root: path.join(getChatmolHome({ env, homedir, fs }), "agents") });
  roots.push({ rank: 500, source: "user-claude", root: path.join(homedir, ".claude", "agents") });
  const plugins = o.plugins ?? listEnabledPlugins({ env, homedir, fs });
  plugins.forEach((plugin, index) => {
    if (plugin.agentsDir) roots.push({ rank: 600 + index, source: `plugin:${plugin.key}`, root: plugin.agentsDir });
  });
  return roots;
}

function listField(data: Record<string, unknown>, key: string): string[] | undefined {
  const value = data[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  return undefined;
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Parse one `agents/<id>.md`. Returns null (after a console warning) when unusable. */
export function parseAgentFile(raw: string, id: string, filePath: string, root: AgentRoot): AgentDefinition | null {
  let data: Record<string, unknown>;
  let content: string;
  try {
    const parsed = matter(raw);
    data = (parsed.data || {}) as Record<string, unknown>;
    content = parsed.content;
  } catch (err) {
    console.warn(`[agents] ${filePath} ignored: invalid YAML frontmatter (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  const description = stringField(data, "description");
  if (!description) {
    console.warn(`[agents] ${filePath} ignored: frontmatter requires a description`);
    return null;
  }
  const tools = listField(data, "tools");
  const toolNames = !tools || tools.length === 0 || tools.includes(ALL_TOOLS_SENTINEL)
    ? [ALL_TOOLS_SENTINEL]
    : Array.from(new Set(tools));
  return {
    id,
    name: stringField(data, "name") || id,
    description,
    prompt: content.trim(),
    toolNames,
    model: stringField(data, "model") || "main",
    skills: listField(data, "skills") || [],
    source: root.source,
    rank: root.rank,
    path: filePath,
  };
}

export function scanAgentRoot(root: AgentRoot, fs: PluginFsLike): AgentDefinition[] {
  if (!isDir(fs, root.root)) return [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root.root);
  } catch {
    return [];
  }
  const agents: AgentDefinition[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || entry.startsWith("_") || !entry.toLowerCase().endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    const filePath = path.join(root.root, entry);
    if (!AGENT_ID_PATTERN.test(id) || !isFile(fs, filePath)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const agent = parseAgentFile(raw, id, filePath, root);
    if (agent) agents.push(agent);
  }
  return agents;
}

let cache: Map<string, { at: number; agents: AgentDefinition[] }> = new Map();

export function invalidateAgentCache(): void {
  cache = new Map();
}

/**
 * Every available agent: runtime built-ins first, then file-defined agents
 * (nearest root wins duplicates), sorted by id. A file reusing a built-in id
 * is ignored with a warning.
 */
export function listAgents(o: AgentRegistryOptions = {}): AgentDefinition[] {
  const { fs, now } = opts(o);
  const roots = resolveAgentRoots(o);
  const key = roots.map((root) => `${root.rank}:${root.root}`).join("|");
  const cached = cache.get(key);
  if (cached && now() - cached.at < CATALOG_TTL_MS) return cached.agents;

  const winners = new Map<string, AgentDefinition>();
  for (const agent of BUILTIN_AGENTS) winners.set(agent.id, agent);
  for (const root of [...roots].sort((a, b) => a.rank - b.rank)) {
    for (const agent of scanAgentRoot(root, fs)) {
      if (BUILTIN_AGENTS.some((builtin) => builtin.id === agent.id)) {
        console.warn(`[agents] ${agent.path} ignored: "${agent.id}" is a built-in runtime agent`);
        continue;
      }
      if (!winners.has(agent.id)) winners.set(agent.id, agent);
    }
  }
  const agents = Array.from(winners.values()).sort((a, b) => a.id.localeCompare(b.id));
  cache.set(key, { at: now(), agents });
  return agents;
}

export function getAgent(id: string, o: AgentRegistryOptions = {}): AgentDefinition | undefined {
  return listAgents(o).find((agent) => agent.id === id);
}
