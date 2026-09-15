/**
 * Structure analysis backed by the bundled scientific runtime.
 *
 * The science runs in `web/analysis/structure_analysis.py` on established
 * libraries (biotite for geometry, Biopython for sequence properties) rather
 * than in hand-written numerics here. This module resolves the interpreter,
 * installs the two Python dependencies on first use the way the MCP presets
 * install `mcp`, runs one JSON request per call, and renders the result for
 * the model.
 *
 * Session logs showed the agent writing throwaway `python3 << EOF` BioPython
 * scripts for exactly these questions — chains and contacts, RMSD, pLDDT,
 * secondary structure — and looping when the ad-hoc parsing was wrong.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { resolvePresetPython } from "./mcp-presets";
import { getRuntimeSubprocessEnv } from "./runtime";

/** Installed into the bundled runtime on first use. */
export const ANALYSIS_REQUIREMENTS = ["biotite>=1.0", "biopython>=1.83"];
/** Optional: gives full 8-state DSSP instead of 3-state P-SEA. */
export const ANALYSIS_OPTIONAL_CONDA = ["dssp"];

const SCRIPT_NAME = "structure_analysis.py";
const INSTALL_TIMEOUT_MS = 240_000;
const VERSION_TIMEOUT_MS = 30_000;

export type AnalysisOperation =
  | "secondary_structure"
  | "superpose"
  | "interface"
  | "sasa"
  | "confidence"
  | "sequence_properties";

export const ANALYSIS_OPERATIONS: AnalysisOperation[] = [
  "secondary_structure",
  "superpose",
  "interface",
  "sasa",
  "confidence",
  "sequence_properties",
];

export interface AnalysisResponse {
  ok: boolean;
  code?: string;
  error?: string;
  module?: string;
  result?: Record<string, unknown>;
}

/** Locate the bundled analysis script (packaged app, dev server, or override). */
export function resolveAnalysisScript(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const candidates = [
    env.CHATMOL_ANALYSIS_DIR ? path.join(env.CHATMOL_ANALYSIS_DIR, SCRIPT_NAME) : null,
    path.join(cwd, "analysis", SCRIPT_NAME),
    path.join(cwd, "web", "analysis", SCRIPT_NAME),
    path.join(cwd, "..", "web", "analysis", SCRIPT_NAME),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], options: { timeoutMs: number; stdin?: string; cwd?: string }): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...getRuntimeSubprocessEnv("", process.env.PATH || "") },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({ code: -2, stdout, stderr: `${stderr}\n[timed out after ${options.timeoutMs}ms]` });
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    else child.stdin?.end();
  });
}

export interface AnalysisStatus {
  python: string | null;
  script: string | null;
  ready: boolean;
  /** Versions reported by the backend when ready. */
  versions?: { biotite?: string; python?: string };
  reason?: string;
}

let statusCache: { at: number; status: AnalysisStatus } | null = null;

export async function getAnalysisStatus(force = false): Promise<AnalysisStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.status;
  const python = resolvePresetPython();
  const script = resolveAnalysisScript();
  let status: AnalysisStatus = { python, script, ready: false };
  if (!python) status.reason = "No Python interpreter found in the bundled runtime.";
  else if (!script) status.reason = `${SCRIPT_NAME} was not found next to the app.`;
  else {
    const outcome = await run(python, [script], { timeoutMs: VERSION_TIMEOUT_MS, stdin: JSON.stringify({ operation: "__version__" }) });
    const parsed = parseResponse(outcome);
    if (parsed.ok && parsed.result) {
      status = { python, script, ready: true, versions: { biotite: String(parsed.result.biotite ?? ""), python: String(parsed.result.python ?? "") } };
    } else {
      status.reason = parsed.code === "missing_dependency"
        ? `Missing Python package: ${parsed.module || "unknown"}`
        : parsed.error || "The analysis backend did not start.";
    }
  }
  statusCache = { at: Date.now(), status };
  return status;
}

function parseResponse(outcome: RunOutcome): AnalysisResponse {
  const text = outcome.stdout.trim();
  if (!text) {
    return { ok: false, code: "no_output", error: outcome.stderr.trim().slice(-600) || `The analysis backend exited with code ${outcome.code}.` };
  }
  // The payload is the last JSON line; anything before it is library noise.
  const lines = text.split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]) as AnalysisResponse;
    } catch { /* try the line before */ }
  }
  return { ok: false, code: "bad_output", error: `Unparseable backend output: ${text.slice(0, 400)}` };
}

export interface InstallOutcome {
  ok: boolean;
  log: string;
  dsspInstalled: boolean;
}

/** pip-install the analysis dependencies into the bundled runtime. */
export async function installAnalysisDependencies(options: { includeDssp?: boolean } = {}): Promise<InstallOutcome> {
  const python = resolvePresetPython();
  if (!python) return { ok: false, log: "No Python interpreter found in the bundled runtime.", dsspInstalled: false };
  const pip = await run(python, ["-m", "pip", "install", "--upgrade", ...ANALYSIS_REQUIREMENTS], { timeoutMs: INSTALL_TIMEOUT_MS });
  let log = `${pip.stdout}\n${pip.stderr}`.trim();

  // mkdssp upgrades secondary structure from 3-state to full DSSP codes. It
  // only exists on conda-forge, and a failure here is not fatal.
  let dsspInstalled = false;
  if (options.includeDssp) {
    const conda = process.env.CHATMOL_CONDA_ROOT
      ? path.join(process.env.CHATMOL_CONDA_ROOT, process.platform === "win32" ? "Scripts/conda.exe" : "bin/conda")
      : "conda";
    const result = await run(conda, ["install", "-y", "-c", "conda-forge", ...ANALYSIS_OPTIONAL_CONDA], { timeoutMs: INSTALL_TIMEOUT_MS });
    dsspInstalled = result.code === 0;
    log += `\n--- dssp (optional) ---\n${(result.stdout + result.stderr).slice(-1500)}`;
  }

  statusCache = null;
  return { ok: pip.code === 0, log: log.slice(-4000), dsspInstalled };
}

export interface AnalysisRunResult extends AnalysisResponse {
  /** True when dependencies were installed during this call. */
  installed?: boolean;
}

/**
 * Run one analysis request, installing the Python dependencies on first use.
 */
export async function runStructureAnalysis(
  request: Record<string, unknown>,
  options: { timeoutMs?: number; cwd?: string; autoInstall?: boolean } = {},
): Promise<AnalysisRunResult> {
  const python = resolvePresetPython();
  const script = resolveAnalysisScript();
  if (!python) return { ok: false, code: "no_python", error: "No Python interpreter found in the bundled runtime. Open Settings → API to check the runtime." };
  if (!script) return { ok: false, code: "no_script", error: `${SCRIPT_NAME} was not found. Reinstall the app or set CHATMOL_ANALYSIS_DIR.` };

  const timeoutMs = options.timeoutMs ?? 180_000;
  const payload = JSON.stringify(request);
  let outcome = await run(python, [script], { timeoutMs, stdin: payload, cwd: options.cwd });
  let parsed = parseResponse(outcome);

  if (!parsed.ok && parsed.code === "missing_dependency" && options.autoInstall !== false) {
    const install = await installAnalysisDependencies();
    if (!install.ok) {
      return {
        ok: false,
        code: "install_failed",
        error: `Installing the analysis dependencies (${ANALYSIS_REQUIREMENTS.join(", ")}) failed: ${install.log.slice(-600)}`,
      };
    }
    outcome = await run(python, [script], { timeoutMs, stdin: payload, cwd: options.cwd });
    parsed = parseResponse(outcome);
    return { ...parsed, installed: true };
  }
  return parsed;
}
