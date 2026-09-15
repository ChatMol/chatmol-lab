import * as fs from "fs";
import * as path from "path";

export type AgentEventType =
  | "user_message"
  | "assistant_token"
  | "assistant_reasoning"
  | "tool_call"
  | "tool_result"
  | "run_event"
  | "artifact"
  | "plan"
  | "select_artifact"
  | "error"
  | "done"
  | "memory_saved"
  | "approval_required"
  | "sandbox_confirm"
  | "approval_granted"
  | "wemol_job"
  | "compute_job";

export interface AgentEvent {
  id: string;
  ts: number;
  sessionId: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
}

function safePayload(payload: Record<string, unknown>): Record<string, unknown> {
  try {
    JSON.stringify(payload);
    return payload;
  } catch {
    return { serializationError: true };
  }
}

export function appendAgentEvent(
  sessionWorkspace: string,
  sessionId: string,
  type: AgentEventType,
  payload: Record<string, unknown> = {}
): void {
  try {
    fs.mkdirSync(sessionWorkspace, { recursive: true });
    const event: AgentEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ts: Date.now(),
      sessionId,
      type,
      payload: safePayload(payload),
    };
    fs.appendFileSync(path.join(sessionWorkspace, ".events.jsonl"), `${JSON.stringify(event)}\n`, "utf-8");
  } catch (err) {
    console.error("[agent-events] append failed:", err);
  }
}
