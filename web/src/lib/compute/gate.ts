/**
 * ComputeGate — the only seam between the shared agent runtime and any
 * account / wallet / quota system.
 *
 * The shared runtime (tools.ts, the chat route) asks the gate whether a run
 * may start, reports what it consumed, and shows the user whatever reason the
 * gate returns. It never sees credits, plans, prices or balances. In local
 * mode the open gate allows everything; the hosted deployment plugs in its
 * private implementation from `@/hosted/compute-gate`.
 */
import { isHostedDeployment } from "@/lib/deployment";

export interface ComputeGateContext {
  userId: string | null;
  sessionId: string;
}

export type GateDecision =
  | { allowed: true; /** Cap on a metered tool's runtime, seconds. */ maxRuntimeSec?: number; /** Opaque token the gate wants back in `afterToolRun`. */ ticket?: string }
  | { allowed: false; reason: string; /** Machine-readable reason for the client (e.g. "quota"). */ code?: string };

export interface ToolRunReport extends ComputeGateContext {
  tool: string;
  durationMs: number;
  success: boolean;
  ticket?: string;
}

export interface ModelCallReport extends ComputeGateContext {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ComputeGate {
  /** Before the chat route starts an agent run. */
  beforeChatRun(ctx: ComputeGateContext): Promise<GateDecision>;
  /** Before a metered tool (NVIDIA NIM, WeMol, …) executes. */
  beforeToolRun(ctx: ComputeGateContext & { tool: string }): Promise<GateDecision>;
  /** After a metered tool finished or failed (also called on timeout). */
  afterToolRun(report: ToolRunReport): Promise<void>;
  /** After each model call in the agent loop. */
  afterModelCall(report: ModelCallReport): Promise<void>;
}

/** Local mode: nothing is metered by ChatMol; provider costs are the user's own. */
export const openComputeGate: ComputeGate = {
  async beforeChatRun() { return { allowed: true }; },
  async beforeToolRun() { return { allowed: true }; },
  async afterToolRun() {},
  async afterModelCall() {},
};

/** Tools whose execution the gate is consulted for. */
export function isMeteredTool(name: string): boolean {
  return name.startsWith("nvidia_");
}

let override: ComputeGate | null = null;

/** Tests and the hosted adapter can install a gate explicitly. */
export function setComputeGate(gate: ComputeGate | null): void {
  override = gate;
}

export async function getComputeGate(): Promise<ComputeGate> {
  if (override) return override;
  if (!isHostedDeployment()) return openComputeGate;
  const { hostedComputeGate } = await import("@/hosted/compute-gate");
  return hostedComputeGate ?? openComputeGate;
}
