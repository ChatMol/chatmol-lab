/**
 * Plugin discovery for ChatMol Lab.
 *
 * A plugin is a directory that bundles any of `skills/` (Agent Skills,
 * `<name>/SKILL.md`), `agents/` (subagent definitions, `<name>.md`) and
 * `.mcp.json` (MCP servers). The layout is the one Claude Code and Codex
 * plugins use, so a plugin written for those harnesses loads here unchanged
 * and vice versa. A directory holding a `marketplace.json` (the ChatMol-Skills
 * repository layout) expands to the plugins it lists.
 *
 * Two sources:
 *   - bundled:   `<repo>/plugins/*` in development, `process.resourcesPath/plugins`
 *                in the packaged desktop app (`CHATMOL_BUNDLED_PLUGINS_DIR`).
 *   - installed: rows in `<CHATMOL_HOME>/plugins.json`, either cloned into
 *                `<CHATMOL_HOME>/plugins/<name>` or linked to a local folder.
 *
 * Everything here is synchronous and side-effect free apart from the state
 * file helpers, and takes an injectable fs/env/homedir so it is unit-testable.
 */
import * as fsImpl from "fs";
import * as os from "os";
import * as path from "path";

export type PluginSource = "bundled" | "installed" | "linked";

export interface PluginMcpServer {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PluginRecord {
  /** Stable identity: `<bundled|installed>:<name>` (names may repeat across sources). */
  key: string;
  name: string;
  version?: string;
  description?: string;
  /** Absolute plugin directory. */
  dir: string;
  source: PluginSource;
  /** Git URL or local path the plugin was installed from. */
  origin?: string;
  enabled: boolean;
  skillsDir?: string;
  agentsDir?: string;
  mcpServers: PluginMcpServer[];
  error?: string;
}

export interface PluginStateEntry {
  name: string;
  source: "git" | "local";
  origin: string;
  /** The plugin directory itself (may sit inside a cloned marketplace repo). */
  path: string;
  /** For git installs: the clone root that `removePlugin` deletes. */
  installRoot?: string;
  installedAt: string;
}

export interface PluginState {
  installed: PluginStateEntry[];
  /** Plugin names (bundled or installed) the user switched off. */
  disabled: string[];
}

export interface PluginStatLike {
  isDirectory: () => boolean;
  isFile: () => boolean;
}

export interface PluginFsLike {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: "utf-8") => string;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => PluginStatLike;
  writeFileSync?: (p: string, data: string, encoding: "utf-8") => void;
  mkdirSync?: (p: string, opts: { recursive: boolean }) => unknown;
}

type EnvLike = Record<string, string | undefined>;

export interface PluginResolveOptions {
  env?: EnvLike;
  cwd?: string;
  homedir?: string;
  fs?: PluginFsLike;
}

function opts(o: PluginResolveOptions) {
  return {
    env: o.env ?? process.env,
    cwd: o.cwd ?? process.cwd(),
    homedir: o.homedir ?? os.homedir(),
    fs: o.fs ?? (fsImpl as unknown as PluginFsLike),
  };
}

export const MANIFEST_CANDIDATES = [
  "plugin.json",
  ".chatmol-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
];

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

function readJson(fs: PluginFsLike, p: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** `CHATMOL_HOME`, else `~/.chatmol-lab` (the directory the desktop app owns). */
export function getChatmolHome(o: PluginResolveOptions = {}): string {
  const { env, homedir } = opts(o);
  const fromEnv = env.CHATMOL_HOME?.trim();
  return fromEnv ? fromEnv : path.join(homedir, ".chatmol-lab");
}

/** Directory holding the plugins shipped with the app, or null when absent. */
export function resolveBundledPluginsDir(o: PluginResolveOptions = {}): string | null {
  const { env, cwd, fs } = opts(o);
  const fromEnv = env.CHATMOL_BUNDLED_PLUGINS_DIR?.trim();
  if (fromEnv && isDir(fs, fromEnv)) return fromEnv;
  for (const candidate of [path.join(cwd, "plugins"), path.join(cwd, "..", "plugins")]) {
    if (isDir(fs, candidate)) return path.normalize(candidate);
  }
  return null;
}

export function getPluginStatePath(o: PluginResolveOptions = {}): string {
  return path.join(getChatmolHome(o), "plugins.json");
}

export function getInstalledPluginsDir(o: PluginResolveOptions = {}): string {
  return path.join(getChatmolHome(o), "plugins");
}

export function loadPluginState(o: PluginResolveOptions = {}): PluginState {
  const { fs } = opts(o);
  const statePath = getPluginStatePath(o);
  if (!isFile(fs, statePath)) return { installed: [], disabled: [] };
  const raw = readJson(fs, statePath);
  if (!raw) return { installed: [], disabled: [] };
  const installed: PluginStateEntry[] = [];
  if (Array.isArray(raw.installed)) {
    for (const item of raw.installed) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      const dir = typeof entry.path === "string" ? entry.path.trim() : "";
      if (!name || !dir) continue;
      installed.push({
        name,
        source: entry.source === "git" ? "git" : "local",
        origin: typeof entry.origin === "string" ? entry.origin : dir,
        path: dir,
        ...(typeof entry.installRoot === "string" && entry.installRoot.trim() ? { installRoot: entry.installRoot.trim() } : {}),
        installedAt: typeof entry.installedAt === "string" ? entry.installedAt : "",
      });
    }
  }
  const disabled = Array.isArray(raw.disabled)
    ? raw.disabled.filter((value): value is string => typeof value === "string" && value.trim() !== "")
    : [];
  return { installed, disabled };
}

export function savePluginState(state: PluginState, o: PluginResolveOptions = {}): void {
  const { fs } = opts(o);
  const statePath = getPluginStatePath(o);
  if (!fs.writeFileSync || !fs.mkdirSync) throw new Error("plugin state fs has no write support");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  skills?: string;
  agents?: string;
  mcpServers?: string | Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** First manifest found among the Claude Code / Codex / ChatMol locations. */
export function readPluginManifest(dir: string, o: PluginResolveOptions = {}): PluginManifest | null {
  const { fs } = opts(o);
  for (const rel of MANIFEST_CANDIDATES) {
    const p = path.join(dir, rel);
    if (!isFile(fs, p)) continue;
    const raw = readJson(fs, p);
    if (!raw) return null;
    const skills = Array.isArray(raw.skills) ? undefined : stringField(raw, "skills");
    const agents = Array.isArray(raw.agents) ? undefined : stringField(raw, "agents");
    const mcpServers = raw.mcpServers && typeof raw.mcpServers === "object" && !Array.isArray(raw.mcpServers)
      ? raw.mcpServers as Record<string, unknown>
      : stringField(raw, "mcpServers");
    return {
      name: stringField(raw, "name"),
      version: stringField(raw, "version"),
      description: stringField(raw, "description"),
      skills,
      agents,
      mcpServers,
    };
  }
  return null;
}

const PLUGIN_ROOT_VARS = ["${CLAUDE_PLUGIN_ROOT}", "${CHATMOL_PLUGIN_ROOT}"];

function expandPluginRoot(value: string, dir: string): string {
  let out = value;
  for (const token of PLUGIN_ROOT_VARS) out = out.split(token).join(dir);
  return out;
}

/** Parse a `.mcp.json`-style `{ mcpServers: { id: { command, args, env } } }` object. */
export function parseMcpServersObject(raw: Record<string, unknown>, dir: string): PluginMcpServer[] {
  const servers: PluginMcpServer[] = [];
  const table = raw.mcpServers && typeof raw.mcpServers === "object" && !Array.isArray(raw.mcpServers)
    ? raw.mcpServers as Record<string, unknown>
    : raw;
  for (const [id, value] of Object.entries(table)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const command = typeof record.command === "string" ? record.command.trim() : "";
    if (!id.trim() || !command) continue;
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === "string").map((arg) => expandPluginRoot(arg, dir))
      : [];
    const env = record.env && typeof record.env === "object" && !Array.isArray(record.env)
      ? Object.fromEntries(
        Object.entries(record.env as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([key, val]) => [key, expandPluginRoot(val, dir)]),
      )
      : {};
    servers.push({
      id: id.trim(),
      command: expandPluginRoot(command, dir),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
  }
  return servers;
}

function readMcpServers(dir: string, manifest: PluginManifest | null, fs: PluginFsLike): PluginMcpServer[] {
  if (manifest?.mcpServers && typeof manifest.mcpServers === "object") {
    return parseMcpServersObject(manifest.mcpServers, dir);
  }
  const rel = typeof manifest?.mcpServers === "string" ? manifest.mcpServers : ".mcp.json";
  const p = path.resolve(dir, rel);
  if (!isFile(fs, p)) return [];
  const raw = readJson(fs, p);
  return raw ? parseMcpServersObject(raw, dir) : [];
}

/**
 * Describe one plugin directory. Returns an empty list when the directory
 * contributes nothing; a `marketplace.json` expands to its listed plugins.
 */
export function describePluginDir(
  dir: string,
  fallbackName: string,
  source: PluginSource,
  o: PluginResolveOptions = {},
): PluginRecord[] {
  const { fs } = opts(o);
  const keyOf = (name: string) => pluginKey(name, source);
  if (!isDir(fs, dir)) {
    return [{ key: keyOf(fallbackName), name: fallbackName, dir, source, enabled: true, mcpServers: [], error: "directory not found" }];
  }

  const marketplacePath = path.join(dir, "marketplace.json");
  if (isFile(fs, marketplacePath)) {
    const market = readJson(fs, marketplacePath);
    const entries = Array.isArray(market?.plugins) ? market!.plugins : [];
    const records: PluginRecord[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const name = stringField(record, "name");
      const src = record.source && typeof record.source === "object" ? record.source as Record<string, unknown> : null;
      const relPath = src ? stringField(src, "path") : undefined;
      if (!name || !relPath) continue;
      records.push(...describePluginDir(path.resolve(dir, relPath), name, source, o));
    }
    if (records.length > 0) return records;
    return [{ key: keyOf(fallbackName), name: fallbackName, dir, source, enabled: true, mcpServers: [], error: "marketplace.json lists no local plugins" }];
  }

  const manifest = readPluginManifest(dir, o);
  const skillsDir = path.resolve(dir, manifest?.skills ?? "skills");
  const agentsDir = path.resolve(dir, manifest?.agents ?? "agents");
  const mcpServers = readMcpServers(dir, manifest, fs);
  const hasSkills = isDir(fs, skillsDir);
  const hasAgents = isDir(fs, agentsDir);
  if (!manifest && !hasSkills && !hasAgents && mcpServers.length === 0) return [];

  const name = manifest?.name || fallbackName;
  return [{
    key: keyOf(name),
    name,
    ...(manifest?.version ? { version: manifest.version } : {}),
    ...(manifest?.description ? { description: manifest.description } : {}),
    dir,
    source,
    enabled: true,
    ...(hasSkills ? { skillsDir } : {}),
    ...(hasAgents ? { agentsDir } : {}),
    mcpServers,
  }];
}

/** Every child directory of a plugins root, described. */
export function expandPluginsRoot(rootDir: string, source: PluginSource, o: PluginResolveOptions = {}): PluginRecord[] {
  const { fs } = opts(o);
  if (!isDir(fs, rootDir)) return [];
  let children: string[] = [];
  try {
    children = fs.readdirSync(rootDir);
  } catch {
    return [];
  }
  const records: PluginRecord[] = [];
  for (const child of children.sort()) {
    if (child.startsWith(".") || child.startsWith("_")) continue;
    const dir = path.join(rootDir, child);
    if (!isDir(fs, dir)) continue;
    records.push(...describePluginDir(dir, child, source, o));
  }
  return records;
}

/** `bundled:<name>` for shipped plugins, `installed:<name>` for user installs. */
export function pluginKey(name: string, source: PluginSource): string {
  return `${source === "bundled" ? "bundled" : "installed"}:${name}`;
}

function isDisabled(record: PluginRecord, disabled: Set<string>): boolean {
  // A bare name in the state file (older format) disables every source.
  return disabled.has(record.key) || disabled.has(record.name);
}

/**
 * All known plugins: installed rows first, then bundled. A bundled and an
 * installed plugin may share a name (the ChatMol-Skills repository also calls
 * its plugin "chatmol"); both are listed and the skill / agent registries
 * resolve duplicate ids by rank (installed before bundled). `enabled`
 * reflects the state file.
 */
export function listPlugins(o: PluginResolveOptions = {}): PluginRecord[] {
  const state = loadPluginState(o);
  const disabled = new Set(state.disabled);
  const seen = new Set<string>();
  const out: PluginRecord[] = [];

  for (const entry of state.installed) {
    const source: PluginSource = entry.source === "git" ? "installed" : "linked";
    for (const record of describePluginDir(entry.path, entry.name, source, o)) {
      if (seen.has(record.key)) continue;
      seen.add(record.key);
      out.push({ ...record, origin: entry.origin, enabled: !isDisabled(record, disabled) });
    }
  }

  const bundledRoot = resolveBundledPluginsDir(o);
  if (bundledRoot) {
    for (const record of expandPluginsRoot(bundledRoot, "bundled", o)) {
      if (seen.has(record.key)) continue;
      seen.add(record.key);
      out.push({ ...record, enabled: !isDisabled(record, disabled) });
    }
  }
  return out;
}

export function listEnabledPlugins(o: PluginResolveOptions = {}): PluginRecord[] {
  return listPlugins(o).filter((plugin) => plugin.enabled && !plugin.error);
}

/** Settings-style MCP server rows contributed by enabled plugins (`<plugin>-<id>`). */
export function pluginMcpServerConfigs(o: PluginResolveOptions = {}): Array<PluginMcpServer & { name: string; plugin: string }> {
  const rows: Array<PluginMcpServer & { name: string; plugin: string }> = [];
  for (const plugin of listEnabledPlugins(o)) {
    for (const server of plugin.mcpServers) {
      rows.push({
        ...server,
        id: `${plugin.name}-${server.id}`,
        name: `${server.id} (${plugin.name})`,
        plugin: plugin.name,
      });
    }
  }
  return rows;
}
