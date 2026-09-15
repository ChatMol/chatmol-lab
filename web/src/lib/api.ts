import type { Message, Artifact, PlanStep, ApprovalRequest, ComputeJob, ComputeJobStatus } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

export type RunEvent = Record<string, unknown> & {
  type: "run_event";
  event: string;
  runId: string;
  ts: number;
};

interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolCall: (toolCall: {
    name: string;
    arguments: Record<string, unknown>;
  }) => void;
  onToolResult: (result: { name: string; output: string; success: boolean }) => void;
  onArtifact: (artifact: Artifact) => void;
  onPlan: (steps: PlanStep[]) => void;
  onError: (error: string) => void;
  onDone: () => void;
  onReasoningStart?: () => void;
  onReasoning?: (content: string) => void;
  onSelectArtifact?: (artifact: Artifact) => void;
  onApprovalRequired?: (approval: ApprovalRequest) => void;
  /** A tool started a background compute job (WeMol, ChatMol Bio, Router) to track. */
  onComputeJob?: (job: ComputeJob) => void;
  onRunEvent?: (event: RunEvent) => void;
}

export async function sendMessage(
  sessionId: string,
  content: string,
  callbacks: StreamCallbacks,
  skills?: string[],
  signal?: AbortSignal,
  approvedCommands?: string[],
  subagents?: string[],
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const body: Record<string, unknown> = { sessionId, message: content };
    if (skills && skills.length > 0) body.skills = skills;
    if (Array.isArray(subagents)) body.subagents = subagents;
    if (approvedCommands && approvedCommands.length > 0) body.approvedCommands = approvedCommands;
    if (metadata && Object.keys(metadata).length > 0) body.metadata = metadata;

    const response = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (response.status === 429) {
      const data = await response.json().catch(() => ({ error: "Usage limit exceeded" }));
      throw new Error(`LIMIT_EXCEEDED:${JSON.stringify(data)}`);
    }

    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: string; code?: string } | null;
      if (data?.code === "llm_not_configured") {
        throw new Error(`CONFIG_ERROR:${JSON.stringify(data)}`);
      }
      throw new Error(data?.error ? `HTTP ${response.status}: ${data.error}` : `HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            callbacks.onDone();
            return;
          }
          try {
            const event = JSON.parse(data);
            handleStreamEvent(event, callbacks);
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }

    callbacks.onDone();
  } catch (error) {
    if (signal?.aborted) {
      // User aborted — just call onDone to reset UI state
      callbacks.onDone();
      return;
    }
    callbacks.onError(
      error instanceof Error ? error.message : "Unknown error"
    );
    // Always call onDone so the UI resets (stops streaming indicator, saves session)
    callbacks.onDone();
  }
}

function handleStreamEvent(
  event: Record<string, unknown>,
  callbacks: StreamCallbacks
) {
  switch (event.type) {
    case "token":
      callbacks.onToken(event.content as string);
      break;
    case "tool_call":
      callbacks.onToolCall({
        name: event.name as string,
        arguments: event.arguments as Record<string, unknown>,
      });
      break;
    case "tool_result":
      callbacks.onToolResult({
        name: event.name as string,
        output: event.output as string,
        success: event.success !== false,
      });
      break;
    case "artifact":
      callbacks.onArtifact(event.artifact as Artifact);
      break;
    case "plan":
      callbacks.onPlan(event.steps as PlanStep[]);
      break;
    case "reasoning_start":
      callbacks.onReasoningStart?.();
      break;
    case "reasoning":
      callbacks.onReasoning?.(event.content as string);
      break;
    case "error":
      callbacks.onError(event.message as string);
      break;
    case "select_artifact":
      callbacks.onSelectArtifact?.(event.artifact as Artifact);
      break;
    case "approval_required":
    case "sandbox_confirm":
      callbacks.onApprovalRequired?.({
        command: event.command as string,
        reason: event.reason as string | undefined,
        message: event.message as string | undefined,
        expiresAt: typeof event.expiresAt === "number" ? event.expiresAt : undefined,
        toolName: event.toolName as string | undefined,
        arguments: event.arguments as Record<string, unknown> | undefined,
        displayCommand: event.displayCommand as string | undefined,
        reviewMode: event.reviewMode as "manual" | "reviewer" | "auto" | undefined,
      });
      break;
    case "wemol_job":
    case "compute_job":
      callbacks.onComputeJob?.({ ...(event.job as ComputeJob), provider: (event.job as ComputeJob).provider || "wemol" });
      break;
    case "run_event":
      callbacks.onRunEvent?.(event as RunEvent);
      break;
  }
}

export interface ComputeJobStatusResult {
  status: ComputeJobStatus;
  message?: string;
  progress?: string;
  progressPercent?: number | null;
}

/** Checks one tracked background job with its provider (WeMol CLI or a catalog provider). */
export async function checkComputeJobStatus(job: Pick<ComputeJob, "id" | "provider" | "sessionId">): Promise<ComputeJobStatusResult> {
  try {
    const res = job.provider === "wemol"
      ? await fetch(`${API_BASE}/api/wemol/job-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, sessionId: job.sessionId }),
      })
      : await fetch(`${API_BASE}/api/compute/jobs/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: job.provider, jobId: job.id, sessionId: job.sessionId }),
      });
    if (!res.ok) return { status: "unknown", message: `status check failed (${res.status})` };
    return (await res.json()) as ComputeJobStatusResult;
  } catch (err) {
    return { status: "unknown", message: err instanceof Error ? err.message : "status check failed" };
  }
}

export function getFileServeUrl(path: string, sessionId?: string): string {
  let url = `${API_BASE}/api/files/serve?path=${encodeURIComponent(path)}`;
  if (sessionId) url += `&sessionId=${encodeURIComponent(sessionId)}`;
  return url;
}

export async function fetchFile(path: string, sessionId?: string): Promise<string> {
  let url = `${API_BASE}/api/files?path=${encodeURIComponent(path)}`;
  if (sessionId) url += `&sessionId=${encodeURIComponent(sessionId)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch file: ${path}`);
  return response.text();
}

export async function fetchFileList(sessionId?: string): Promise<string[]> {
  let url = `${API_BASE}/api/files/list`;
  if (sessionId) url += `?sessionId=${encodeURIComponent(sessionId)}`;
  const response = await fetch(url);
  if (!response.ok) return [];
  return response.json();
}

export async function uploadFile(file: File, sessionId?: string): Promise<Artifact> {
  const formData = new FormData();
  formData.append("file", file);
  if (sessionId) formData.append("sessionId", sessionId);
  const response = await fetch(`${API_BASE}/api/files/upload`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) throw new Error("Upload failed");
  return response.json();
}

export async function downloadFile(path: string, sessionId?: string): Promise<Blob> {
  let url = `${API_BASE}/api/files/download?path=${encodeURIComponent(path)}`;
  if (sessionId) url += `&sessionId=${encodeURIComponent(sessionId)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Download failed");
  return response.blob();
}

// Session API

export async function getSessions(): Promise<
  { id: string; title: string; updatedAt: number; messageCount?: number }[]
> {
  const response = await fetch(`${API_BASE}/api/sessions`);
  if (!response.ok) return [];
  return response.json();
}

export async function createSessionApi(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: sessionId }),
  });
}

export async function deleteSessionApi(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function renameSessionApi(
  id: string,
  title: string
): Promise<void> {
  await fetch(`${API_BASE}/api/sessions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, title }),
  });
}

export async function getSessionData(
  id: string
): Promise<{
  messages: Message[];
  plan: PlanStep[];
  artifacts: Artifact[];
} | null> {
  const response = await fetch(
    `${API_BASE}/api/sessions?id=${encodeURIComponent(id)}`
  );
  if (!response.ok) return null;
  return response.json();
}

export async function saveSessionData(
  id: string,
  messages?: Message[],
  plan?: PlanStep[],
  artifacts?: Artifact[]
): Promise<void> {
  const body: Record<string, unknown> = { id };
  if (messages !== undefined) body.messages = messages;
  if (plan !== undefined) body.plan = plan;
  if (artifacts !== undefined) body.artifacts = artifacts;
  await fetch(`${API_BASE}/api/sessions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function generateSessionTitle(
  id: string,
  firstMessage: string
): Promise<string | null> {
  const response = await fetch(`${API_BASE}/api/sessions/title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, message: firstMessage }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.title || null;
}

// --- Session workspace (folder) ---

export interface SessionWorkspaceInfo {
  sessionId: string | null;
  path: string;
  isCustom: boolean;
  root: string;
  exists: boolean;
  canChoose: boolean;
}

export async function fetchSessionWorkspace(sessionId: string): Promise<SessionWorkspaceInfo | null> {
  try {
    const res = await fetch(`${API_BASE}/api/workspace?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as SessionWorkspaceInfo;
  } catch {
    return null;
  }
}

export async function setSessionWorkspace(
  sessionId: string,
  folder: string | null,
  options: { create?: boolean } = {},
): Promise<SessionWorkspaceInfo> {
  const res = await fetch(`${API_BASE}/api/workspace`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, path: folder, create: options.create === true }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Failed to set workspace");
  return json as SessionWorkspaceInfo;
}
