/**
 * Shim between the shared runtime and hosted-only tools (`@/hosted/tools`).
 * The public repository overlays `web/src/hosted/tools.ts` with an empty set.
 */
import type { ToolDefinition, ToolResult } from "./tools";

export interface HostedToolContext {
  sessionWorkspace: string;
  sessionId: string;
  userId: string | null;
}

export interface HostedTools {
  definitions: ToolDefinition[];
  /** Per-tool timeout in seconds. */
  timeouts: Record<string, number>;
  /** Lines appended to the "Capabilities" section of the system prompt. */
  systemPromptLines: string[];
  /** Returns null when the tool is not a hosted tool. */
  execute(name: string, input: Record<string, unknown>, ctx: HostedToolContext): Promise<ToolResult | null>;
}

// Static import: the hosted module is part of the build (real or stub), so
// definitions are available synchronously when ALL_TOOLS is assembled.
import { hostedTools } from "@/hosted/tools";

export function getHostedTools(): HostedTools {
  return hostedTools;
}

export async function executeHostedTool(name: string, input: Record<string, unknown>, ctx: HostedToolContext): Promise<ToolResult | null> {
  if (!hostedTools.definitions.some((tool) => tool.name === name)) return null;
  return hostedTools.execute(name, input, ctx);
}
