/**
 * Built-in MCP server presets for desktop molecular viewers.
 *
 * The servers themselves are the Python scripts under web/mcp-servers/
 * (derived from ChatMol/molecule-mcp). A preset entry in settings only
 * carries `{ id, preset, enabled }`; the launch command is resolved here at
 * spawn time from the bundled scientific runtime, so users never edit paths.
 */
import * as fsImpl from "fs";
import * as os from "os";
import * as path from "path";

export type McpPresetId = "pymol" | "chimerax";

export interface McpPreset {
  id: McpPresetId;
  label: string;
  description: string;
  /** Script file name under the mcp-servers directory. */
  script: string;
  /** Env var that overrides viewer binary discovery. */
  binEnvVar: string;
  installHint: string;
  /** One-line guidance injected into the system prompt when enabled. */
  promptHint: string;
}

export const MCP_PRESETS: Record<McpPresetId, McpPreset> = {
  pymol: {
    id: "pymol",
    label: "PyMOL",
    description: "Drive a live PyMOL window: load structures, run PyMOL commands, render publication images.",
    script: "pymol_server.py",
    binEnvVar: "CHATMOL_PYMOL_BIN",
    installHint: "Install PyMOL: `conda install -y -c conda-forge pymol-open-source` (or the Schrödinger PyMOL app).",
    promptHint:
      "PyMOL tools (mcp__pymol__*): call open_pymol once, then run_pymol_command with standard PyMOL syntax; " +
      "use load_structure_file for workspace files and save_image to render a PNG into the workspace, then save_artifact that PNG.",
  },
  chimerax: {
    id: "chimerax",
    label: "UCSF ChimeraX",
    description: "Drive a live ChimeraX window: open structures/maps, run ChimeraX commands, save images and sessions.",
    script: "chimerax_server.py",
    binEnvVar: "CHATMOL_CHIMERAX_BIN",
    installHint: "Install UCSF ChimeraX from https://www.cgl.ucsf.edu/chimerax/download.html",
    promptHint:
      "ChimeraX tools (mcp__chimerax__*): call open_chimerax once, then run_chimerax_command with ChimeraX command syntax; " +
      "use load_structure_file for workspace files and save_image to render a PNG into the workspace, then save_artifact that PNG.",
  },
};

export const MCP_PRESET_IDS: McpPresetId[] = ["pymol", "chimerax"];

export function isMcpPresetId(value: unknown): value is McpPresetId {
  return typeof value === "string" && (MCP_PRESET_IDS as string[]).includes(value);
}

type EnvLike = Record<string, string | undefined>;

export interface PresetFsLike {
  existsSync: (p: string) => boolean;
  readdirSync?: (p: string) => string[];
}

export interface PresetResolveOptions {
  env?: EnvLike;
  platform?: NodeJS.Platform;
  cwd?: string;
  homedir?: string;
  fs?: PresetFsLike;
}

function opts(o: PresetResolveOptions) {
  return {
    env: o.env ?? process.env,
    platform: o.platform ?? process.platform,
    cwd: o.cwd ?? process.cwd(),
    homedir: o.homedir ?? os.homedir(),
    fs: o.fs ?? fsImpl,
  };
}

/** Directory holding the bundled MCP server scripts. */
export function resolveMcpServersDir(o: PresetResolveOptions = {}): string | null {
  const { env, cwd, fs } = opts(o);
  const candidates = [
    env.CHATMOL_MCP_SERVERS_DIR,
    path.join(cwd, "mcp-servers"),
    path.join(cwd, "web", "mcp-servers"),
    path.join(cwd, "..", "mcp-servers"),
    path.join(cwd, "..", "web", "mcp-servers"),
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, MCP_PRESETS.pymol.script))) return dir;
  }
  return null;
}

/** Python interpreter for the MCP server process (bundled runtime first). */
export function resolvePresetPython(o: PresetResolveOptions = {}): string | null {
  const { env, platform, fs } = opts(o);
  const candidates: string[] = [];
  if (env.CHATMOL_MCP_PYTHON) candidates.push(env.CHATMOL_MCP_PYTHON);
  const prefix = env.CHATMOL_CONDA_PREFIX;
  if (prefix) {
    candidates.push(platform === "win32" ? path.join(prefix, "python.exe") : path.join(prefix, "bin", "python"));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall back to PATH lookup by name; the spawn will fail loudly if absent.
  return platform === "win32" ? "python" : "python3";
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function globFirst(
  fs: PresetFsLike,
  pathImpl: path.PlatformPath,
  dir: string,
  matcher: (name: string) => boolean,
  rest: string[],
): string | null {
  if (!fs.readdirSync || !fs.existsSync(dir)) return null;
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(matcher).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const full = pathImpl.join(dir, name, ...rest);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** Best-effort discovery of the viewer executable; null when not found. */
export function discoverViewerBinary(id: McpPresetId, o: PresetResolveOptions = {}): string | null {
  const { env, platform, homedir, fs } = opts(o);
  const p = pathFor(platform);
  const override = env[MCP_PRESETS[id].binEnvVar];
  if (override && fs.existsSync(override)) return override;

  const prefix = env.CHATMOL_CONDA_PREFIX;
  if (id === "pymol") {
    const fixed = [
      prefix ? p.join(prefix, "bin", "pymol") : "",
      prefix ? p.join(prefix, "Scripts", "pymol.exe") : "",
      "/usr/local/bin/pymol",
      "/usr/bin/pymol",
      "/opt/homebrew/bin/pymol",
    ].filter(Boolean);
    for (const c of fixed) if (fs.existsSync(c)) return c;
    if (platform === "darwin") {
      return globFirst(fs, p, "/Applications", (n) => /^PyMOL.*\.app$/i.test(n), ["Contents", "MacOS", "PyMOL"])
        || globFirst(fs, p, p.join(homedir, "Applications"), (n) => /^PyMOL.*\.app$/i.test(n), ["Contents", "MacOS", "PyMOL"]);
    }
    if (platform === "win32") {
      const roots = [env.ProgramFiles || "C:\\Program Files", env.LOCALAPPDATA || ""].filter(Boolean);
      for (const root of roots) {
        const hit = globFirst(fs, p, p.join(root, "Schrodinger"), (n) => /^PyMOL/i.test(n), ["PyMOLWin.exe"])
          || globFirst(fs, p, root, (n) => /^PyMOL/i.test(n), ["PyMOLWin.exe"]);
        if (hit) return hit;
      }
    }
    return null;
  }

  // chimerax
  const fixed = ["/usr/bin/chimerax", "/usr/local/bin/chimerax"];
  for (const c of fixed) if (fs.existsSync(c)) return c;
  if (platform === "darwin") {
    return globFirst(fs, p, "/Applications", (n) => /^ChimeraX.*\.app$/i.test(n), ["Contents", "bin", "ChimeraX"])
      || globFirst(fs, p, p.join(homedir, "Applications"), (n) => /^ChimeraX.*\.app$/i.test(n), ["Contents", "bin", "ChimeraX"]);
  }
  if (platform === "win32") {
    const roots = [env.ProgramFiles || "C:\\Program Files", env.LOCALAPPDATA || ""].filter(Boolean);
    for (const root of roots) {
      const hit = globFirst(fs, p, root, (n) => /^ChimeraX/i.test(n), ["bin", "ChimeraX.exe"]);
      if (hit) return hit;
    }
    return null;
  }
  return globFirst(fs, p, "/opt/UCSF", (n) => /^ChimeraX/i.test(n), ["bin", "ChimeraX"]);
}

export interface PresetLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Spawn spec for a preset server, or an error string explaining what is missing. */
export function resolvePresetLaunch(
  id: McpPresetId,
  workspace: string,
  o: PresetResolveOptions = {},
): { launch: PresetLaunch } | { error: string } {
  const preset = MCP_PRESETS[id];
  const dir = resolveMcpServersDir(o);
  if (!dir) return { error: "Bundled MCP server scripts were not found (mcp-servers directory)." };
  const python = resolvePresetPython(o);
  if (!python) return { error: "No Python interpreter available for the MCP server." };
  const bin = discoverViewerBinary(id, o);
  const env: Record<string, string> = {
    CHATMOL_MCP_WORKSPACE: workspace,
    PYTHONUNBUFFERED: "1",
  };
  if (bin) env[preset.binEnvVar] = bin;
  return {
    launch: {
      command: python,
      args: [path.join(dir, preset.script)],
      env,
    },
  };
}

export interface McpPresetStatus {
  id: McpPresetId;
  label: string;
  description: string;
  enabled: boolean;
  scriptPath: string | null;
  python: string | null;
  viewerPath: string | null;
  /** Whether `import mcp` succeeds in the resolved python (null = unknown). */
  mcpModule: boolean | null;
  ready: boolean;
  hints: string[];
}

export function describePresetStatus(
  id: McpPresetId,
  enabled: boolean,
  mcpModule: boolean | null,
  o: PresetResolveOptions = {},
): McpPresetStatus {
  const preset = MCP_PRESETS[id];
  const dir = resolveMcpServersDir(o);
  const python = resolvePresetPython(o);
  const viewerPath = discoverViewerBinary(id, o);
  const hints: string[] = [];
  if (!dir) hints.push("Bundled MCP server scripts not found.");
  if (mcpModule === false) hints.push("Python package `mcp` (v1, <2) is missing or incompatible. Use “Install Python MCP package”.");
  if (!viewerPath) hints.push(`${preset.label} was not found automatically. ${preset.installHint} Or set ${preset.binEnvVar}.`);
  return {
    id,
    label: preset.label,
    description: preset.description,
    enabled,
    scriptPath: dir ? path.join(dir, preset.script) : null,
    python,
    viewerPath,
    mcpModule,
    ready: Boolean(dir && python && viewerPath && mcpModule !== false),
    hints,
  };
}
