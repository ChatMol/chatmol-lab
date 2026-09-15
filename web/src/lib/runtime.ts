import * as fs from "fs";
import * as path from "path";

export type RuntimeBackend = "native" | "wsl" | "system";

export interface RuntimeComponentStatus {
  path?: string;
  exists: boolean;
}

export interface NativeRuntimeStatus {
  prefix?: string;
  condaRoot?: string;
  binDirs: string[];
  pathPrepend: string;
  conda: RuntimeComponentStatus;
  python: RuntimeComponentStatus;
  wemolCli: RuntimeComponentStatus;
  ready: boolean;
}

export interface WslRuntimeStatus {
  ready: boolean;
  prefix: string;
  binDirs: string[];
  pathPrepend: string;
}

export interface RuntimeStatus {
  isElectron: boolean;
  platform: NodeJS.Platform;
  activeBackend: RuntimeBackend;
  pathDelimiter: string;
  native: NativeRuntimeStatus;
  wsl: WslRuntimeStatus;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_WSL_PREFIX = "$HOME/.chatmol/miniforge";

function splitPathList(value: string | undefined, delimiter: string): string[] {
  return (value || "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function exists(filePath: string | undefined): boolean {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function pathForPlatform(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function nativeBinDirsFromPrefix(prefix: string | undefined, platform: NodeJS.Platform): string[] {
  if (!prefix) return [];
  const pathImpl = pathForPlatform(platform);
  return platform === "win32"
    ? [prefix, pathImpl.join(prefix, "Scripts"), pathImpl.join(prefix, "Library", "bin")]
    : [pathImpl.join(prefix, "bin")];
}

function inferPrefixFromBinDirs(binDirs: string[], platform: NodeJS.Platform): string | undefined {
  const first = binDirs[0];
  if (!first) return undefined;
  const pathImpl = pathForPlatform(platform);
  if (platform === "win32") {
    const base = pathImpl.basename(first).toLowerCase();
    const parent = pathImpl.dirname(first);
    if (base === "scripts") return parent;
    if (base === "bin" && pathImpl.basename(parent).toLowerCase() === "library") {
      return pathImpl.dirname(parent);
    }
    if (base === "bin") return parent;
    if (base === "library") return parent;
    return first;
  }
  return pathImpl.basename(first) === "bin" ? pathImpl.dirname(first) : first;
}

export function getRuntimeStatus(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): RuntimeStatus {
  const delimiter = platform === "win32" ? ";" : ":";
  const configuredBinDirs = splitPathList(env.CHATMOL_CONDA_BIN, delimiter);
  const prefix = env.CHATMOL_CONDA_PREFIX || inferPrefixFromBinDirs(configuredBinDirs, platform);
  const condaRoot = env.CHATMOL_CONDA_ROOT || prefix;
  const binDirs = configuredBinDirs.length > 0 ? configuredBinDirs : nativeBinDirsFromPrefix(prefix, platform);
  const pathImpl = pathForPlatform(platform);
  const condaPath = platform === "win32"
    ? (condaRoot ? pathImpl.join(condaRoot, "Scripts", "conda.exe") : undefined)
    : (condaRoot ? pathImpl.join(condaRoot, "bin", "conda") : undefined);
  const pythonPath = platform === "win32"
    ? (prefix ? pathImpl.join(prefix, "python.exe") : undefined)
    : (prefix ? pathImpl.join(prefix, "bin", "python") : undefined);
  const wemolCliPath = env.CHATMOL_WEMOL_CLI || (
    platform === "win32"
      ? (prefix ? pathImpl.join(prefix, "Scripts", "wemol-cli.exe") : undefined)
      : (prefix ? pathImpl.join(prefix, "bin", "wemol-cli") : undefined)
  );

  const native: NativeRuntimeStatus = {
    prefix,
    condaRoot,
    binDirs,
    pathPrepend: binDirs.join(delimiter),
    conda: { path: condaPath, exists: exists(condaPath) },
    python: { path: pythonPath, exists: exists(pythonPath) },
    wemolCli: { path: wemolCliPath, exists: exists(wemolCliPath) },
    ready: exists(condaPath) && exists(pythonPath) && exists(wemolCliPath),
  };

  const wslPrefix = env.CHATMOL_WSL_CONDA_PREFIX || DEFAULT_WSL_PREFIX;
  const wslBinDirs = splitPathList(env.CHATMOL_WSL_CONDA_BIN, ":");
  const normalizedWslBinDirs = wslBinDirs.length > 0
    ? wslBinDirs
    : [`${wslPrefix}/bin`, `${wslPrefix}/condabin`];
  const wsl: WslRuntimeStatus = {
    ready: env.CHATMOL_WSL_READY === "1",
    prefix: wslPrefix,
    binDirs: normalizedWslBinDirs,
    pathPrepend: normalizedWslBinDirs.join(":"),
  };

  const activeBackend: RuntimeBackend = platform === "win32" && wsl.ready
    ? "wsl"
    : native.ready
      ? "native"
      : "system";

  return {
    isElectron: env.IS_ELECTRON === "true" || env.NEXT_PUBLIC_IS_ELECTRON === "true",
    platform,
    activeBackend,
    pathDelimiter: delimiter,
    native,
    wsl,
  };
}

export function getDefaultRuntimeShellPath(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return getRuntimeStatus(env, platform).native.pathPrepend;
}

export function windowsPathToWsl(filePath: string): string {
  const m = filePath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return filePath.replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

function expandWslHomeForShell(value: string): string {
  return value.replace(/^~(?=\/|$)/, "$HOME");
}

export function getWslRuntimePrelude(env: EnvLike = process.env): string {
  const status = getRuntimeStatus(env, "win32");
  const prefix = expandWslHomeForShell(status.wsl.prefix);
  const binDirs = status.wsl.binDirs.map(expandWslHomeForShell);
  return [
    `export CHATMOL_CONDA_PREFIX="${prefix}"`,
    `export CONDA_PREFIX="${prefix}"`,
    `export PATH="${binDirs.join(":")}:$PATH"`,
  ].join("; ");
}

/**
 * PATH for tool subprocesses: the bundled runtime's bin dirs always come
 * first, then the user's extra dirs, then the inherited PATH — deduplicated
 * in that order. This is what makes `python` resolve to the bundled
 * Miniforge env even when the user has their own conda on PATH.
 */
export function composeShellPath(params: {
  runtimeBinDirs: string[];
  extra?: string;
  base?: string;
  delimiter: string;
}): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (dir: string) => {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  for (const dir of params.runtimeBinDirs) push(dir);
  for (const dir of (params.extra || "").split(params.delimiter)) push(dir);
  for (const dir of (params.base || "").split(params.delimiter)) push(dir);
  return out.join(params.delimiter);
}

/**
 * Environment additions that pin subprocesses to the bundled runtime:
 * PATH order, CONDA_PREFIX/DEFAULT_ENV so conda-aware tools agree, no user
 * site-packages leaking in from ~/.local, and CHATMOL_PYTHON for scripts.
 */
export function getRuntimeSubprocessEnv(
  extraPath: string,
  basePath: string,
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const status = getRuntimeStatus(env, platform);
  const delimiter = status.pathDelimiter;
  const runtimeDirs = status.native.ready || status.native.binDirs.length > 0 ? status.native.binDirs : [];
  const result: Record<string, string> = {
    PATH: composeShellPath({ runtimeBinDirs: runtimeDirs, extra: extraPath, base: basePath, delimiter }),
    PYTHONNOUSERSITE: "1",
  };
  if (status.native.prefix) {
    result.CONDA_PREFIX = status.native.prefix;
    result.CONDA_DEFAULT_ENV = "base";
  }
  if (status.native.python.path) {
    result.CHATMOL_PYTHON = status.native.python.path;
  }
  return result;
}
