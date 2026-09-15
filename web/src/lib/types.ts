export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolCallId: string }
  | { type: "reasoning"; text: string };

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  artifacts?: Artifact[];
  isStreaming?: boolean;
  contentBlocks?: ContentBlock[];
  hidden?: boolean;
  source?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  errorOutput?: string;
  status: "pending" | "running" | "completed" | "error";
}

export type SubagentTraceItemType =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "status";

export interface SubagentTraceItem {
  id: string;
  type: SubagentTraceItemType;
  ts: number;
  title?: string;
  content?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  success?: boolean;
}

export interface SubagentRun {
  id: string;
  agentId: string;
  name: string;
  model?: string;
  task: string;
  status: "running" | "completed" | "error";
  startedAt: number;
  updatedAt: number;
  summary?: string;
  error?: string;
  trace: SubagentTraceItem[];
}

export interface ApprovalRequest {
  command: string;
  reason?: string;
  message?: string;
  expiresAt?: number;
  toolName?: string;
  arguments?: Record<string, unknown>;
  displayCommand?: string;
  reviewMode?: "manual" | "reviewer" | "auto";
}

export interface Artifact {
  id: string;
  name: string;
  type: ArtifactType;
  path: string;
  size?: number;
  content?: string;
  previewUrl?: string;
}

export type ArtifactType =
  | "pdb"
  | "cif"
  | "mmcif"
  | "fasta"
  | "csv"
  | "tsv"
  | "json"
  | "python"
  | "r"
  | "notebook"
  | "image"
  | "text"
  | "pdf"
  | "sdf"
  | "a3m"
  | "html"
  | "markdown"
  | "unknown";

export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "error";
  substeps?: PlanStep[];
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  plan: PlanStep[];
  artifacts: Artifact[];
  subagentRuns?: SubagentRun[];
  runStatus?: AgentRunStatus | null;
}

export type AgentRunPhase = "running" | "retrying" | "paused" | "completed" | "error";

export interface AgentRunStatus {
  runId?: string;
  phase: AgentRunPhase;
  label: string;
  loop?: number;
  maxLoops?: number;
  contextApproxTokens?: number;
  contextChars?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  retryCount?: number;
  lastEvent?: string;
  error?: string;
  updatedAt: number;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  artifactType?: ArtifactType;
}

export function getArtifactType(filename: string): ArtifactType {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const typeMap: Record<string, ArtifactType> = {
    pdb: "pdb",
    cif: "cif",
    mmcif: "mmcif",
    fasta: "fasta",
    fa: "fasta",
    fna: "fasta",
    faa: "fasta",
    csv: "csv",
    tsv: "tsv",
    json: "json",
    py: "python",
    r: "r",
    ipynb: "notebook",
    png: "image",
    jpg: "image",
    jpeg: "image",
    svg: "image",
    gif: "image",
    txt: "text",
    log: "text",
    sdf: "sdf",
    a3m: "a3m",
    pdf: "pdf",
    html: "html",
    md: "markdown",
  };
  return typeMap[ext] || "unknown";
}

export function isStructureFile(type: ArtifactType): boolean {
  return type === "pdb" || type === "cif" || type === "mmcif";
}

// --- WeMol background jobs ---
/** Coarse status the UI tracks for any background compute job. */
export type ComputeJobStatus = "pending" | "running" | "done" | "failed" | "unknown";

/** Who runs a tracked background job. */
export type ComputeJobProvider = "wemol" | "chatmol-bio" | "chatmol-router";

/**
 * A background compute job tracked by the desktop (WeMol module run, ChatMol
 * Bio GPU job, ChatMol Router job). Persisted client-side so the poller can
 * resume after a reload; the agent is auto-continued when it finishes.
 */
export interface ComputeJob {
  id: string;            // provider job id
  provider: ComputeJobProvider;
  sessionId: string;
  label: string;         // short human label (module/flow, offering, or command summary)
  /** Router-style offering id (`chatmol-bio/esmfold_predict_structure`). */
  offering?: string;
  capability?: string;
  command?: string;      // the originating `job submit` command (WeMol)
  status: ComputeJobStatus;
  submittedAt: number;
  updatedAt: number;
  progress?: string;
  progressPercent?: number | null;
  message?: string;      // last status line / error text
  continued?: boolean;   // true once the agent auto-continued on completion
  /** Workspace paths imported from the job's artifacts. */
  artifacts?: string[];
}

/** @deprecated alias kept for the WeMol code paths; every tracked job is a ComputeJob. */
export type WemolJobStatus = ComputeJobStatus;
export type WemolJob = ComputeJob;
