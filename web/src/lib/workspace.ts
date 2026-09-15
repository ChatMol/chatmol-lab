import path, { join } from "path";
import { existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/tmp/chatmol-workspace";

export function getWorkspaceRoot(): string {
  return WORKSPACE_DIR;
}

// --- Per-session workspace overrides -----------------------------------------
// A session can be pointed at any folder the user picks ("open a project
// folder"). The mapping lives in <WORKSPACE_DIR>/.workspaces.json so the sync
// getSessionWorkspace() used across the API routes keeps working.

const OVERRIDES_FILE = join(WORKSPACE_DIR, ".workspaces.json");
let overridesCache: { mtimeMs: number; map: Record<string, string> } | null = null;

function readOverrides(): Record<string, string> {
  try {
    if (!existsSync(OVERRIDES_FILE)) {
      overridesCache = null;
      return {};
    }
    const mtimeMs = statSync(OVERRIDES_FILE).mtimeMs;
    if (overridesCache && overridesCache.mtimeMs === mtimeMs) return overridesCache.map;
    const parsed = JSON.parse(readFileSync(OVERRIDES_FILE, "utf-8")) as Record<string, unknown>;
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      if (typeof value === "string" && value) map[key] = value;
    }
    overridesCache = { mtimeMs, map };
    return map;
  } catch {
    return {};
  }
}

function writeOverrides(map: Record<string, string>): void {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  writeFileSync(OVERRIDES_FILE, JSON.stringify(map, null, 2));
  overridesCache = null;
}

function safeSessionKey(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Folder explicitly chosen for this session, or null when using the default. */
export function getSessionWorkspaceOverride(sessionId: string): string | null {
  const value = readOverrides()[safeSessionKey(sessionId)];
  return value && existsSync(value) && statSync(value).isDirectory() ? value : null;
}

/** Point a session at a folder (absolute path) or back to the default (null). */
export function setSessionWorkspaceOverride(sessionId: string, folder: string | null): void {
  const map = { ...readOverrides() };
  const key = safeSessionKey(sessionId);
  if (folder) map[key] = path.resolve(folder);
  else delete map[key];
  writeOverrides(map);
}

export interface SessionWorkspaceInfo {
  sessionId: string | null;
  path: string;
  isCustom: boolean;
  root: string;
  exists: boolean;
}

export function getSessionWorkspaceInfo(sessionId: string | null): SessionWorkspaceInfo {
  const dir = getSessionWorkspace(sessionId, { create: false });
  return {
    sessionId,
    path: dir,
    isCustom: Boolean(sessionId && getSessionWorkspaceOverride(sessionId)),
    root: WORKSPACE_DIR,
    exists: existsSync(dir),
  };
}

/**
 * Resolve `filePath` against `workspace` and verify the result stays inside
 * the workspace directory.  Returns the absolute resolved path, or `null` if
 * the path escapes the workspace (path traversal).
 */
export function safeResolvePath(filePath: string, workspace: string): string | null {
  const resolved = path.resolve(workspace, filePath);
  const normalizedWorkspace = path.resolve(workspace);
  if (resolved !== normalizedWorkspace && !resolved.startsWith(normalizedWorkspace + path.sep)) {
    return null;
  }
  const relativePath = path.relative(normalizedWorkspace, resolved);
  if (relativePath && relativePath.split(path.sep).some((segment) => segment.startsWith("."))) {
    return null;
  }
  // Resolve the workspace itself (macOS /tmp and user-selected folders may
  // be links). For new files, resolve the closest existing ancestor. lstat
  // deliberately sees dangling links, which must fail closed.
  try {
    const root = realpathSync(normalizedWorkspace);
    let ancestor = resolved;
    const missing: string[] = [];
    for (;;) {
      try {
        lstatSync(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (ancestor === normalizedWorkspace) return null;
        missing.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    const real = path.resolve(realpathSync(ancestor), ...missing);
    const relative = path.relative(root, real);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    if (relative.split(path.sep).some((part) => part.startsWith("."))) return null;
    // Return the canonical path so subsequent I/O does not traverse the
    // original link again. This is not a sandbox against concurrent local
    // processes replacing directories; shell execution needs its own sandbox.
    return real;
  } catch {
    return null;
  }
}

export function getSessionWorkspace(
  sessionId: string | null,
  options: { create?: boolean } = {}
): string {
  const { create = true } = options;
  if (!sessionId) return WORKSPACE_DIR;
  const override = getSessionWorkspaceOverride(sessionId);
  if (override) return override;
  const safe = safeSessionKey(sessionId);
  const dir = join(WORKSPACE_DIR, safe);
  if (create) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
  }
  return dir;
}
