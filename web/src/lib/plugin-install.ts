/**
 * Plugin install / remove / toggle (server side, desktop-oriented).
 *
 * `installPlugin` accepts an absolute local directory (linked in place, never
 * copied or deleted) or a git URL (shallow-cloned into
 * `<CHATMOL_HOME>/plugins/<repo>`). A cloned repository may hold several
 * plugins (a `marketplace.json` root); each becomes its own state row that
 * points at the plugin directory and remembers the clone root for removal.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { invalidateAgentCache } from "./agent-registry";
import {
  describePluginDir,
  getInstalledPluginsDir,
  listPlugins,
  loadPluginState,
  pluginKey,
  savePluginState,
  type PluginRecord,
  type PluginState,
  type PluginStateEntry,
} from "./plugins";
import { invalidateSkillCache } from "./skill-registry";

export function isGitSource(source: string): boolean {
  const s = source.trim();
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(s) || /\.git$/i.test(s);
}

function repoNameFromUrl(url: string): string {
  const last = url.replace(/[\/]+$/, "").split(/[\/:]/).pop() || "plugin";
  const name = last.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]/g, "-");
  return name || "plugin";
}

function runGit(args: string[], cwd: string, timeoutMs = 5 * 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    } catch (err) {
      resolve({ code: -1, out: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: -2, out: `${out}\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n${err.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

function invalidateAll(): void {
  invalidateSkillCache();
  invalidateAgentCache();
}

function upsertEntries(state: PluginState, entries: PluginStateEntry[]): PluginState {
  const names = new Set(entries.map((entry) => entry.name));
  return {
    installed: [...state.installed.filter((entry) => !names.has(entry.name)), ...entries],
    disabled: state.disabled.filter((name) => !names.has(name)),
  };
}

export interface InstallResult {
  plugins: PluginRecord[];
  log?: string;
}

/** Install from a git URL or link an existing local directory. */
export async function installPlugin(rawSource: string): Promise<InstallResult> {
  const source = rawSource.trim();
  if (!source) throw new Error("A plugin source (absolute folder path or git URL) is required.");
  const installedAt = new Date().toISOString();

  if (isGitSource(source)) {
    const installedDir = getInstalledPluginsDir();
    fs.mkdirSync(installedDir, { recursive: true });
    const target = path.join(installedDir, repoNameFromUrl(source));
    if (fs.existsSync(target)) {
      throw new Error(`"${path.basename(target)}" is already installed at ${target}. Remove it first to reinstall.`);
    }
    const result = await runGit(["clone", "--depth", "1", source, target], installedDir);
    if (result.code !== 0) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`git clone failed: ${result.out.trim().split("\n").slice(-5).join("\n")}`);
    }
    const records = describePluginDir(target, path.basename(target), "installed").filter((record) => !record.error);
    if (records.length === 0) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error("The repository has no skills/, agents/, .mcp.json or plugin manifest.");
    }
    const entries: PluginStateEntry[] = records.map((record) => ({
      name: record.name,
      source: "git",
      origin: source,
      path: record.dir,
      installRoot: target,
      installedAt,
    }));
    savePluginState(upsertEntries(loadPluginState(), entries));
    invalidateAll();
    return { plugins: records, log: result.out.slice(-2000) };
  }

  const dir = path.resolve(source);
  if (!path.isAbsolute(source)) throw new Error("Local plugin paths must be absolute.");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  const records = describePluginDir(dir, path.basename(dir), "linked").filter((record) => !record.error);
  if (records.length === 0) {
    throw new Error("The folder has no skills/, agents/, .mcp.json or plugin manifest (plugin.json, .claude-plugin/plugin.json, .codex-plugin/plugin.json, marketplace.json).");
  }
  const entries: PluginStateEntry[] = records.map((record) => ({
    name: record.name,
    source: "local",
    origin: dir,
    path: record.dir,
    installedAt,
  }));
  savePluginState(upsertEntries(loadPluginState(), entries));
  invalidateAll();
  return { plugins: records };
}

function nameFromKey(key: string): string {
  const idx = key.indexOf(":");
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/** Forget an installed plugin (by key or name); a git clone we own is deleted from disk. */
export function removePlugin(keyOrName: string): void {
  if (keyOrName.startsWith("bundled:")) throw new Error(`"${nameFromKey(keyOrName)}" is bundled with the app; disable it instead of removing it.`);
  const name = nameFromKey(keyOrName);
  const state = loadPluginState();
  const entry = state.installed.find((item) => item.name === name);
  if (!entry) throw new Error(`Unknown installed plugin "${name}".`);
  const remaining = state.installed.filter((item) => item.name !== name);
  const installedDir = path.resolve(getInstalledPluginsDir());
  if (entry.source === "git" && entry.installRoot) {
    const root = path.resolve(entry.installRoot);
    const stillUsed = remaining.some((item) => item.installRoot && path.resolve(item.installRoot) === root);
    const insideInstalledDir = root.startsWith(installedDir + path.sep);
    if (!stillUsed && insideInstalledDir) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  const key = pluginKey(name, "installed");
  savePluginState({ installed: remaining, disabled: state.disabled.filter((item) => item !== key) });
  invalidateAll();
}

/** Toggle by key (`bundled:<name>` / `installed:<name>`); a bare name means every source. */
export function setPluginEnabled(keyOrName: string, enabled: boolean): void {
  const plugins = listPlugins();
  const matches = plugins.filter((plugin) => plugin.key === keyOrName || plugin.name === keyOrName);
  if (matches.length === 0) throw new Error(`Unknown plugin "${keyOrName}".`);
  const keys = new Set(matches.map((plugin) => plugin.key));
  const names = new Set(matches.map((plugin) => plugin.name));
  const state = loadPluginState();
  const disabled = state.disabled.filter((item) => !keys.has(item) && !names.has(item));
  if (!enabled) disabled.push(...keys);
  savePluginState({ ...state, disabled });
  invalidateAll();
}
