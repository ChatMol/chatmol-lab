/**
 * Runtime environment manifest: what the bash tool's interpreter actually has.
 *
 * The model cannot see the machine. Left to guess, it imports whatever is
 * common (Bio, numpy, pandas) and learns the truth one ModuleNotFoundError at
 * a time — across all sessions, missing modules and missing commands were the
 * largest class of bash failures. So we probe the real interpreter once,
 * cache the result, and put a short, honest inventory in the system prompt.
 *
 * The inventory is a curated list of packages and CLI tools that matter for
 * computational biology; it says both what IS and what is NOT installed, so
 * the model installs before importing instead of after crashing.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { getRuntimeSubprocessEnv, getRuntimeStatus, getWslRuntimePrelude } from "./runtime";
import { loadSettings } from "./settings";

export interface CuratedPackage {
  /** Name shown to the model (the import name when it differs from the dist name). */
  label: string;
  /** Distribution names that satisfy this entry (importlib.metadata names, lower-case). */
  dists: string[];
}

export const CURATED_PACKAGES: CuratedPackage[] = [
  { label: "biopython (import Bio)", dists: ["biopython"] },
  { label: "numpy", dists: ["numpy"] },
  { label: "scipy", dists: ["scipy"] },
  { label: "pandas", dists: ["pandas"] },
  { label: "matplotlib", dists: ["matplotlib"] },
  { label: "seaborn", dists: ["seaborn"] },
  { label: "plotly", dists: ["plotly"] },
  { label: "rdkit", dists: ["rdkit", "rdkit-pypi"] },
  { label: "openbabel", dists: ["openbabel", "openbabel-wheel"] },
  { label: "torch", dists: ["torch"] },
  { label: "transformers", dists: ["transformers"] },
  { label: "fair-esm (import esm)", dists: ["fair-esm"] },
  { label: "scikit-learn (import sklearn)", dists: ["scikit-learn"] },
  { label: "networkx", dists: ["networkx"] },
  { label: "openmm", dists: ["openmm"] },
  { label: "pdbfixer", dists: ["pdbfixer"] },
  { label: "mdtraj", dists: ["mdtraj"] },
  { label: "MDAnalysis", dists: ["mdanalysis"] },
  { label: "prody", dists: ["prody"] },
  { label: "biotite", dists: ["biotite"] },
  { label: "freesasa", dists: ["freesasa"] },
  { label: "biopandas", dists: ["biopandas"] },
  { label: "pymol", dists: ["pymol", "pymol-open-source"] },
  { label: "py3Dmol", dists: ["py3dmol"] },
  { label: "anarci", dists: ["anarci"] },
  { label: "abnumber", dists: ["abnumber"] },
  { label: "requests", dists: ["requests"] },
  { label: "mcp", dists: ["mcp"] },
];

export const CURATED_TOOLS = [
  "wemol-cli", "curl", "git",
  "hmmsearch", "jackhmmer", "blastp", "mmseqs", "foldseek",
  "muscle", "mafft", "clustalo",
  "USalign", "TMalign", "mkdssp", "freesasa", "reduce",
  "obabel", "pymol", "gmx",
];

export interface RuntimeManifest {
  probedAt: number;
  python: { executable: string; version: string; packageCount: number } | null;
  /** label -> installed version, or null when not installed. */
  packages: Record<string, string | null>;
  /** tool -> resolved path, or null when not on PATH. */
  tools: Record<string, string | null>;
  error?: string;
}

/** Python that prints one JSON line describing the interpreter and curated dists. */
export function buildProbeScript(): string {
  const wanted = Array.from(new Set(CURATED_PACKAGES.flatMap((p) => p.dists)));
  return [
    "import json, sys",
    "try:",
    "    import importlib.metadata as md",
    "    dists = {}",
    "    for d in md.distributions():",
    "        try:",
    "            n = (d.metadata['Name'] or '').lower()",
    "        except Exception:",
    "            n = ''",
    "        if n: dists[n] = d.version",
    "except Exception:",
    "    dists = {}",
    `wanted = ${JSON.stringify(wanted)}`,
    "print(json.dumps({'version': sys.version.split()[0], 'executable': sys.executable, 'count': len(dists), 'packages': {w: dists.get(w) for w in wanted}}))",
  ].join("\n");
}

export interface ProbeOutput {
  version: string;
  executable: string;
  count: number;
  packages: Record<string, string | null>;
}

/** Parse the probe's stdout; tolerates warnings printed before the JSON line. */
export function parseProbeOutput(stdout: string): ProbeOutput | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const parsed = JSON.parse(lines[i]) as Partial<ProbeOutput>;
      if (typeof parsed.version !== "string" || typeof parsed.packages !== "object" || !parsed.packages) continue;
      return {
        version: parsed.version,
        executable: typeof parsed.executable === "string" ? parsed.executable : "",
        count: typeof parsed.count === "number" ? parsed.count : Object.keys(parsed.packages).length,
        packages: parsed.packages as Record<string, string | null>,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Map dist versions onto the curated labels. */
export function resolveCuratedPackages(distVersions: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const entry of CURATED_PACKAGES) {
    let version: string | null = null;
    for (const dist of entry.dists) {
      const v = distVersions[dist];
      if (typeof v === "string" && v) { version = v; break; }
    }
    out[entry.label] = version;
  }
  return out;
}

/** Locate curated tools on a PATH string without spawning anything. */
export function findToolsOnPath(
  pathValue: string,
  tools: string[] = CURATED_TOOLS,
  platform: NodeJS.Platform = process.platform,
  existsSync: (p: string) => boolean = (p) => { try { return fs.existsSync(p); } catch { return false; } },
): Record<string, string | null> {
  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).map((d) => d.trim()).filter(Boolean);
  const suffixes = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const out: Record<string, string | null> = {};
  for (const tool of tools) {
    out[tool] = null;
    for (const dir of dirs) {
      let found: string | null = null;
      for (const suffix of suffixes) {
        const candidate = pathImpl.join(dir, tool + suffix);
        if (existsSync(candidate)) { found = candidate; break; }
      }
      if (found) { out[tool] = found; break; }
    }
  }
  return out;
}

/** Render the manifest as a compact system-prompt section. */
export function formatRuntimeManifest(manifest: RuntimeManifest | null): string {
  if (!manifest) return "";
  const lines: string[] = ["## Runtime Environment", "Probed from the interpreter the bash tool runs. Trust this over assumptions about what is \"usually\" installed."];
  if (manifest.python) {
    lines.push(`- Python ${manifest.python.version} at ${manifest.python.executable} (${manifest.python.packageCount} packages installed)`);
  } else {
    lines.push(`- Python could not be probed${manifest.error ? ` (${manifest.error})` : ""}; run \`python --version\` and \`pip list\` before relying on any package.`);
  }
  const installed = Object.entries(manifest.packages).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
  const missing = Object.entries(manifest.packages).filter(([, v]) => !v).map(([k]) => k);
  if (manifest.python) {
    lines.push(`- Installed: ${installed.length > 0 ? installed.join(", ") : "none of the common scientific packages"}`);
    if (missing.length > 0) lines.push(`- NOT installed: ${missing.join(", ")}`);
  }
  const foundTools = Object.entries(manifest.tools).filter(([, v]) => v).map(([k]) => k);
  const missingTools = Object.entries(manifest.tools).filter(([, v]) => !v).map(([k]) => k);
  if (foundTools.length > 0) lines.push(`- CLI tools on PATH: ${foundTools.join(", ")}`);
  if (missingTools.length > 0) lines.push(`- CLI tools NOT on PATH: ${missingTools.join(", ")}`);
  lines.push(
    "Before importing a package that is not listed as installed, install it in its own bash call (`pip install <pkg>` or `conda install -y -c conda-forge <pkg>`; the reviewer approves installs into this environment). Do the same for missing CLI tools (bioconda), or use a dedicated tool / NVIDIA NIM instead.",
  );
  return lines.join("\n");
}

// --- Probe execution and cache ---

const CACHE_TTL_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;

let cached: { key: string; manifest: RuntimeManifest } | null = null;
let inflight: { key: string; promise: Promise<RuntimeManifest> } | null = null;

function runtimeKey(): string {
  const { shellPath } = loadSettings();
  const status = getRuntimeStatus();
  return [status.activeBackend, status.native.pathPrepend, shellPath, status.wsl.pathPrepend].join("|");
}

function probeCommand(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const isWin = process.platform === "win32";
  const basePath = process.env.PATH || (isWin ? "" : "/usr/bin:/bin:/usr/sbin:/sbin");
  const { shellPath } = loadSettings();
  const runtimeEnv = getRuntimeSubprocessEnv(shellPath, basePath);
  const env: NodeJS.ProcessEnv = { ...process.env, ...runtimeEnv };
  if (isWin && process.env.CHATMOL_WSL_READY === "1") {
    const inner = `${getWslRuntimePrelude()}; python -`;
    return { cmd: "wsl.exe", args: ["-e", "bash", "-lc", inner], env };
  }
  const python = runtimeEnv.CHATMOL_PYTHON || (isWin ? "python" : "python3");
  return { cmd: python, args: ["-"], env };
}

async function runProbe(): Promise<RuntimeManifest> {
  const { cmd, args, env } = probeCommand();
  const pathValue = env.PATH || "";
  const tools = findToolsOnPath(pathValue);
  const base: RuntimeManifest = { probedAt: Date.now(), python: null, packages: resolveCuratedPackages({}), tools };

  return new Promise<RuntimeManifest>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (manifest: RuntimeManifest) => {
      if (settled) return;
      settled = true;
      resolve(manifest);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      finish({ ...base, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish({ ...base, error: "probe timed out" });
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ...base, error: err.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const parsed = parseProbeOutput(stdout);
      if (!parsed) {
        finish({ ...base, error: (stderr || stdout).trim().split("\n").pop()?.slice(0, 200) || "probe produced no output" });
        return;
      }
      finish({
        ...base,
        python: { executable: parsed.executable, version: parsed.version, packageCount: parsed.count },
        packages: resolveCuratedPackages(parsed.packages),
      });
    });
    try {
      child.stdin?.end(buildProbeScript());
    } catch {
      /* the close handler reports */
    }
  });
}

/** Cached manifest for the current runtime; probes at most once per TTL. */
export function getRuntimeManifest(options: { force?: boolean } = {}): Promise<RuntimeManifest> {
  const key = runtimeKey();
  if (!options.force && cached && cached.key === key && Date.now() - cached.manifest.probedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached.manifest);
  }
  if (inflight && inflight.key === key) return inflight.promise;
  const promise = runProbe().then((manifest) => {
    cached = { key, manifest };
    if (inflight && inflight.promise === promise) inflight = null;
    return manifest;
  });
  inflight = { key, promise };
  return promise;
}

/** Whatever is cached right now, without waiting for a probe. */
export function peekRuntimeManifest(): RuntimeManifest | null {
  return cached?.manifest ?? null;
}

/** Forget the cache, e.g. after a successful `pip install`. */
export function invalidateRuntimeManifest(): void {
  cached = null;
}

/**
 * Prompt section for the main agent: waits briefly for a fresh probe, and
 * otherwise uses whatever is cached so a slow interpreter never delays chat.
 */
export async function getRuntimeManifestSection(waitMs = 4_000): Promise<string> {
  const probe = getRuntimeManifest();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs));
  const manifest = await Promise.race([probe, timeout]);
  return formatRuntimeManifest(manifest ?? peekRuntimeManifest());
}

/** True when a successful bash command may have changed the environment. */
export function commandChangesEnvironment(command: string): boolean {
  return /\b(pip3?|conda|mamba|micromamba|uv)\s+(install|uninstall|remove|update|upgrade|env\s+(create|remove|update))\b|\bpip3?\s+-m\b|python3?\s+-m\s+pip\s+(install|uninstall)/.test(command);
}
