// Pure, dependency-light helpers for WeMol background jobs.
// Kept free of node/prisma imports so they are trivially unit-testable.
import type { WemolJobStatus } from "./types";

/** Best-effort parse of a wemol job id from `job submit` output. */
export function parseWemolJobId(output: string): string | null {
  // Prefer an explicitly labeled id, e.g. "Job ID: abc123" or {"job_id":"..."}.
  const labeled = output.match(/job[\s_-]*id["'\s:=]+([A-Za-z0-9][A-Za-z0-9._-]{4,})/i);
  if (labeled) return labeled[1];
  // Fall back to a UUID anywhere in the output.
  const uuid = output.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  if (uuid) return uuid[0];
  return null;
}

/** Short label for a job from its submit command (module/flow id or a summary). */
export function summarizeWemolSubmit(command: string): string {
  const m = command.match(/--(?:module|flow)[-_]?id[=\s]+["']?([A-Za-z0-9._-]+)/i);
  if (m) return m[1];
  return "WeMol job";
}

/** True when a `job submit` command should create a tracked background job. */
export function isTrackableSubmit(command: string): boolean {
  return /^job\s+submit\b/i.test(command.trim()) && !/--dry-run\b/i.test(command);
}

/** Extract a numeric Progress percentage from JSON or text output. */
export function parseWemolProgressPercent(text: string): number | null {
  const jsonMatch = text.match(/"Progress"\s*:\s*"?(\d+(?:\.\d+)?)%"?/i);
  const labeledMatch = text.match(/\bProgress\b\s*[:=]\s*"?(\d+(?:\.\d+)?)%?"?/i);
  const percentMatch = text.match(/\b(\d+(?:\.\d+)?)\s*%\b/);
  const raw = jsonMatch?.[1] || labeledMatch?.[1] || percentMatch?.[1];
  if (!raw) return null;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** Best-effort map of `job status` output to a coarse status. */
export function parseWemolStatus(text: string): WemolJobStatus {
  const t = text.toLowerCase();
  if (/\b(fail|failed|error|cancell?ed|aborted|killed)\b/.test(t)) return "failed";
  if (/\b(done|complete|completed|success|succeeded|finished)\b/.test(t)) return "done";
  if (/\b(running|processing|in[\s_-]?progress|started|executing)\b/.test(t)) return "running";
  if (/\b(pending|queued|queue|waiting|submitted)\b/.test(t)) return "pending";
  return "unknown";
}

/** Human label for the provider that runs a tracked job. */
export function computeJobProviderLabel(provider: string | undefined): string {
  switch (provider) {
    case "chatmol-bio":
      return "ChatMol Bio";
    case "chatmol-router":
      return "ChatMol Router";
    case "wemol":
    default:
      return "WeMol";
  }
}
