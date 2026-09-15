/**
 * ComputeProvider — the compute-backend seam.
 *
 * The desktop only expresses *what* the user wants computed (a capability
 * plus inputs). A provider decides how: NVIDIA NIM with the user's own key,
 * WeMol with the user's own account, the local runtime, or the ChatMol
 * gateway (wallet-settled, server-routed). Tools in the agent runtime never
 * talk to a backend directly; they call `runComputeCapability()` in
 * `registry.ts`, which picks the provider from the Compute backend setting.
 */
import type { ComputeJob } from "../types";

export type ComputeProviderKind = "direct" | "local" | "gateway";

/**
 * Unified job state machine (ChatMol Router design §4). Direct providers only
 * ever return terminal states; async providers return `queued`/`running` and
 * are tracked by the desktop poller.
 */
export type ProviderJobStatus =
  | "draft"
  | "awaiting_confirmation"
  | "queued"
  | "running"
  | "partial_results"
  | "reviewing"
  | "succeeded"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "requires_action";

export function isTerminalStatus(status: ProviderJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** A provider's concrete implementation of a capability (Router "offering"). */
export interface ComputeOffering {
  /** `<provider>/<name>`, e.g. `chatmol-bio/esmfold_predict_structure`. */
  id: string;
  provider: string;
  name: string;
  label: string;
  description: string;
  /** Provider-neutral capability id when known (`protein/structure-prediction`). */
  capability?: string;
  category?: string;
  version?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  acceptsFiles?: boolean;
  gpuType?: string;
  priceModel?: { kind: "fixed" | "estimate" | "usage" | "quote_required"; note?: string };
}

export interface ComputeRequest {
  /** Capability id. Today these are the tool names (`nvidia_openfold2`, `wemol_cli`). */
  capability: string;
  inputs: Record<string, unknown>;
  sessionWorkspace: string;
  sessionId: string;
  userId: string | null;
  signal?: AbortSignal;
  /** Cap on the text returned to the model. */
  maxOutputChars?: number;
  /** Soft constraints a router may use; ignored by direct providers. */
  constraints?: { maxCost?: number; accuracy?: "draft" | "standard" | "high" };
}

export interface ProviderJob {
  id: string;
  provider: string;
  capability: string;
  status: ProviderJobStatus;
  /** Provider's own status string, kept for provenance. */
  providerStatus?: string;
  /** Model-facing result text (or the failure reason). */
  output: string;
  /** Workspace-relative or absolute paths the job wrote. */
  artifacts: string[];
  progressPercent?: number | null;
  /** Set when the job keeps running in the background and the desktop should track it. */
  trackedJob?: ComputeJob;
}

export interface ComputeQuote {
  amount: number;
  currency: string;
  note?: string;
}

export interface ProviderAvailability {
  ok: boolean;
  /** Human-readable reason when not ok (shown in Settings and to the model). */
  reason?: string;
}

export interface ComputeProvider {
  id: string;
  label: string;
  kind: ComputeProviderKind;
  /** Capability ids this provider can serve (tool names for direct providers, offering ids for catalog providers). */
  capabilities(): readonly string[];
  /** Whether the provider can be used right now (credentials present, reachable). */
  availability(ctx: { userId: string | null }): Promise<ProviderAvailability>;
  /** Catalog providers list their offerings (input schema, price model). */
  catalog?(): Promise<ComputeOffering[]>;
  getOffering?(id: string): Promise<ComputeOffering | null>;
  /** Optional price estimate; direct providers usually return null (cost is the user's own). */
  quote?(request: ComputeRequest): Promise<ComputeQuote | null>;
  /** Runs the request. Direct providers complete synchronously; async providers return a queued job. */
  submit(request: ComputeRequest): Promise<ProviderJob>;
  getJob(id: string): Promise<ProviderJob | null>;
  cancel(id: string): Promise<void>;
  /** Downloads a finished job's artifacts into the workspace; returns the saved paths. */
  downloadArtifacts?(id: string, sessionWorkspace: string): Promise<string[]>;
}

export function terminalJob(
  provider: string,
  capability: string,
  result: { output: string; success: boolean; artifacts?: string[]; trackedJob?: ComputeJob },
  id = `${provider}-${Date.now().toString(36)}`,
): ProviderJob {
  return {
    id,
    provider,
    capability,
    status: result.success ? "succeeded" : "failed",
    output: result.output,
    artifacts: result.artifacts ?? [],
    trackedJob: result.trackedJob,
  };
}

/** Maps the unified provider state machine onto the coarse status the desktop tracks. */
export function toTrackedStatus(status: ProviderJobStatus): ComputeJob["status"] {
  switch (status) {
    case "succeeded":
      return "done";
    case "failed":
    case "cancelled":
    case "cancelling":
      return "failed";
    case "queued":
    case "draft":
    case "awaiting_confirmation":
    case "requires_action":
      return "pending";
    case "running":
    case "partial_results":
    case "reviewing":
      return "running";
    default:
      return "unknown";
  }
}
