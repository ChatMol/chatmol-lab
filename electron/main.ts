import { app, BrowserWindow, dialog, shell, ipcMain } from "electron";
import { spawn, execSync, execFileSync, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import * as net from "net";

const DATA_DIR = process.env.CHATMOL_HOME || path.join(app.getPath("home"), ".chatmol-lab");
const DB_PATH = path.join(DATA_DIR, "chatmol.db");
const SETTINGS_PATH = path.join(DATA_DIR, ".settings.json");
const SECRET_PATH = path.join(DATA_DIR, ".nextauth-secret");
const WORKSPACE_DIR = path.join(DATA_DIR, "workspace");
const DAEMON_STATE_PATH = path.join(DATA_DIR, "daemon.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
const DESKTOP_RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const MAMBAFORGE_ROOT = path.join(DESKTOP_RUNTIME_DIR, "mambaforge");
// Use the Miniforge base env directly as the runtime. The previous
// `conda create --clone` step was fragile (esp. on Windows, where it left a
// broken env with no python), and cloning bought us nothing since we install
// no extra packages into the clone. python/conda now live in one working env.
const CHATMOL_CONDA_ENV = MAMBAFORGE_ROOT;
const RUNTIME_STATE_PATH = path.join(DESKTOP_RUNTIME_DIR, "runtime-state.json");

// --- Platform-specific conda/runtime layout ---
const IS_WIN = process.platform === "win32";
const CONDA_BIN = IS_WIN
  ? path.join(MAMBAFORGE_ROOT, "Scripts", "conda.exe")
  : path.join(MAMBAFORGE_ROOT, "bin", "conda");
const ENV_PYTHON = IS_WIN
  ? path.join(CHATMOL_CONDA_ENV, "python.exe")
  : path.join(CHATMOL_CONDA_ENV, "bin", "python");
const WEMOL_CLI_NAME = IS_WIN ? "wemol-cli.exe" : "wemol-cli";
const WEMOL_CLI_DIR = IS_WIN
  ? path.join(CHATMOL_CONDA_ENV, "Scripts")
  : path.join(CHATMOL_CONDA_ENV, "bin");
const WEMOL_CLI_PATH = path.join(WEMOL_CLI_DIR, WEMOL_CLI_NAME);
// Directories placed on PATH so python/pip/wemol-cli resolve to the bundled env.
const ENV_BIN_DIRS = IS_WIN
  ? [CHATMOL_CONDA_ENV, path.join(CHATMOL_CONDA_ENV, "Scripts"), path.join(CHATMOL_CONDA_ENV, "Library", "bin")]
  : [path.join(CHATMOL_CONDA_ENV, "bin")];
const CONDA_ROOT_BIN_DIRS = IS_WIN
  ? [MAMBAFORGE_ROOT, path.join(MAMBAFORGE_ROOT, "Scripts"), path.join(MAMBAFORGE_ROOT, "Library", "bin")]
  : [path.join(MAMBAFORGE_ROOT, "bin")];

const DEFAULT_DEV_PORT = 3456;
const REMOTE_URL = "https://lab.cloudmol.org";

process.env.CHATMOL_IS_PACKAGED = app.isPackaged ? "true" : "false";

let mainWindow: BrowserWindow | null = null;
let daemonProcess: ChildProcess | null = null;
let currentDaemon: DaemonState | null = null;
let daemonStartupPromise: Promise<DaemonState> | null = null;
let pendingProtocolCode: string | null = null;

type DaemonState = {
  pid: number;
  port: number;
  token: string;
  version: string;
  startedAt: string;
  appPath: string;
};

type RuntimeManifest = {
  schemaVersion: number;
  platform: string;
  conda?: {
    envName?: string;
    installer?: {
      fileName?: string;
      version?: string;
      sha256?: string;
    };
  };
  wemolCli?: {
    executable?: string;
    archive?: {
      fileName?: string;
      version?: string;
      sha256?: string;
    };
  };
  wslConda?: {
    distribution?: string;
    prefix?: string;
    installer?: {
      fileName?: string;
      version?: string;
      sha256?: string;
    };
  };
};

type RuntimeState = {
  schemaVersion: number;
  condaVersion?: string;
  wemolCliVersion?: string;
  condaRoot: string;
  envPrefix: string;
  wemolCliPath: string;
  bootstrappedAt: string;
};

// Register chatmol:// protocol for OAuth callback in packaged builds only.
// Development Electron apps all share the generic com.github.electron bundle id,
// so macOS can dispatch chatmol:// URLs to an unrelated Electron project.
function registerProtocolClient(): void {
  if (process.defaultApp) {
    return;
  }
  app.setAsDefaultProtocolClient("chatmol");
}

registerProtocolClient();

/**
 * Validate the callback destination and forward code/state to the local daemon.
 * The daemon owns the pending login and verifier and rejects unsolicited URLs.
 */
function handleProtocolUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "chatmol:" || parsed.hostname !== "auth" || parsed.pathname !== "/callback" || parsed.username || parsed.password || parsed.port || parsed.hash) return;
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    if (!code || !/^[a-f0-9]{64}$/.test(code) || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return;
    const callbackQuery = new URLSearchParams({ code, state }).toString();
    if (!currentDaemon || !mainWindow) {
      pendingProtocolCode = callbackQuery;
      return;
    }
    if (mainWindow) {
      mainWindow.loadURL(
        `${getDaemonBaseUrl(currentDaemon)}/api/auth/desktop-session?${callbackQuery}`
      );
      // Bring window to front
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  } catch (err) {
    console.error("Failed to handle protocol URL:", err);
  }
}

// macOS: app is already running, opened via custom URL scheme
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

// Windows/Linux: second instance launched with protocol URL
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // The protocol URL is the last argument
    const url = argv.find((arg) => arg.startsWith("chatmol://"));
    if (url) handleProtocolUrl(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function getResourcePath(relativePath: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  }
  // Development: resources are relative to project root
  return path.join(__dirname, "..", relativePath);
}

function getRuntimeResourcePath(relativePath: string): string {
  return getResourcePath(path.join("runtime", relativePath));
}

function ensureDataDir(): void {
  for (const dir of [DATA_DIR, WORKSPACE_DIR, LOG_DIR, DESKTOP_RUNTIME_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function appendRuntimeLog(message: string): void {
  try {
    fs.appendFileSync(path.join(LOG_DIR, "runtime-bootstrap.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never prevent app startup.
  }
}

function readRuntimeManifest(): RuntimeManifest | null {
  const manifestPath = getRuntimeResourcePath("runtime-manifest.json");
  try {
    if (!fs.existsSync(manifestPath)) return null;
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as RuntimeManifest;
  } catch (err) {
    appendRuntimeLog(`Could not read runtime manifest: ${String(err)}`);
    return null;
  }
}

function readRuntimeState(): RuntimeState | null {
  try {
    if (!fs.existsSync(RUNTIME_STATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, "utf-8")) as RuntimeState;
  } catch {
    return null;
  }
}

function writeRuntimeState(state: RuntimeState): void {
  fs.mkdirSync(path.dirname(RUNTIME_STATE_PATH), { recursive: true });
  fs.writeFileSync(RUNTIME_STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// Async so the main process stays responsive (setup window keeps painting).
function runRuntimeCommand(command: string, args: string[], extraOpts: Record<string, unknown> = {}): Promise<void> {
  appendRuntimeLog(`$ ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        PATH: [...CONDA_ROOT_BIN_DIRS, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
      },
      ...extraOpts,
    });
    let stderrTail = "";
    child.stdout?.on("data", (d: Buffer) => { const s = d.toString().trim(); if (s) appendRuntimeLog(s); });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-1000);
      const t = s.trim();
      if (t) appendRuntimeLog(t);
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited ${code}${stderrTail ? `: ${stderrTail.slice(-300)}` : ""}`));
    });
  });
}

function isRuntimeReady(): boolean {
  return fs.existsSync(CONDA_BIN) && fs.existsSync(ENV_PYTHON) && fs.existsSync(WEMOL_CLI_PATH);
}

function copyBundledWemolCli(manifest: RuntimeManifest): void {
  const executable = manifest.wemolCli?.executable || `wemol-cli/${WEMOL_CLI_NAME}`;
  const src = getRuntimeResourcePath(executable);
  if (!fs.existsSync(src)) {
    throw new Error(`Bundled wemol-cli not found at ${src}`);
  }
  fs.mkdirSync(WEMOL_CLI_DIR, { recursive: true });
  fs.copyFileSync(src, WEMOL_CLI_PATH);
  if (!IS_WIN) {
    fs.chmodSync(WEMOL_CLI_PATH, 0o755);
  }
}

function getWemolCliVersion(): string | undefined {
  try {
    return execFileSync(WEMOL_CLI_PATH, ["--version"], {
      env: getDesktopRuntimeEnv(),
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch (err) {
    appendRuntimeLog(`wemol-cli --version failed: ${String(err)}`);
    return undefined;
  }
}

type ProgressFn = (msg: string) => void;

// Returns true if a bootstrap actually ran (useful for the setup window).
async function ensureDesktopRuntime(onProgress: ProgressFn = () => {}): Promise<boolean> {
  if (!app.isPackaged && process.env.CHATMOL_BOOTSTRAP_RUNTIME !== "true") {
    return false;
  }

  const manifest = readRuntimeManifest();
  if (!manifest) {
    appendRuntimeLog("No bundled runtime manifest found; skipping desktop runtime bootstrap.");
    return false;
  }
  const supported =
    (process.platform === "darwin" && process.arch === "arm64") ||
    (process.platform === "win32" && process.arch === "x64");
  if (!supported) {
    appendRuntimeLog(`No bundled runtime for platform ${process.platform}-${process.arch}.`);
    return false;
  }

  const current = readRuntimeState();
  if (current && isRuntimeReady()) {
    appendRuntimeLog(`Desktop runtime already ready at ${current.envPrefix}`);
    return false;
  }

  appendRuntimeLog("Starting desktop runtime bootstrap.");
  fs.mkdirSync(DESKTOP_RUNTIME_DIR, { recursive: true });

  const installerName = manifest.conda?.installer?.fileName;
  if (!installerName) {
    throw new Error("Runtime manifest does not specify a conda installer.");
  }
  const installerPath = getRuntimeResourcePath(path.join("downloads", installerName));
  if (!fs.existsSync(installerPath)) {
    throw new Error(`Bundled conda installer not found at ${installerPath}`);
  }

  if (!fs.existsSync(CONDA_BIN)) {
    onProgress("Installing the Python runtime (Miniforge)…");
    if (fs.existsSync(MAMBAFORGE_ROOT)) {
      fs.rmSync(MAMBAFORGE_ROOT, { recursive: true, force: true });
    }
    if (IS_WIN) {
      // NSIS silent install; /D (target dir) must be last and unquoted, so pass
      // args verbatim. Requires an install path without characters NSIS mishandles.
      await runRuntimeCommand(
        installerPath,
        ["/InstallationType=JustMe", "/AddToPath=0", "/RegisterPython=0", "/S", `/D=${MAMBAFORGE_ROOT}`],
        { windowsVerbatimArguments: true },
      );
    } else {
      await runRuntimeCommand("/bin/bash", [installerPath, "-b", "-p", MAMBAFORGE_ROOT]);
    }
  }

  // Python MCP SDK (v1 API) for the bundled PyMOL / ChimeraX servers. Best
  // effort: the Settings card can install it later if this fails offline.
  onProgress("Installing the Python MCP package…");
  try {
    await runRuntimeCommand(ENV_PYTHON, ["-m", "pip", "install", "--upgrade", "mcp>=1.2,<2"]);
  } catch (err) {
    appendRuntimeLog(`mcp package install failed (can be installed from Settings): ${err instanceof Error ? err.message : String(err)}`);
  }

  onProgress("Installing the WeMol CLI…");
  copyBundledWemolCli(manifest);
  const wemolCliVersion = getWemolCliVersion();
  writeRuntimeState({
    schemaVersion: 1,
    condaVersion: manifest.conda?.installer?.version,
    wemolCliVersion,
    condaRoot: MAMBAFORGE_ROOT,
    envPrefix: CHATMOL_CONDA_ENV,
    wemolCliPath: WEMOL_CLI_PATH,
    bootstrappedAt: new Date().toISOString(),
  });
  appendRuntimeLog(`Desktop runtime ready at ${CHATMOL_CONDA_ENV}`);
  onProgress("Runtime ready.");
  return true;
}

function getDesktopRuntimeEnv(): Record<string, string> {
  const pathParts = [...ENV_BIN_DIRS, ...CONDA_ROOT_BIN_DIRS, process.env.PATH || ""].filter(Boolean);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CHATMOL_RUNTIME_DIR: DESKTOP_RUNTIME_DIR,
    CHATMOL_CONDA_PREFIX: CHATMOL_CONDA_ENV,
    CHATMOL_CONDA_ROOT: MAMBAFORGE_ROOT,
    // Platform-correct env bin dir(s) for the bash tool's Shell PATH default.
    CHATMOL_CONDA_BIN: ENV_BIN_DIRS.join(path.delimiter),
    CHATMOL_WEMOL_CLI: WEMOL_CLI_PATH,
    CHATMOL_MCP_SERVERS_DIR: getResourcePath(app.isPackaged ? "mcp-servers" : path.join("web", "mcp-servers")),
    CHATMOL_ANALYSIS_DIR: getResourcePath(app.isPackaged ? "analysis" : path.join("web", "analysis")),
    // Bundled plugins (skills + subagent definitions); user installs go to ~/.chatmol-lab/plugins.
    CHATMOL_BUNDLED_PLUGINS_DIR: getResourcePath("plugins"),
    CHATMOL_HOME: DATA_DIR,
    PATH: pathParts.join(path.delimiter),
  };
  if (process.env.CHATMOL_WSL_READY === "1") {
    env.CHATMOL_WSL_READY = "1";
    env.CHATMOL_WSL_CONDA_PREFIX = process.env.CHATMOL_WSL_CONDA_PREFIX || WSL_CONDA_PREFIX_DISPLAY;
    env.CHATMOL_WSL_CONDA_BIN = process.env.CHATMOL_WSL_CONDA_BIN || WSL_CONDA_BIN_DISPLAY;
  }
  return env;
}

function getDaemonBaseUrl(state: DaemonState): string {
  return `http://127.0.0.1:${state.port}`;
}

function readDaemonState(): DaemonState | null {
  try {
    if (!fs.existsSync(DAEMON_STATE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(DAEMON_STATE_PATH, "utf-8")) as Partial<DaemonState>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.token !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.appPath !== "string"
    ) {
      return null;
    }
    return parsed as DaemonState;
  } catch {
    return null;
  }
}

function writeDaemonState(state: DaemonState): void {
  fs.writeFileSync(DAEMON_STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function clearDaemonState(pid?: number): void {
  const existing = readDaemonState();
  if (pid !== undefined && existing?.pid !== pid) {
    return;
  }
  try {
    if (fs.existsSync(DAEMON_STATE_PATH)) {
      fs.rmSync(DAEMON_STATE_PATH, { force: true });
    }
  } catch (err) {
    console.error("Failed to clear daemon state:", err);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthCheckDaemon(state: DaemonState, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${getDaemonBaseUrl(state)}/api/daemon/health`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as { ok?: boolean; desktop?: boolean } | null;
    return body?.ok === true && body?.desktop === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function findFreePort(preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => {
      const fallback = net.createServer();
      fallback.unref();
      fallback.on("error", reject);
      fallback.listen(0, "127.0.0.1", () => {
        const address = fallback.address();
        if (typeof address === "object" && address?.port) {
          const port = address.port;
          fallback.close(() => resolve(port));
        } else {
          fallback.close(() => reject(new Error("Could not allocate a daemon port")));
        }
      });
    });
    server.listen(preferredPort, "127.0.0.1", () => {
      server.close(() => resolve(preferredPort));
    });
  });
}

function getOrCreateSecret(): string {
  if (fs.existsSync(SECRET_PATH)) {
    return fs.readFileSync(SECRET_PATH, "utf-8").trim();
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

function ensureDatabase(): void {
  const templatePath = getResourcePath(
    app.isPackaged ? "prisma/template.db" : "web/prisma/template.db"
  );

  if (!fs.existsSync(DB_PATH)) {
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, DB_PATH);
      console.log("Database initialized from template");
      return;
    }
    console.warn("Template database not found at", templatePath);
    const schemaPath = getResourcePath(
      app.isPackaged ? "prisma/schema.prisma" : "web/prisma/schema.prisma"
    );
    try {
      execSync(`npx prisma db push --skip-generate --schema="${schemaPath}"`, {
        env: { ...process.env, DATABASE_URL: `file:${DB_PATH}` },
        stdio: "pipe",
      });
      console.log("Prisma DB push complete (fallback)");
    } catch (err) {
      console.error("Database initialization failed:", err);
    }
    return;
  }

  console.log("Database already exists at", DB_PATH);
  if (fs.existsSync(templatePath)) {
    migrateDatabase(DB_PATH, templatePath);
  }
}

/**
 * Forward-compatible additive migration: bring user DB up to the template's
 * schema by creating missing tables, adding missing columns, and creating
 * missing indexes. Existing data is preserved. Removed columns are kept.
 */
function migrateDatabase(userDbPath: string, templatePath: string): void {
  // Lazy require so unrelated startup errors don't trip on better-sqlite3
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let userDb: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tplDb: any = null;
  try {
    userDb = new Database(userDbPath);
    tplDb = new Database(templatePath, { readonly: true });

    type ColInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
    type TblRow = { name: string; sql: string };

    const tplTables: TblRow[] = tplDb.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%'`
    ).all() as TblRow[];

    let addedTables = 0;
    let addedColumns = 0;

    for (const tbl of tplTables) {
      const exists = userDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(tbl.name);

      if (!exists) {
        userDb.exec(tbl.sql);
        addedTables++;
        continue;
      }

      const tplCols = tplDb.prepare(`PRAGMA table_info("${tbl.name}")`).all() as ColInfo[];
      const userCols = new Map<string, ColInfo>();
      for (const c of userDb.prepare(`PRAGMA table_info("${tbl.name}")`).all() as ColInfo[]) {
        userCols.set(c.name, c);
      }

      for (const col of tplCols) {
        if (userCols.has(col.name)) continue;
        // ALTER TABLE ADD COLUMN — must provide a default for NOT NULL columns
        let defaultClause = col.dflt_value !== null ? `DEFAULT ${col.dflt_value}` : "";
        let notNullClause = col.notnull ? "NOT NULL" : "";
        if (col.notnull && col.dflt_value === null) {
          const t = (col.type || "").toUpperCase();
          if (t.includes("INT")) defaultClause = "DEFAULT 0";
          else if (t.includes("REAL") || t.includes("FLOAT") || t.includes("NUMERIC")) defaultClause = "DEFAULT 0";
          else defaultClause = "DEFAULT ''";
        }
        const ddl = `ALTER TABLE "${tbl.name}" ADD COLUMN "${col.name}" ${col.type} ${notNullClause} ${defaultClause}`.replace(/\s+/g, " ").trim();
        try {
          userDb.exec(ddl);
          addedColumns++;
        } catch (err) {
          console.warn(`Migration: failed to add column ${tbl.name}.${col.name}:`, err);
        }
      }
    }

    // Create missing indexes (idempotent via IF NOT EXISTS)
    type IdxRow = { name: string; sql: string };
    const tplIndexes: IdxRow[] = tplDb.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`
    ).all() as IdxRow[];
    for (const idx of tplIndexes) {
      try {
        userDb.exec(idx.sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (m) => `${m}IF NOT EXISTS `));
      } catch {
        // ignore — index may already exist
      }
    }

    if (addedTables || addedColumns) {
      console.log(`Database migrated: +${addedTables} tables, +${addedColumns} columns`);
    } else {
      console.log("Database schema up to date");
    }
  } catch (err) {
    console.error("Database migration failed:", err);
  } finally {
    try { userDb?.close(); } catch {}
    try { tplDb?.close(); } catch {}
  }
}

function startNextServer(state: DaemonState): ChildProcess {
  const secret = getOrCreateSecret();

  const env: Record<string, string> = {
    ...getDesktopRuntimeEnv(),
    PORT: String(state.port),
    HOSTNAME: "127.0.0.1",
    NEXT_PUBLIC_IS_ELECTRON: "true",
    IS_ELECTRON: "true",
    CHATMOL_IS_PACKAGED: app.isPackaged ? "true" : "false",
    CHATMOL_DAEMON_TOKEN: state.token,
    DATABASE_URL: `file:${DB_PATH}`,
    WORKSPACE_DIR: WORKSPACE_DIR,
    SETTINGS_PATH: SETTINGS_PATH,
    CHATMOL_REMOTE_URL: REMOTE_URL,
    NEXTAUTH_URL: getDaemonBaseUrl(state),
    NEXTAUTH_SECRET: secret,
  };

  let cmd: string;
  let args: string[];
  let cwd: string;

  if (app.isPackaged) {
    // In packaged app: standalone server is in Resources/standalone/
    const standalonePath = getResourcePath("standalone");
    const serverJs = path.join(standalonePath, "web", "server.js");
    const staticSrc = getResourcePath("static");
    const publicSrc = getResourcePath("public");

    // Next.js standalone expects static files at web/.next/static
    const staticDest = path.join(standalonePath, "web", ".next", "static");
    if (!fs.existsSync(staticDest) && fs.existsSync(staticSrc)) {
      fs.mkdirSync(path.dirname(staticDest), { recursive: true });
      fs.cpSync(staticSrc, staticDest, { recursive: true });
    }

    // Next.js standalone expects public files at web/public
    const publicDest = path.join(standalonePath, "web", "public");
    if (!fs.existsSync(publicDest) && fs.existsSync(publicSrc)) {
      fs.mkdirSync(path.dirname(publicDest), { recursive: true });
      fs.cpSync(publicSrc, publicDest, { recursive: true });
    }

    // Use Electron as Node.js via ELECTRON_RUN_AS_NODE
    cmd = process.execPath;
    args = [serverJs];
    cwd = standalonePath;
    env.ELECTRON_RUN_AS_NODE = "1";
  } else {
    // Development mode
    const webDir = path.join(__dirname, "..", "web");
    const standalonePath = path.join(webDir, ".next", "standalone");

    if (
      process.env.CHATMOL_DESKTOP_USE_STANDALONE === "true" &&
      fs.existsSync(path.join(standalonePath, "web", "server.js"))
    ) {
      cmd = "node";
      args = [path.join(standalonePath, "web", "server.js")];
      cwd = standalonePath;
    } else {
      const nextBin = path.join(__dirname, "..", "node_modules", "next", "dist", "bin", "next");
      cmd = process.execPath;
      args = [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(state.port)];
      cwd = webDir;
      env.NEXT_DIST_DIR = ".next-desktop";
    }
  }

  console.log(`Starting Next.js: ${cmd} ${args.join(" ")} in ${cwd}`);
  const logStamp = state.startedAt.replace(/[:.]/g, "-");
  const stdoutPath = path.join(LOG_DIR, `daemon-${logStamp}.out.log`);
  const stderrPath = path.join(LOG_DIR, `daemon-${logStamp}.err.log`);
  const stdoutFd = fs.openSync(stdoutPath, "a");
  const stderrFd = fs.openSync(stderrPath, "a");

  const child = spawn(cmd, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  child.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  console.log(`Daemon logs: ${stdoutPath}, ${stderrPath}`);

  child.on("error", (err) => {
    console.error("Failed to start Next.js:", err);
  });

  return child;
}

async function waitForDaemon(
  state: DaemonState,
  timeoutMs: number = 30000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthCheckDaemon(state, 1000)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function ensureDaemon(): Promise<DaemonState> {
  const existing = readDaemonState();
  if (
    existing &&
    existing.appPath === app.getPath("exe") &&
    isProcessAlive(existing.pid) &&
    await healthCheckDaemon(existing)
  ) {
    console.log(`Reusing ChatMol daemon on ${getDaemonBaseUrl(existing)} (pid ${existing.pid})`);
    return existing;
  }

  const preferredPort = Number(process.env.CHATMOL_DESKTOP_PORT || DEFAULT_DEV_PORT);
  const port = await findFreePort(Number.isFinite(preferredPort) ? preferredPort : DEFAULT_DEV_PORT);
  const state: DaemonState = {
    pid: 0,
    port,
    token: crypto.randomBytes(32).toString("hex"),
    version: app.getVersion(),
    startedAt: new Date().toISOString(),
    appPath: app.getPath("exe"),
  };

  const child = startNextServer(state);
  daemonProcess = child;
  if (!child.pid) {
    throw new Error("Daemon process did not expose a pid");
  }
  state.pid = child.pid;
  writeDaemonState(state);

  child.on("exit", (code, signal) => {
    console.log(`ChatMol daemon exited (pid ${state.pid}, code ${code}, signal ${signal})`);
    clearDaemonState(state.pid);
    if (currentDaemon?.pid === state.pid) {
      currentDaemon = null;
    }
  });

  await waitForDaemon(state);
  console.log(`Started ChatMol daemon on ${getDaemonBaseUrl(state)} (pid ${state.pid})`);
  return state;
}

function ensureDaemonOnce(): Promise<DaemonState> {
  if (!daemonStartupPromise) {
    daemonStartupPromise = ensureDaemon().catch((err) => {
      daemonStartupPromise = null;
      throw err;
    });
  }
  return daemonStartupPromise;
}

function createWindow(): void {
  if (!currentDaemon) {
    console.error("Cannot create BrowserWindow before daemon is ready");
    return;
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "ChatMol Lab",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(getDaemonBaseUrl(currentDaemon));

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createSetupWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "ChatMol Lab — Setup",
    backgroundColor: "#0b0b0d",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b0b0d;color:#e8e8ea;height:100vh;display:flex;align-items:center;justify-content:center}
    .box{text-align:center;padding:28px 34px;max-width:392px}
    .flask{font-size:38px;line-height:1}
    h1{font-size:17px;margin:14px 0 6px;font-weight:600}
    .sub{font-size:12px;color:#8a8a92;line-height:1.5;margin-bottom:18px}
    .bar{height:4px;border-radius:2px;background:#1b1b21;overflow:hidden;margin:14px 0}
    .fill{height:100%;width:34%;background:#d4a24a;border-radius:2px;animation:slide 1.3s infinite ease-in-out}
    @keyframes slide{0%{margin-left:-34%}100%{margin-left:100%}}
    .status{font-size:12px;color:#c8c8ce;min-height:30px}
    .err{color:#e5674b;font-size:11px;white-space:pre-wrap;text-align:left;margin-top:8px}
  </style></head><body><div class="box">
    <div class="flask">⚗️</div>
    <h1>Setting up ChatMol Lab</h1>
    <div class="sub">First-time setup: installing the local scientific runtime (Python&nbsp;+&nbsp;WeMol&nbsp;CLI). This runs once and can take a few minutes.</div>
    <div class="bar" id="bar"><div class="fill"></div></div>
    <div class="status" id="status">Preparing…</div>
    <div class="err" id="err"></div>
  </div><script>
    window.__set=(m)=>{document.getElementById('status').textContent=m};
    window.__err=(e)=>{document.getElementById('bar').style.display='none';document.getElementById('status').textContent='Setup failed — the app will retry on next launch.';document.getElementById('err').textContent=e};
  </script></body></html>`;
  return win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).then(() => win);
}

// Run the runtime bootstrap with a visible progress window (never silent).
// No-op and no window if the runtime is already installed.
async function runSetupIfNeeded(): Promise<void> {
  ensureDataDir();
  if (!app.isPackaged && process.env.CHATMOL_BOOTSTRAP_RUNTIME !== "true") return;
  if (isRuntimeReady()) return;

  let win: BrowserWindow | null = null;
  try {
    win = await createSetupWindow();
  } catch {
    // Fall back to a silent (but logged) bootstrap if the window can't open.
  }
  const onProgress: ProgressFn = (msg) => {
    win?.webContents.executeJavaScript(`window.__set(${JSON.stringify(msg)})`).catch(() => {});
  };
  try {
    await ensureDesktopRuntime(onProgress);
  } catch (err) {
    console.error("Desktop runtime bootstrap failed:", err);
    appendRuntimeLog(`Desktop runtime bootstrap failed: ${String(err)}`);
    if (win && !win.isDestroyed()) {
      win.webContents.executeJavaScript(`window.__err(${JSON.stringify(String(err))})`).catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    if (win && !win.isDestroyed()) win.close();
  }
}

const WSL_MINIFORGE_URL =
  "https://github.com/conda-forge/miniforge/releases/download/26.3.2-3/Miniforge3-26.3.2-3-Linux-x86_64.sh";
const WSL_CONDA_PREFIX = "$HOME/.chatmol/miniforge";
const WSL_CONDA_PREFIX_DISPLAY = "~/.chatmol/miniforge";
const WSL_CONDA_BIN_DISPLAY = "~/.chatmol/miniforge/bin:~/.chatmol/miniforge/condabin";

function runWslBash(script: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("wsl.exe", ["-e", "bash", "-lc", script], { windowsHide: true });
    } catch {
      resolve({ code: 1, out: "" });
      return;
    }
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ code: 1, out }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function markWslRuntimeReady(): void {
  process.env.CHATMOL_WSL_READY = "1";
  process.env.CHATMOL_WSL_CONDA_PREFIX = WSL_CONDA_PREFIX_DISPLAY;
  process.env.CHATMOL_WSL_CONDA_BIN = WSL_CONDA_BIN_DISPLAY;
}

function getBundledWslInstallerPath(): string | null {
  const manifest = readRuntimeManifest();
  const installerName = manifest?.wslConda?.installer?.fileName;
  if (!installerName) return null;
  const installerPath = getRuntimeResourcePath(path.join("downloads", installerName));
  return fs.existsSync(installerPath) ? installerPath : null;
}

// Best-effort Linux (WSL) conda runtime. bioconda tooling is Linux-only, so on
// Windows this is the "real" scientific env. Sets CHATMOL_WSL_READY=1 when the
// runtime is present; leaves it unset (native fallback) on any failure. The
// probe/has-check run every launch (fast); the install shows a progress window.
async function runWslSetup(): Promise<void> {
  if (process.platform !== "win32") return;
  if (!app.isPackaged && process.env.CHATMOL_BOOTSTRAP_RUNTIME !== "true") return;

  const probe = await runWslBash("echo __wsl_ok__", 20000);
  if (probe.code !== 0 || !probe.out.includes("__wsl_ok__")) {
    appendRuntimeLog("WSL not available yet; using native runtime.");
    return;
  }
  const has = await runWslBash(`test -x "${WSL_CONDA_PREFIX}/bin/conda" && test -x "${WSL_CONDA_PREFIX}/bin/python" && echo __has__`, 20000);
  if (has.out.includes("__has__")) {
    markWslRuntimeReady();
    appendRuntimeLog("WSL Linux runtime already provisioned.");
    return;
  }

  let win: BrowserWindow | null = null;
  try { win = await createSetupWindow(); } catch {}
  const onProgress: ProgressFn = (m) => {
    win?.webContents.executeJavaScript(`window.__set(${JSON.stringify(m)})`).catch(() => {});
  };
  onProgress("Setting up the Linux (WSL) scientific runtime…");
  try {
    const bundledInstaller = getBundledWslInstallerPath();
    const installerScript = bundledInstaller
      ? `INSTALLER="$(wslpath -a ${shellQuote(bundledInstaller)})"; bash "$INSTALLER" -b -p "${WSL_CONDA_PREFIX}";`
      : `(curl -fsSL "${WSL_MINIFORGE_URL}" -o mf.sh || wget -q "${WSL_MINIFORGE_URL}" -O mf.sh); bash mf.sh -b -p "${WSL_CONDA_PREFIX}"; rm -f mf.sh;`;
    if (bundledInstaller) {
      appendRuntimeLog(`Using bundled WSL Miniforge installer: ${bundledInstaller}`);
    } else {
      appendRuntimeLog("Bundled WSL Miniforge installer not found; downloading in WSL.");
    }
    const install = await runWslBash(
      `set -e; mkdir -p "$HOME/.chatmol"; cd "$HOME/.chatmol"; ` +
      `rm -rf "${WSL_CONDA_PREFIX}"; ${installerScript} ` +
      `"${WSL_CONDA_PREFIX}/bin/conda" --version; "${WSL_CONDA_PREFIX}/bin/python" --version`,
      1200000,
    );
    if (install.code === 0) {
      markWslRuntimeReady();
      appendRuntimeLog("WSL Linux runtime ready.");
    } else {
      appendRuntimeLog(`WSL runtime setup failed (using native): ${install.out.slice(-400)}`);
      if (win && !win.isDestroyed()) {
        onProgress("Linux runtime setup failed — using native. Continuing…");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } finally {
    if (win && !win.isDestroyed()) win.close();
  }
}

app.on("ready", async () => {
  // IPC handler: open URL in system browser (for OAuth flow)
  ipcMain.handle("open-external", (_event, url: string) => {
    // Only allow HTTPS URLs to be opened externally
    if (typeof url === "string" && url.startsWith("https://")) {
      shell.openExternal(url);
    }
  });

  // IPC handler: native folder picker for "choose workspace"
  ipcMain.handle("choose-directory", async (_event, options?: { defaultPath?: string; title?: string }) => {
    const result = await dialog.showOpenDialog({
      title: options?.title || "Choose a workspace folder",
      defaultPath: options?.defaultPath,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ensureDataDir();

  // Windows: the NSIS installer relaunches the app with --setup to install the
  // runtime BEFORE first open. In that mode, just run setup and quit.
  if (process.argv.includes("--setup") || process.env.CHATMOL_RUN_SETUP === "1") {
    await runSetupIfNeeded();
    app.quit();
    return;
  }

  // Normal launch: on first run (e.g. macOS, where the dmg can't run installers)
  // show a visible setup window and install the runtime before starting the app.
  await runSetupIfNeeded();
  // Windows: detect/provision the Linux (WSL) runtime for bioconda tooling.
  await runWslSetup();
  ensureDatabase();

  try {
    currentDaemon = await ensureDaemonOnce();
  } catch (err) {
    console.error("Could not start daemon:", err);
    app.quit();
    return;
  }

  createWindow();
  if (pendingProtocolCode && currentDaemon && mainWindow) {
    const code = pendingProtocolCode;
    pendingProtocolCode = null;
    mainWindow.loadURL(
      `${getDaemonBaseUrl(currentDaemon)}/api/auth/desktop-session?${code}`
    );
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    if (currentDaemon) {
      createWindow();
      return;
    }
    ensureDaemonOnce()
      .then((state) => {
        currentDaemon = state;
        createWindow();
      })
      .catch((err) => {
        console.error("Could not start daemon from activate:", err);
      });
  }
});

app.on("before-quit", () => {
  if (process.env.CHATMOL_DAEMON_KEEP_ALIVE === "true") {
    return;
  }

  const pid = currentDaemon?.pid || daemonProcess?.pid;
  if (daemonProcess) {
    daemonProcess.kill("SIGTERM");
    daemonProcess = null;
  }
  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  clearDaemonState(pid);
});
