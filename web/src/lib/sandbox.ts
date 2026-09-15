/**
 * File-effect sandbox for the bash tool (dsh / Codex style).
 *
 * The principle borrowed from deepseek-harness: do not predict what a command
 * will do and ask the user up front; confine the process so that it CANNOT
 * write outside the session workspace, report a denial as a fact in the tool
 * result, and let the model ask for wider access once, for that exact
 * command, with a one-sentence justification. The approval prompt raised by
 * that retry is the only time the user is interrupted for a file effect.
 *
 * Modes (file effects only; network and process visibility are not covered):
 *   workspace-write     — writes only under the session workspace, the
 *                         bundled runtime (so pip/conda installs work), the
 *                         per-user temp dir and /dev/null. Reads are allowed
 *                         everywhere except sibling session workspaces and
 *                         credential directories of the real home.
 *   danger-full-access  — no confinement (the `unrestricted` review mode, or
 *                         an approved escalation).
 *
 * Backends: macOS Seatbelt (`sandbox-exec`). Linux keeps the bwrap / unshare
 * wrappers in tools.ts; Windows has no backend yet.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type SandboxMode = "workspace-write" | "danger-full-access";
export type SandboxBackend = "seatbelt" | "bwrap" | "unshare" | "none";

export const ESCALATION_MODE: SandboxMode = "danger-full-access";

export interface SandboxPolicy {
  mode: SandboxMode;
  /** Canonical session workspace (the only project directory writable). */
  workspaceRoot: string;
  /** Additional canonical roots that may be written (runtime env, temp). */
  extraWritableRoots: string[];
  /** Canonical roots whose contents must not be read (siblings, credentials). */
  unreadableRoots: string[];
  /** Canonical roots inside an unreadable root that stay readable (the workspace itself). */
  readableExceptions: string[];
}

export interface SandboxStatus {
  backend: SandboxBackend;
  /** True when a backend actually confines commands on this host. */
  enforcing: boolean;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

/** Quote one path as an SBPL string literal. */
export function sbplString(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build the Seatbelt profile. SBPL evaluates the LAST matching rule, so each
 * deny is followed by the narrower allow that carves the exception out of it:
 * deny all writes, allow writes under the writable roots; deny reads of the
 * unreadable roots, allow reads of the session workspace inside them.
 */
/** Directories between a denied root and an allowed path, which must stay traversable. */
export function ancestorsWithin(target: string, deniedRoots: string[]): string[] {
  const out: string[] = [];
  for (const root of deniedRoots) {
    if (target === root || !target.startsWith(`${root}/`)) continue;
    let current = path.dirname(target);
    while (current.startsWith(root) && current.length >= root.length) {
      out.push(current);
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return out;
}

export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const writable = unique([policy.workspaceRoot, ...policy.extraWritableRoots]);
  const forms = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal ${sbplString("/dev/null")}))`,
    `(allow file-write* ${writable.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`,
  ];
  const unreadable = unique(policy.unreadableRoots);
  if (unreadable.length > 0) {
    forms.push(`(deny file-read* ${unreadable.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
    const exceptions = unique(policy.readableExceptions);
    if (exceptions.length > 0) {
      forms.push(`(allow file-read* ${exceptions.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
      // Reaching an allowed directory by absolute path needs lookup rights on
      // every directory above it, and those are inside the denied root. Without
      // this, `cd /…/workspace/<session>` and any absolute path into the
      // session fail with ENOTDIR while relative paths work, because relative
      // resolution starts from the already-open cwd. Metadata only: listing a
      // denied directory still needs file-read-data, which stays denied.
      const ancestors = unique(exceptions.flatMap((dir) => ancestorsWithin(dir, unreadable)));
      if (ancestors.length > 0) {
        forms.push(`(allow file-read-metadata ${ancestors.map((dir) => `(literal ${sbplString(dir)})`).join(" ")})`);
      }
    }
  }
  return forms.join(" ");
}

export interface SandboxPolicyInputs {
  sessionWorkspace: string;
  workspaceRoot?: string;
  /** Bundled runtime roots that installs may write into. */
  runtimeRoots?: string[];
  /** The real user home (credential directories under it are made unreadable). */
  realHome?: string;
  tmpDir?: string;
}

const CREDENTIAL_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".kube", ".docker", "Library/Keychains", ".netrc"];

/** Resolve the workspace-write policy for one session. */
export function resolveSandboxPolicy(inputs: SandboxPolicyInputs): SandboxPolicy {
  const workspace = realpathOrSelf(inputs.sessionWorkspace);
  const tmp = realpathOrSelf(inputs.tmpDir || os.tmpdir());
  const runtimeRoots = (inputs.runtimeRoots || []).filter((r) => r && fs.existsSync(r)).map(realpathOrSelf);
  const extraWritableRoots = unique([...runtimeRoots, tmp, "/private/tmp"]);

  const unreadable: string[] = [];
  const readableExceptions: string[] = [];
  const root = inputs.workspaceRoot ? realpathOrSelf(inputs.workspaceRoot) : null;
  // Sibling sessions: deny the root, re-allow this session's own folder.
  if (root && workspace.startsWith(root + path.sep)) {
    unreadable.push(root);
    readableExceptions.push(workspace);
    // The .sessions transcripts live under the root as well; they stay denied.
  }
  const home = inputs.realHome ? realpathOrSelf(inputs.realHome) : null;
  if (home) {
    for (const dir of CREDENTIAL_DIRS) {
      const p = path.join(home, dir);
      if (fs.existsSync(p)) unreadable.push(realpathOrSelf(p));
    }
  }
  return { mode: "workspace-write", workspaceRoot: workspace, extraWritableRoots, unreadableRoots: unique(unreadable), readableExceptions };
}

// --- Seatbelt availability (macOS) ---

let seatbeltAvailable: boolean | null = null;

export function isSeatbeltAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  if (seatbeltAvailable !== null) return seatbeltAvailable;
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"], { timeout: 5000, stdio: "ignore" });
    seatbeltAvailable = true;
  } catch {
    seatbeltAvailable = false;
    console.warn("[sandbox] sandbox-exec is not usable on this host — bash runs unconfined");
  }
  return seatbeltAvailable;
}

/** Wrap a shell command in a Seatbelt profile. */
export function seatbeltSpawn(command: string, policy: SandboxPolicy): { spawnCmd: string; spawnArgs: string[] } {
  return { spawnCmd: "/usr/bin/sandbox-exec", spawnArgs: ["-p", buildSeatbeltProfile(policy), "/bin/sh", "-c", command] };
}

// --- Denial classification ---

/**
 * Seatbelt reports a blocked file effect as EPERM. Only a failed run counts:
 * a successful command that merely logged a denied optional write (a cache
 * it could live without) is not a denial the model must act on.
 */
export function classifySeatbeltDenial(stderr: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  return /operation not permitted|\[errno 1\]|EPERM/i.test(stderr);
}

export function renderSandboxDenial(mode: SandboxMode, workspaceRoot: string, escalationAvailable: boolean): string {
  const lines = [
    `[sandbox: file access denied under ${mode} mode — writes are allowed only under the session workspace (${workspaceRoot}), the bundled runtime environment and the temp directory; sibling sessions and credential folders are not readable. This is a policy denial, not a bug in the command; do not try to route around it.]`,
  ];
  if (escalationAvailable) {
    lines.push(
      "[sandbox: escalation available — if the user's request needs this exact command to write there, retry it NOW with sandbox_permissions: \"danger-full-access\" and a one-sentence justification phrased as a question to the user. Do not ask in chat first: a reviewer rates the retry, low-risk retries run immediately, and only risky ones raise the approval prompt. If the user did not ask for that location, write inside the workspace instead.]",
    );
  }
  return lines.join("\n");
}

// --- Escalation bookkeeping ---
//
// Escalation is never speculative: a request must follow a real denial of the
// same command in the same session. Denials are remembered briefly per
// session so a retry after the approval round-trip still counts.

const DENIAL_TTL_MS = 30 * 60_000;

export interface SandboxDenialRecord {
  at: number;
  /** What the sandbox reported (stderr tail), shown to the escalation reviewer. */
  detail: string;
}

const deniedCommands = new Map<string, Map<string, SandboxDenialRecord>>();

function normalizeCommand(command: string): string {
  return command.replace(/\r\n/g, "\n").trim();
}

export function recordSandboxDenial(sessionId: string, command: string, detail = "", now = Date.now()): void {
  let perSession = deniedCommands.get(sessionId);
  if (!perSession) {
    perSession = new Map();
    deniedCommands.set(sessionId, perSession);
  }
  perSession.set(normalizeCommand(command), { at: now, detail: detail.trim().slice(-600) });
}

export function getSandboxDenial(sessionId: string, command: string, now = Date.now()): SandboxDenialRecord | null {
  const perSession = deniedCommands.get(sessionId);
  if (!perSession) return null;
  const key = normalizeCommand(command);
  const record = perSession.get(key);
  if (!record) return null;
  if (now - record.at > DENIAL_TTL_MS) {
    perSession.delete(key);
    return null;
  }
  return record;
}

export function wasSandboxDenied(sessionId: string, command: string, now = Date.now()): boolean {
  return getSandboxDenial(sessionId, command, now) !== null;
}

export function clearSandboxDenials(sessionId: string): void {
  deniedCommands.delete(sessionId);
}

export interface EscalationRequest {
  sandboxPermissions?: unknown;
  justification?: unknown;
}

/**
 * Validate an escalation request. Returns an error message when the request
 * must fail closed, or null when it may proceed to the approval prompt.
 */
export function validateEscalation(
  request: EscalationRequest,
  context: { sandboxEnforcing: boolean; priorDenial: boolean; currentMode: SandboxMode },
): string | null {
  const { sandboxPermissions, justification } = request;
  if (sandboxPermissions === undefined && justification === undefined) return null;
  if (!context.sandboxEnforcing) {
    return "sandbox_permissions is not available here: no file sandbox is enforcing on this host, so there is nothing to escalate. Run the command without it.";
  }
  if (sandboxPermissions !== ESCALATION_MODE) {
    return `sandbox_permissions must be "${ESCALATION_MODE}" (the only wider mode); got ${JSON.stringify(sandboxPermissions)}.`;
  }
  if (typeof justification !== "string" || !justification.trim()) {
    return "sandbox_permissions requires a non-empty one-sentence justification for the user.";
  }
  if (context.currentMode === ESCALATION_MODE) {
    return "This session already runs with full file access; sandbox_permissions is not needed.";
  }
  if (!context.priorDenial) {
    return "Escalation refused: the sandbox has not denied this exact command in this session. Run it normally first; escalate only after a real [sandbox: file access denied] result.";
  }
  return null;
}

/** Human-readable text for the approval prompt of an escalation. */
export function describeEscalationForUser(command: string, justification: string): string {
  return `The file sandbox denied this command and the agent asks to run it with full file access.\nReason given: ${justification.trim()}\nCommand: ${command.length > 400 ? `${command.slice(0, 400)}…` : command}`;
}

/** One-line policy statement for the system prompt (dsh "runtime context"). */
export function describeSandboxPolicyForModel(status: SandboxStatus, mode: SandboxMode, workspaceRoot: string): string {
  if (!status.enforcing) {
    return [
      "## File Sandbox",
      "No OS sandbox is enforcing on this host, so a bash command runs with the user's own privileges. Every bash call therefore stops for the user's approval before it runs. Keep commands few, short and obviously scoped to the task, and prefer the dedicated tools (read_file, write_file, analyze_structure) over shell equivalents.",
    ].join("\n");
  }
  if (mode === "danger-full-access") {
    return "";
  }
  return [
    "## File Sandbox",
    `Current file policy: workspace-write. bash commands may write only under the session workspace (${workspaceRoot}), the bundled runtime environment (pip/conda installs are fine) and the temp directory. Sibling session folders and credential directories cannot be read.`,
    "A blocked file operation is reported in the tool result as `[sandbox: file access denied under workspace-write mode]`. That is a policy denial, not a bug: do not retry another way or route around it. If the exact command truly needs wider access, retry it once with `sandbox_permissions: \"danger-full-access\"` plus a one-sentence `justification` written as a question to the user (for example \"Save the report to your Desktop as requested?\"). Do not ask in chat first: the retry is reviewed, a low-risk retry runs without interrupting the user, and a risky one raises the approval prompt. Never set sandbox_permissions before a real denial, and a rejected escalation is final for that command. This escalation path is the sanctioned way to honour a user's explicit request for a location outside the workspace; it is not circumvention.",
  ].join("\n");
}
