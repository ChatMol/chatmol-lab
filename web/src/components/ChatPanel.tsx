"use client";

import { useRef, useEffect, useCallback, useLayoutEffect, useState } from "react";
import { Atom } from "lucide-react";
import { describeSelection } from "@/lib/structure-selection";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  Send,
  Paperclip,
  AtSign,
  Square,
  FlaskConical,
  Loader2,
  Upload,
  X,
  ChevronRight,
  ChevronDown,
  Terminal,
  CheckCircle2,
  XCircle,
  Clock,
  ShieldAlert,
  ChevronsDownUp,
  Zap,
  Share2,
  Activity,
  RotateCcw,
  Gauge,
  Plus,
  Wrench,
  ArrowDown,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import { useComputeJobsStore } from "@/lib/compute-jobs-store";
import { computeJobProviderLabel } from "@/lib/wemol-jobs";
import { sendMessage, uploadFile, fetchFileList } from "@/lib/api";
import type { RunEvent } from "@/lib/api";
import type { Message, Artifact, ToolCall, ApprovalRequest, PlanStep, ComputeJob, AgentRunStatus, SubagentTraceItem } from "@/lib/types";
import { getArtifactType } from "@/lib/types";
import { segmentBlocks } from "@/lib/transcript-display";
import ModelBadge from "./ModelBadge";
import SkillPicker from "./SkillPicker";
import WorkspaceChip from "./WorkspaceChip";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-4 py-3">
      <div className="flex items-center gap-1.5 bg-bg-tertiary rounded-2xl px-4 py-2.5">
        <div className="w-2 h-2 bg-accent rounded-full typing-dot" />
        <div className="w-2 h-2 bg-accent rounded-full typing-dot" />
        <div className="w-2 h-2 bg-accent rounded-full typing-dot" />
      </div>
    </div>
  );
}

function formatCompactNumber(value?: number): string | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** A wide table scrolls inside the message instead of crushing its columns. */
const MARKDOWN_COMPONENTS = {
  table: ({ node: _node, ...props }: { node?: unknown } & React.HTMLAttributes<HTMLTableElement>) => (
    <div className="md-table-wrap">
      <table {...props} />
    </div>
  ),
};

function RunStatusBar({ status }: { status: AgentRunStatus }) {
  const contextTokens = formatCompactNumber(status.contextApproxTokens);
  const totalTokens = formatCompactNumber((status.totalInputTokens || 0) + (status.totalOutputTokens || 0));
  const phaseClass = {
    running: "text-accent border-accent/20 bg-accent/10",
    retrying: "text-warning border-warning/30 bg-warning/5",
    paused: "text-warning border-warning/30 bg-warning/5",
    completed: "text-success border-success/20 bg-success/5",
    error: "text-error border-error/30 bg-error/5",
  }[status.phase];

  return (
    <div className="border-b border-border bg-bg-primary/70 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${phaseClass}`}>
          {status.phase === "retrying" ? (
            <RotateCcw className="w-3.5 h-3.5" />
          ) : (
            <Activity className="w-3.5 h-3.5" />
          )}
          {status.label}
        </span>
        {status.loop !== undefined && (
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-text-secondary">
            Loop {status.loop}{status.maxLoops ? `/${status.maxLoops}` : ""}
          </span>
        )}
        {contextTokens && (
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-text-secondary">
            <Gauge className="w-3.5 h-3.5" />
            {contextTokens} ctx
          </span>
        )}
        {totalTokens && totalTokens !== "0" && (
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-text-secondary">
            {totalTokens} tokens
          </span>
        )}
        {status.retryCount !== undefined && status.retryCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning/5 px-2 py-1 text-warning">
            retry {status.retryCount}
          </span>
        )}
        {status.error && (
          <span className="min-w-0 flex-1 truncate text-error">{status.error}</span>
        )}
      </div>
    </div>
  );
}

function toolArgPreview(toolCall: ToolCall, max = 80): string {
  const text = toolCall.name === "bash" && toolCall.arguments?.command
    ? String(toolCall.arguments.command)
    : Object.entries(toolCall.arguments || {})
        .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v).slice(0, 40)}`)
        .join(" ");
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Level 3: one tool call — a compact row that expands to its input and output. */
function ToolCallBlock({ toolCall, collapseKey, defaultExpanded = false }: { toolCall: ToolCall; collapseKey: number; defaultExpanded?: boolean }) {
  const isSandboxBlocked = toolCall.status === "error" &&
    (toolCall.errorOutput || toolCall.result || "").includes("Command blocked by safety sandbox");
  const [expanded, setExpanded] = useState(defaultExpanded || isSandboxBlocked);

  useEffect(() => {
    if (collapseKey > 0) setExpanded(false);
  }, [collapseKey]);

  const statusIcon = isSandboxBlocked
    ? <ShieldAlert className="w-3.5 h-3.5 text-warning" />
    : {
        pending: <Clock className="w-3.5 h-3.5 text-text-muted" />,
        running: <Loader2 className="w-3.5 h-3.5 animate-spin text-warning" />,
        completed: <CheckCircle2 className="w-3.5 h-3.5 text-success" />,
        error: <XCircle className="w-3.5 h-3.5 text-error" />,
      }[toolCall.status];

  const isError = toolCall.status === "error" && !isSandboxBlocked;
  const hasOutput = toolCall.result || toolCall.errorOutput;

  // Format arguments for display
  const argsPreview = toolCall.name === "bash" && toolCall.arguments.command
    ? String(toolCall.arguments.command)
    : Object.entries(toolCall.arguments || {})
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n");

  return (
    <div className={`rounded-md border overflow-hidden ${isError ? "border-error/30" : "border-border/70"}`}>
      {/* Row — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-2 px-2.5 py-1.5 w-full text-left text-xs transition-colors ${
          isError ? "bg-error/5 hover:bg-error/10" : "bg-bg-secondary hover:bg-bg-hover"
        }`}
      >
        {statusIcon}
        {toolCall.name === "bash"
          ? <Terminal className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
          : <Wrench className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />}
        <span className="font-mono font-medium text-text-primary flex-shrink-0">{toolCall.name}</span>
        <span className="text-text-muted truncate flex-1 font-mono">{toolArgPreview(toolCall)}</span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        )}
      </button>

      {/* Expanded: arguments + output */}
      {expanded && (
        <div className="border-t border-border">
          {argsPreview && (
            <div className="px-3 py-2 bg-bg-secondary">
              <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1 font-medium">Input</div>
              <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap break-all max-h-32 overflow-auto">
                {argsPreview}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div className={`px-3 py-2 border-t border-border ${isError ? "bg-error/5" : "bg-bg-primary"}`}>
              <div className={`text-[10px] uppercase tracking-wider mb-1 font-medium ${isError ? "text-error" : "text-text-muted"}`}>
                {isError ? "Error" : "Output"}
              </div>
              <pre className={`text-xs font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto ${isError ? "text-error" : "text-text-secondary"}`}>
                {toolCall.errorOutput || toolCall.result}
              </pre>
            </div>
          )}
          {toolCall.status === "running" && !hasOutput && (
            <div className="px-3 py-2 bg-bg-primary">
              <div className="flex items-center gap-2 text-xs text-warning">
                <Loader2 className="w-3 h-3 animate-spin" />
                Running...
              </div>
            </div>
          )}
          {isSandboxBlocked && (
            <div className="px-3 py-2 border-t border-border bg-warning/5">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-3.5 h-3.5 text-warning flex-shrink-0" />
                <span className="text-xs text-warning">This command was blocked by the safety sandbox.</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const HIDDEN_TOOL_NAMES = new Set(["create_plan", "run_subagent"]);

interface ActivityGroupProps {
  toolCalls: ToolCall[];
  /** Number of run_subagent calls in this stretch (shown in the panel, counted here). */
  subagentCount: number;
  /** Streaming reasoning with no visible text yet. */
  thinking: boolean;
  isStreaming: boolean;
  collapseKey: number;
}

/**
 * Level 1 + 2: a single summary line for a stretch of agent activity
 * ("Ran 3 commands · used 2 tools"), expanding to the list of calls.
 * Thinking is never rendered — only signalled while it streams.
 */
function ActivityGroup({ toolCalls, subagentCount, thinking, isStreaming, collapseKey }: ActivityGroupProps) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (collapseKey > 0) setExpanded(false);
  }, [collapseKey]);

  const visible = toolCalls.filter((tc) => !HIDDEN_TOOL_NAMES.has(tc.name));
  const commands = visible.filter((tc) => tc.name === "bash");
  const others = visible.filter((tc) => tc.name !== "bash");
  const running = visible.filter((tc) => tc.status === "running" || tc.status === "pending");
  const failed = visible.filter((tc) => tc.status === "error");
  const blocked = visible.some((tc) => (tc.errorOutput || tc.result || "").includes("Command blocked by safety sandbox"));
  const active = isStreaming && (running.length > 0 || thinking);

  if (visible.length === 0 && subagentCount === 0 && !thinking) return null;

  const parts: string[] = [];
  if (active && running.length > 0) {
    const current = running[running.length - 1];
    parts.push(current.name === "bash" ? `Running ${toolArgPreview(current, 48) || "command"}` : `Running ${current.name}`);
  } else if (active && thinking) {
    parts.push("Thinking…");
  }
  const done = visible.filter((tc) => tc.status === "completed" || tc.status === "error");
  if (!active || done.length > 0) {
    const nCmd = active ? commands.filter((tc) => tc.status !== "running" && tc.status !== "pending").length : commands.length;
    const nTool = active ? others.filter((tc) => tc.status !== "running" && tc.status !== "pending").length : others.length;
    if (nCmd > 0) parts.push(`Ran ${nCmd} command${nCmd === 1 ? "" : "s"}`);
    if (nTool > 0) parts.push(`used ${nTool} tool${nTool === 1 ? "" : "s"}`);
  }
  if (subagentCount > 0) parts.push(`delegated ${subagentCount} subagent${subagentCount === 1 ? "" : "s"}`);
  if (parts.length === 0) parts.push(thinking ? "Thought" : "Worked");
  const summary = parts.join(" · ");

  const icon = active
    ? <Loader2 className="w-3.5 h-3.5 animate-spin text-warning flex-shrink-0" />
    : blocked
      ? <ShieldAlert className="w-3.5 h-3.5 text-warning flex-shrink-0" />
      : failed.length > 0
        ? <XCircle className="w-3.5 h-3.5 text-error flex-shrink-0" />
        : <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0" />;

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => visible.length > 0 && setExpanded((v) => !v)}
        className={`group flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors ${
          visible.length > 0 ? "hover:bg-bg-hover cursor-pointer" : "cursor-default"
        } text-text-secondary`}
        title={visible.length > 0 ? (expanded ? "Hide details" : "Show each call") : undefined}
      >
        {icon}
        <span>{summary}</span>
        {failed.length > 0 && !active && (
          <span className="text-error">· {failed.length} failed</span>
        )}
        {visible.length > 0 && (
          expanded
            ? <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
            : <ChevronRight className="w-3.5 h-3.5 text-text-muted opacity-60 group-hover:opacity-100" />
        )}
      </button>
      {expanded && visible.length > 0 && (
        <div className="mt-1 ml-5 space-y-1 border-l border-border pl-2">
          {visible.map((tc) => (
            <ToolCallBlock key={tc.id} toolCall={tc} collapseKey={collapseKey} />
          ))}
        </div>
      )}
    </div>
  );
}

function TextBlock({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="markdown-body text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MessageBubble({ message, collapseKey }: { message: Message; collapseKey: number }) {
  const { selectArtifact } = useAppStore();
  const isUser = message.role === "user";
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} px-4 py-1.5`}>
      <div
        className={`max-w-[85%] ${
          isUser
            ? "bg-accent text-bg-primary rounded-2xl rounded-br-md px-4 py-2.5"
            : "text-text-primary"
        }`}
      >
        {isUser ? (
          <div className="text-sm whitespace-pre-wrap break-all">{message.content}</div>
        ) : hasBlocks ? (
          <div>
            {segmentBlocks(message).map((segment) => segment.kind === "text"
              ? <TextBlock key={segment.key} text={segment.text} />
              : (
                <ActivityGroup
                  key={segment.key}
                  toolCalls={segment.toolCalls}
                  subagentCount={segment.subagentCount}
                  thinking={segment.thinking}
                  isStreaming={!!message.isStreaming}
                  collapseKey={collapseKey}
                />
              ))}
          </div>
        ) : (
          /* Fallback for messages without contentBlocks (legacy / loaded from DB) */
          <>
            {message.toolCalls && message.toolCalls.length > 0 && (
              <ActivityGroup
                toolCalls={message.toolCalls.filter((tc) => tc.name !== "run_subagent")}
                subagentCount={message.toolCalls.filter((tc) => tc.name === "run_subagent").length}
                thinking={false}
                isStreaming={false}
                collapseKey={collapseKey}
              />
            )}
            {message.content && (
              <div className="markdown-body text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={MARKDOWN_COMPONENTS}>
                  {message.content}
                </ReactMarkdown>
              </div>
            )}
          </>
        )}

        {message.artifacts && message.artifacts.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {message.artifacts.map((artifact) => (
              <button
                key={artifact.id}
                onClick={() => selectArtifact(artifact)}
                className="flex items-center gap-2 px-3 py-1.5 bg-bg-tertiary border border-border rounded-lg text-xs hover:border-accent transition-colors"
              >
                <FlaskConical className="w-3.5 h-3.5 text-accent" />
                <span className="text-text-primary">{artifact.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatPanel() {
  const {
    getActiveSession,
    addMessage,
    updateMessage,
    appendToContentBlock,
    appendToReasoningBlock,
    addToolCall,
    resolveToolCall,
    setPlan,
    updatePlanStep,
    updateRunStatus,
    addArtifact,
    upsertSubagentRun,
    appendSubagentTrace,
    updateSubagentRun,
    selectArtifact,
    isAgentThinking,
    setAgentThinking,
    inputValue,
    setInputValue,
    createSession,
    activeSessionId,
    saveActiveSession,
    generateTitle,
    loadSessionData,
    setWorkspaceFiles,
    activeSkills,
    setActiveSkills,
    removeActiveSkill,
  } = useAppStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Auto-scroll only while the user is pinned to the bottom. Any upward
  // wheel/touch/keyboard intent unpins immediately; our own programmatic
  // scrolls are flagged so their scroll events never re-pin or unpin.
  const pinnedToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(0);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastApprovalCommandRef = useRef<string | null>(null);
  const isComposingRef = useRef(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  // One-time notice the first time the memory distiller saves something.
  const [memoryNotice, setMemoryNotice] = useState<string[] | null>(null);
  const [collapseKey, setCollapseKey] = useState(0);
  const [limitBanner, setLimitBanner] = useState<{ error: string; limitType: string } | null>(null);
  const [configBanner, setConfigBanner] = useState<string | null>(null);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [pendingApproval, setPendingApproval] = useState<
    (ApprovalRequest & { sessionId: string; messageToSend: string; metadata?: Record<string, unknown> }) | null
  >(null);

  const resizeInputTextarea = useCallback((textarea: HTMLTextAreaElement | null = inputRef.current) => {
    if (!textarea) return;
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, 128);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 128 ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeInputTextarea();
  }, [inputValue, resizeInputTextarea]);

  const session = getActiveSession();
  const messages = session?.messages || [];
  const runStatus = session?.runStatus || null;

  // When switching sessions, abort any in-flight stream and reset state
  const prevSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSessionRef.current !== null && prevSessionRef.current !== activeSessionId) {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      setIsStreaming(false);
      setAgentThinking(false);
    }
    prevSessionRef.current = activeSessionId;
  }, [activeSessionId, setAgentThinking]);

  // When streaming ends, finalize any plan steps still marked "in_progress"
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      // Read fresh plan from store to avoid stale closure
      const freshSession = getActiveSession();
      const plan = freshSession?.plan || [];
      for (const step of plan) {
        if (step.status === "in_progress") {
          updatePlanStep(step.id, { status: "completed" });
        }
      }
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, getActiveSession, updatePlanStep]);

  // Load session messages from DB when switching to a session with no messages
  useEffect(() => {
    if (activeSessionId && session && session.messages.length === 0) {
      loadSessionData(activeSessionId);
    }
  }, [activeSessionId, session, loadSessionData]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = messagesContainerRef.current;
    if (!container) return;
    programmaticScrollRef.current = Date.now();
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    // Ignore the scroll event caused by our own scrollTo (within ~150ms).
    if (Date.now() - programmaticScrollRef.current < 150) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const pinned = distanceFromBottom < 16;
    pinnedToBottomRef.current = pinned;
    setShowJumpToBottom(!pinned);
  }, []);

  // Explicit upward intent unpins right away (before any scroll event lands).
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const unpin = () => {
      pinnedToBottomRef.current = false;
      setShowJumpToBottom(true);
    };
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) unpin(); };
    const onTouchStart = () => unpin();
    const onKey = (e: KeyboardEvent) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) unpin(); };
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("keydown", onKey);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("keydown", onKey);
    };
  }, []);

  useLayoutEffect(() => {
    if (pinnedToBottomRef.current) scrollToBottom();
  }, [messages, isAgentThinking, scrollToBottom]);

  // A new session starts pinned.
  useEffect(() => {
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [activeSessionId]);

  const handleRunEvent = useCallback((event: RunEvent) => {
    const eventName = event.event;
    const asNumber = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const contextSize = event.contextSize as Record<string, unknown> | undefined;
    const loop = asNumber(event.loop);
    const maxLoops = asNumber(event.maxLoops);
    const base = {
      runId: event.runId,
      lastEvent: eventName,
      ...(loop !== undefined ? { loop } : {}),
      ...(maxLoops !== undefined ? { maxLoops } : {}),
    };

    switch (eventName) {
      case "memory_saved": {
        const names = Array.isArray(event.names) ? event.names.filter((n): n is string => typeof n === "string") : [];
        let shown = false;
        try {
          shown = window.localStorage.getItem("chatmol.memoryNoticeShown") === "1";
        } catch {
          shown = false;
        }
        if (!shown && names.length > 0) setMemoryNotice(names);
        updateRunStatus({
          ...base,
          phase: "running",
          label: names.length > 0 ? `Remembered: ${names.join(", ")}` : "Memory updated",
          error: undefined,
        });
        break;
      }
      case "context_compaction_start": {
        const originalSize = event.originalContextSize as Record<string, unknown> | undefined;
        updateRunStatus({
          ...base,
          phase: "running",
          label: "Compacting context",
          contextApproxTokens: asNumber(originalSize?.approxTokens),
          contextChars: asNumber(originalSize?.totalChars),
          error: undefined,
        });
        break;
      }
      case "context_compacted": {
        const from = asNumber(event.originalApproxTokens);
        const to = asNumber(event.compactedApproxTokens);
        updateRunStatus({
          ...base,
          phase: "running",
          label: from && to
            ? `Context compacted: ~${Math.round(from / 1000)}k → ~${Math.round(to / 1000)}k tokens${event.reusedSummary ? " (reused summary)" : ""}`
            : "Context compacted",
          contextApproxTokens: to,
          error: undefined,
        });
        break;
      }
      case "context_overflow":
        updateRunStatus({
          ...base,
          phase: "retrying",
          label: "Context window exceeded — compacting and retrying",
          error: undefined,
        });
        break;
      case "subagents_parallel":
        updateRunStatus({
          ...base,
          phase: "running",
          label: `Running ${String(event.count || "")} subagents in parallel`,
          error: undefined,
        });
        break;
      case "subagent_start":
        updateRunStatus({
          ...base,
          phase: "running",
          label: `Running subagent: ${String(event.name || event.agentId || "subagent")}`,
          error: undefined,
        });
        break;
      case "subagent_tool_call":
        updateRunStatus({
          ...base,
          phase: "running",
          label: `Subagent tool: ${String(event.name || "tool")}`,
          error: undefined,
        });
        break;
      case "subagent_tool_result":
        updateRunStatus({
          ...base,
          phase: "running",
          label: `Subagent finished tool: ${String(event.name || "tool")}`,
          error: event.success === false ? "Subagent tool failed" : undefined,
        });
        break;
      case "subagent_end":
        updateRunStatus({
          ...base,
          phase: event.status === "success" ? "running" : "error",
          label: `Subagent done: ${String(event.name || event.agentId || "subagent")}`,
          error: typeof event.error === "string" ? event.error : undefined,
        });
        break;
      case "tool_review_start":
        updateRunStatus({
          ...base,
          phase: "running",
          label: event.policy === "safe"
            ? "Bash policy: read-only command"
            : event.policy === "confirm"
              ? "Bash policy: needs your confirmation"
              : event.policy === "review"
                ? `Bash reviewer (${String(event.reviewerModel || "model")}) checking command`
                : `Reviewing tool: ${String(event.toolName || "tool")}`,
          error: undefined,
        });
        break;
      case "tool_review_decision":
        updateRunStatus({
          ...base,
          phase: event.approved === false && event.policy !== "confirm" ? "error" : "running",
          label: event.approved === false
            ? (event.policy === "confirm"
              ? `Waiting for confirmation: ${String(event.reason || "risky command")}`
              : `Tool review blocked: ${String(event.toolName || "tool")}`)
            : (event.policy === "safe"
              ? "Bash policy: approved (read-only)"
              : `Tool review approved: ${String(event.toolName || "tool")}`),
          error: event.approved === false && event.policy !== "confirm" && typeof event.reason === "string" ? event.reason : undefined,
        });
        break;
      case "run_start":
        updateRunStatus({
          ...base,
          phase: "running",
          label: "Starting run",
          retryCount: 0,
          error: undefined,
          contextApproxTokens: asNumber(contextSize?.approxTokens),
          contextChars: asNumber(contextSize?.totalChars),
        });
        break;
      case "loop_start":
        updateRunStatus({
          ...base,
          phase: "running",
          label: loop ? `Running loop ${loop}` : "Running",
          error: undefined,
        });
        break;
      case "context_size":
        updateRunStatus({
          ...base,
          phase: "running",
          label: loop ? `Running loop ${loop}` : "Running",
          contextApproxTokens: asNumber(event.approxTokens),
          contextChars: asNumber(event.totalChars),
          error: undefined,
        });
        break;
      case "usage":
        updateRunStatus({
          ...base,
          phase: "running",
          label: "Streaming response",
          inputTokens: asNumber(event.inputTokens),
          outputTokens: asNumber(event.outputTokens),
          totalInputTokens: asNumber(event.totalInputTokens),
          totalOutputTokens: asNumber(event.totalOutputTokens),
          error: undefined,
        });
        break;
      case "api_retry":
      case "stream_retry":
      case "empty_response_retry":
        updateRunStatus({
          ...base,
          phase: "retrying",
          label: String(event.message || "Retrying"),
          retryCount: asNumber(event.attempt),
          error: undefined,
        });
        break;
      case "max_turns":
        updateRunStatus({
          ...base,
          phase: "error",
          label: "Max loops reached",
          error: String(event.message || "Reached maximum tool call iterations."),
        });
        break;
      case "run_result": {
        const status = String(event.status || "success");
        const isSuccess = status === "success";
        const isPaused = status === "approval_required";
        updateRunStatus({
          ...base,
          phase: isSuccess ? "completed" : isPaused ? "paused" : "error",
          label: isSuccess ? "Done" : isPaused ? "Paused for approval" : status.replaceAll("_", " "),
          error: typeof event.error === "string" ? event.error : undefined,
        });
        break;
      }
      default:
        updateRunStatus({
          ...base,
          phase: "running",
          label: eventName.replaceAll("_", " "),
        });
    }
  }, [updateRunStatus]);

  const recordSubagentEvent = useCallback((sessionId: string, event: RunEvent) => {
    const runId = typeof event.subagentRunId === "string" ? event.subagentRunId : "";
    if (!runId) return;
    const agentId = typeof event.agentId === "string" ? event.agentId : "subagent";
    const name = typeof event.name === "string" ? event.name : agentId;
    const now = Date.now();

    if (event.event === "subagent_start") {
      upsertSubagentRun(sessionId, {
        id: runId,
        agentId,
        name,
        model: typeof event.model === "string" ? event.model : undefined,
        task: typeof event.task === "string" ? event.task : "",
        status: "running",
        startedAt: now,
        updatedAt: now,
        trace: [],
      });
      return;
    }

    if (event.event === "subagent_trace") {
      const item = event.item;
      if (!item || typeof item !== "object" || Array.isArray(item)) return;
      appendSubagentTrace(sessionId, runId, item as SubagentTraceItem);
      return;
    }

    if (event.event === "subagent_end") {
      updateSubagentRun(sessionId, runId, {
        status: event.status === "success" ? "completed" : "error",
        summary: typeof event.summary === "string" ? event.summary : undefined,
        error: typeof event.error === "string" ? event.error : undefined,
        updatedAt: now,
      });
    }
  }, [appendSubagentTrace, updateSubagentRun, upsertSubagentRun]);

  const buildStreamCallbacks = useCallback((
    assistantMsgId: string,
    sessionId: string,
    messageToSend: string,
    metadata?: Record<string, unknown>,
  ) => ({
    onRunEvent: (event: RunEvent) => {
      handleRunEvent(event);
      recordSubagentEvent(sessionId, event);
    },
    onToken: (token: string) => {
      appendToContentBlock(assistantMsgId, token);
      setAgentThinking(false);
    },
    onReasoning: (content: string) => {
      appendToReasoningBlock(assistantMsgId, content);
      setAgentThinking(false);
    },
    onToolCall: (tc: { name: string; arguments: Record<string, unknown> }) => {
      const toolCallId = generateId();
      updateRunStatus({
        phase: "running",
        label: `Running ${tc.name}`,
        error: undefined,
      });
      addToolCall(assistantMsgId, {
        id: toolCallId,
        name: tc.name,
        arguments: tc.arguments,
        status: "running",
      });
    },
    onToolResult: (result: { name: string; output: string; success: boolean }) => {
      updateRunStatus({
        phase: "running",
        label: result.success ? `Finished ${result.name}` : `Tool failed: ${result.name}`,
        error: result.success ? undefined : result.output.slice(0, 240),
      });
      resolveToolCall(assistantMsgId, result.name, result.output, result.success);

      if (
        result.success && (
          result.name === "write_file" ||
          result.name === "bash" ||
          result.name === "fetch_pdb"
        )
      ) {
        const pathMatch = result.output.match(
          /(?:saved?|wrote|created|output|Downloaded)\s*(?:to\s+)?:?\s*([^\s,]+\.(?:pdb|cif|mmcif|fasta|fa|csv|tsv|png|jpg|jpeg|gif|svg|json|py|ipynb|txt|md|html|htm))/i
        );
        if (pathMatch) {
          const filePath = pathMatch[1];
          const fileName = filePath.split("/").pop() || filePath;
          const artifactType = getArtifactType(fileName);
          const isImage = artifactType === "image";
          const artifact: Artifact = {
            id: generateId(),
            name: fileName,
            type: artifactType,
            path: filePath,
            ...(isImage
              ? { previewUrl: `/api/files/serve?path=${encodeURIComponent(filePath)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}` }
              : {}),
          };
          addArtifact(artifact);
        }
      }
    },
    onArtifact: (artifact: Artifact) => {
      addArtifact(artifact);
      // Subagent artifacts arrive without a select_artifact event, so parallel
      // subagents cannot fight over the viewer. Open the first one when the
      // viewer is empty: otherwise the user is told the structure is displayed
      // while the panel still says "Select a file to preview".
      if (!useAppStore.getState().selectedArtifact) selectArtifact(artifact);
    },
    onSelectArtifact: (artifact: Artifact) => {
      addArtifact(artifact);
      selectArtifact(artifact);
    },
    onPlan: (steps: PlanStep[]) => {
      setPlan(steps);
    },
    onComputeJob: (job: ComputeJob) => {
      useComputeJobsStore.getState().addJob(job);
    },
    onApprovalRequired: (approval: ApprovalRequest) => {
      if (lastApprovalCommandRef.current === approval.command) return;
      lastApprovalCommandRef.current = approval.command;
      const isToolReview = approval.reason === "tool_review";
      const display = approval.displayCommand || approval.command;
      updateRunStatus({
        phase: "paused",
        label: isToolReview ? "Paused for tool review" : "Paused for approval",
        error: approval.message || display,
      });
      setPendingApproval({ ...approval, sessionId, messageToSend, metadata });
      appendToContentBlock(
        assistantMsgId,
        `\n\n**${isToolReview ? "Tool review approval required" : "Sandbox approval required"}**\n\n\`\`\`\n${display}\n\`\`\``
      );
      setAgentThinking(false);
    },
    onError: (error: string) => {
      // Model not configured (no key / endpoint) or the provider rejected the
      // key: point the user at Settings instead of a bare HTTP status.
      const looksLikeAuth = /\b(401|403)\b|invalid api key|incorrect api key|authentication|unauthorized|api key/i.test(error);
      if (error.startsWith("CONFIG_ERROR:") || looksLikeAuth) {
        let message = "The chat model is not configured. Open Settings → API to choose a provider and enter a key.";
        if (error.startsWith("CONFIG_ERROR:")) {
          try {
            const data = JSON.parse(error.slice("CONFIG_ERROR:".length));
            if (data.error) message = data.error;
          } catch {}
        } else {
          message = `The model provider rejected the request (${error.slice(0, 160)}). Check the provider, key, and model in Settings → API.`;
        }
        setConfigBanner(message);
        updateMessage(assistantMsgId, { isStreaming: false });
        updateRunStatus({ phase: "error", label: "Model not configured", error: message });
        setIsStreaming(false);
        setAgentThinking(false);
        return;
      }
      if (error.startsWith("LIMIT_EXCEEDED:")) {
        let limitError = "Usage limit exceeded";
        try {
          const data = JSON.parse(error.slice("LIMIT_EXCEEDED:".length));
          limitError = data.error || limitError;
          setLimitBanner({ error: data.error, limitType: data.limitType || "tokens" });
        } catch {
          setLimitBanner({ error: limitError, limitType: "tokens" });
        }
        updateMessage(assistantMsgId, { isStreaming: false });
        updateRunStatus({
          phase: "error",
          label: "Usage limit",
          error: limitError,
        });
        setIsStreaming(false);
        setAgentThinking(false);
        return;
      }
      appendToContentBlock(assistantMsgId, `\n\n**Error:** ${error}`);
      updateRunStatus({
        phase: "error",
        label: "Stream error",
        error,
      });
      setAgentThinking(false);
    },
    onDone: () => {
      updateMessage(assistantMsgId, { isStreaming: false });
      updateRunStatus({
        phase: "completed",
        label: "Done",
        error: undefined,
      });
      setIsStreaming(false);
      setAgentThinking(false);
      abortRef.current = null;
      saveActiveSession({ includeMessages: false });
      if (sessionId) {
        fetchFileList(sessionId).then((files) => setWorkspaceFiles(files)).catch(() => {});
      }
    },
  }), [
    appendToContentBlock,
    appendToReasoningBlock,
    addToolCall,
    resolveToolCall,
    addArtifact,
    selectArtifact,
    setPlan,
    updateMessage,
    updateRunStatus,
    setAgentThinking,
    saveActiveSession,
    setWorkspaceFiles,
    handleRunEvent,
    recordSubagentEvent,
  ]);

  const structureSelection = useAppStore((s) => s.structureSelection);
  const attachStructureSelection = useAppStore((s) => s.attachStructureSelection);
  const setAttachStructureSelection = useAppStore((s) => s.setAttachStructureSelection);
  const setStructureSelection = useAppStore((s) => s.setStructureSelection);

  const handleSubmit = useCallback(async () => {
    const content = inputValue.trim();
    if (!content || isStreaming) return;
    // A new turn should snap to the bottom even if the user had scrolled up.
    pinnedToBottomRef.current = true;
    lastApprovalCommandRef.current = null;
    setPendingApproval(null);

    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = createSession();
    }

    // Upload any pending files and include their paths in the message
    // On-demand context condensation (like dsh's /compact).
    if (/^\/compact\b/i.test(content.trim())) {
      setInputValue("");
      if (!sessionId) return;
      updateRunStatus({ phase: "running", label: "Compacting context", retryCount: 0, error: undefined });
      try {
        const res = await fetch("/api/chat/compact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        const data = await res.json();
        const text = !res.ok
          ? `Compaction failed: ${data.error || res.statusText}`
          : data.compacted
            ? `Context compacted: ${data.summarizedMessages} earlier messages condensed (${data.summaryMode === "model" ? "model summary" : "deterministic summary"}), ~${Math.round((data.originalApproxTokens || 0) / 1000)}k → ~${Math.round((data.compactedApproxTokens || 0) / 1000)}k tokens. The summary is used from the next message on.`
            : `Nothing compacted: ${data.reason || "not enough history"}.`;
        addMessage({ id: generateId(), role: "assistant", content: text, timestamp: Date.now() });
        updateRunStatus({ phase: "completed", label: "Context compacted", error: undefined });
      } catch (err) {
        addMessage({ id: generateId(), role: "assistant", content: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
        updateRunStatus({ phase: "error", label: "Compaction failed", error: String(err) });
      }
      return;
    }

    let messageToSend = content;
    if (pendingFiles.length > 0) {
      const uploadedPaths: string[] = [];
      for (const file of pendingFiles) {
        try {
          const artifact = await uploadFile(file, sessionId || undefined);
          addArtifact(artifact);
          uploadedPaths.push(`- ${artifact.path} (${artifact.type}, ${file.size} bytes)`);
        } catch {
          uploadedPaths.push(`- ${file.name} (upload failed)`);
        }
      }
      setPendingFiles([]);
      messageToSend = `${content}\n\n<uploaded_files>\nThe following files have been uploaded to the workspace. Use read_file to read their content:\n${uploadedPaths.join("\n")}\n</uploaded_files>`;
    }

    const isFirstMessage = messages.length === 0;

    const userMsg: Message = {
      id: generateId(),
      role: "user",
      content,
      timestamp: Date.now(),
    };
    addMessage(userMsg);
    setInputValue("");
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
    requestAnimationFrame(() => scrollToBottom());

    // Generate title immediately for new sessions (non-blocking, before agent starts)
    if (isFirstMessage && sessionId) {
      generateTitle(sessionId, content);
    }

    setIsStreaming(true);
    setAgentThinking(true);
    updateRunStatus({
      phase: "running",
      label: "Starting run",
      retryCount: 0,
      error: undefined,
    });

    const assistantMsg: Message = {
      id: generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
      artifacts: [],
      contentBlocks: [],
    };
    addMessage(assistantMsg);

    const controller = new AbortController();
    abortRef.current = controller;

    // Attach the Mol* selection (if any) as structured context for the model.
    const submitMetadata: Record<string, unknown> | undefined =
      attachStructureSelection && structureSelection
        ? { structureSelection }
        : undefined;

    await sendMessage(
      sessionId!,
      messageToSend,
      buildStreamCallbacks(assistantMsg.id, sessionId!, messageToSend, submitMetadata),
      activeSkills.length > 0 ? activeSkills : undefined,
      controller.signal,
      undefined,
      undefined,
      submitMetadata
    );
  }, [
    structureSelection,
    attachStructureSelection,
    inputValue,
    isStreaming,
    activeSessionId,
    createSession,
    addMessage,
    setInputValue,
    setAgentThinking,
    updateMessage,
    updateRunStatus,
    addArtifact,
    generateTitle,
    pendingFiles,
    activeSkills,
    messages,
    buildStreamCallbacks,
  ]);

  // Auto-continue: when a tracked background job finishes and the user is
  // viewing that job's conversation, inject a synthetic turn so the agent
  // imports and summarizes the results — just like receiving a new user prompt.
  const autoContinueJob = useCallback(async (job: ComputeJob) => {
    if (isStreaming) return;
    const sessionId = job.sessionId;
    const prompt = job.provider === "wemol"
      ? `The WeMol job \`${job.id}\` (${job.label}) has finished. ` +
        `Download and analyze its results: run \`wemol_cli\` with \`job download ${job.id}\` and \`job result ${job.id}\`, ` +
        `read the output files, save any structures or data files with save_artifact, ` +
        `then give a concise summary of the key results.`
      : `The ${computeJobProviderLabel(job.provider)} job \`${job.id}\` (${job.label}) has finished. ` +
        `Import its results with import_compute_artifacts (provider "${job.provider}", job_id "${job.id}"), ` +
        `read the output files, save any structures or data files with save_artifact, ` +
        `then give a concise summary of the key results.`;
    const metadata = {
      hiddenUserMessage: true,
      source: "compute_job_auto_continue",
      computeJobId: job.id,
      computeJobProvider: job.provider,
    };

    setIsStreaming(true);
    setAgentThinking(true);
    updateRunStatus({
      phase: "running",
      label: "Starting run",
      retryCount: 0,
      error: undefined,
    });

    const assistantMsg: Message = {
      id: generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
      artifacts: [],
      contentBlocks: [],
    };
    addMessage(assistantMsg);

    const controller = new AbortController();
    abortRef.current = controller;

    await sendMessage(
      sessionId,
      prompt,
      buildStreamCallbacks(assistantMsg.id, sessionId, prompt, metadata),
      activeSkills.length > 0 ? activeSkills : undefined,
      controller.signal,
      undefined,
      undefined,
      metadata
    );
  }, [isStreaming, addMessage, setAgentThinking, updateRunStatus, activeSkills, buildStreamCallbacks]);

  // Fire the auto-continue for a finished job in the *currently viewed* session.
  const trackedJobs = useComputeJobsStore((s) => s.jobs);
  useEffect(() => {
    if (isStreaming || !activeSessionId) return;
    const job = trackedJobs.find(
      (j) => j.status === "done" && !j.continued && j.sessionId === activeSessionId
    );
    if (!job) return;
    // Mark first (synchronously) so this effect can't double-fire for the job.
    useComputeJobsStore.getState().updateJob(job.id, { continued: true });
    void autoContinueJob(job);
  }, [trackedJobs, activeSessionId, isStreaming, autoContinueJob]);

  const handleApproveCommand = useCallback(async () => {
    if (!pendingApproval || isStreaming) return;
    lastApprovalCommandRef.current = null;
    setPendingApproval(null);
    setIsStreaming(true);
    setAgentThinking(true);
    updateRunStatus({
      phase: "running",
      label: "Resuming with approval",
      retryCount: 0,
      error: undefined,
    });

    const assistantMsg: Message = {
      id: generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
      artifacts: [],
      contentBlocks: [],
    };
    addMessage(assistantMsg);

    const controller = new AbortController();
    abortRef.current = controller;

    await sendMessage(
      pendingApproval.sessionId,
      pendingApproval.messageToSend,
      buildStreamCallbacks(assistantMsg.id, pendingApproval.sessionId, pendingApproval.messageToSend),
      activeSkills.length > 0 ? activeSkills : undefined,
      controller.signal,
      [pendingApproval.command],
      undefined,
      pendingApproval.metadata
    );
  }, [
    pendingApproval,
    isStreaming,
    setAgentThinking,
    updateRunStatus,
    addMessage,
    buildStreamCallbacks,
    activeSkills,
  ]);

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
    setAgentThinking(false);
    updateRunStatus({
      phase: "error",
      label: "Stopped",
      error: "Run stopped by user",
    });
    // Save what we have so far
    saveActiveSession({ includeMessages: false });
    // Refresh workspace file list
    if (activeSessionId) {
      fetchFileList(activeSessionId).then((files) => setWorkspaceFiles(files)).catch(() => {});
    }
  }, [setAgentThinking, updateRunStatus, saveActiveSession, activeSessionId, setWorkspaceFiles]);

  const handleShare = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: activeSessionId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to share");
        return;
      }
      const { id } = await res.json();
      const url = `${window.location.origin}/share/${id}`;
      await navigator.clipboard.writeText(url);
      alert("Share link copied to clipboard!");
    } catch {
      alert("Failed to share conversation");
    }
  }, [activeSessionId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
    if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileSelect = (files: FileList | null) => {
    if (!files) return;
    const fileArray = Array.from(files);
    setPendingFiles((prev) => [...prev, ...fileArray]);
  };

  const handleFileUpload = async (file: File) => {
    try {
      const artifact = await uploadFile(file, activeSessionId || undefined);
      addArtifact(artifact);
      return artifact;
    } catch {
      return null;
    }
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  };

  return (
    <div
      className={`flex flex-col flex-1 min-h-0 bg-bg-secondary ${isDragOver ? "ring-2 ring-inset ring-accent/50" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept=".pdb,.cif,.mmcif,.fasta,.fa,.faa,.csv,.tsv,.json,.py,.ipynb,.png,.jpg,.txt,.md,.vcf,.h5ad,.xlsx,.xls,.bed,.gff,.gtf,.bam,.fastq,.fq"
        onChange={(e) => handleFileSelect(e.target.files)}
      />

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg-primary/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-accent">
            <Upload className="w-12 h-12" />
            <span className="text-lg font-medium">Drop files here</span>
            <span className="text-sm text-text-secondary">
              PDB, FASTA, CSV, VCF, H5AD, and more
            </span>
          </div>
        </div>
      )}

      {/* Header — pl-14 / pr-20 leave room for the floating toggle buttons in page.tsx.
          It is a container query root so the pill and chip collapse before the
          title does when the chat column is narrow. */}
      <div className="@container flex items-center gap-2 pl-14 pr-20 py-3 border-b border-border min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FlaskConical className={`w-5 h-5 flex-shrink-0 text-accent${isStreaming ? " agent-breathing" : ""}`} />
          <span className="hidden @[400px]:inline font-semibold text-text-primary truncate whitespace-nowrap">ChatMol Lab</span>
          {isStreaming ? (
            <span className="status-working inline-flex flex-shrink-0 items-center gap-1.5 text-xs text-accent bg-accent/10 border border-accent/20 px-2.5 py-0.5 rounded-full whitespace-nowrap">
              <svg className="spinner-ring w-3 h-3" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
                <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Working&hellip;
            </span>
          ) : (
            <span className="hidden @[520px]:inline-flex flex-shrink-0 text-xs text-text-muted bg-bg-tertiary px-2 py-0.5 rounded-full whitespace-nowrap">
              Research Assistant
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 min-w-0">
          <WorkspaceChip
            sessionId={activeSessionId}
            compact
            onChanged={() => {
              if (activeSessionId) {
                fetchFileList(activeSessionId).then((files) => setWorkspaceFiles(files)).catch(() => {});
              }
            }}
          />
          {messages.some((m) => m.toolCalls && m.toolCalls.length > 0) && (
            <button
              onClick={() => setCollapseKey((k) => k + 1)}
              className="text-xs text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-hover flex-shrink-0"
              title="Collapse all tools"
            >
              <ChevronsDownUp className="w-3.5 h-3.5" />
            </button>
          )}
          {messages.length > 0 && !isStreaming && (
            <button
              onClick={handleShare}
              className="text-xs text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-hover flex-shrink-0"
              title="Share conversation"
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {runStatus && (isStreaming || runStatus.phase !== "completed") && (
        <RunStatusBar status={runStatus} />
      )}

      {/* Messages */}
      <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className="flex-1 min-h-0 overflow-y-auto py-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <FlaskConical className="w-16 h-16 text-accent-dim mb-4" />
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              ChatMol Lab
            </h2>
            <p className="text-text-secondary text-sm max-w-md mb-6">
              AI research assistant for computational biology and protein design.
              Structure prediction, sequence design, molecular dynamics, and 50+
              biological databases.
            </p>
            <div className="grid grid-cols-2 gap-2 max-w-lg w-full">
              {[
                "Design a binder for PDB 1PGA using RFDiffusion",
                "Predict the structure of MKWVTFISLLFLFSSAYS with OpenFold2",
                "Fold a protein complex with Boltz2",
                "Search PubMed for recent CRISPR prime editing papers",
              ].map((suggestion, i) => (
                <button
                  key={i}
                  onClick={() => setInputValue(suggestion)}
                  className="text-left text-xs p-3 bg-bg-tertiary border border-border rounded-lg hover:border-accent-dim transition-colors text-text-secondary hover:text-text-primary"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} collapseKey={collapseKey} />
        ))}

        {isAgentThinking && <TypingIndicator />}
        <div ref={messagesEndRef} />
      </div>
      {showJumpToBottom && messages.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              pinnedToBottomRef.current = true;
              setShowJumpToBottom(false);
              scrollToBottom("smooth");
            }}
            className="absolute -top-10 left-1/2 z-10 -translate-x-1/2 flex items-center gap-1 rounded-full border border-border bg-bg-secondary/95 px-3 py-1 text-xs text-text-secondary shadow-lg backdrop-blur hover:text-text-primary"
            title="Jump to latest"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            {isStreaming ? "Follow output" : "Latest"}
          </button>
        </div>
      )}

      {/* Model not configured banner */}
      {configBanner && (
        <div className="mx-4 mb-2 flex items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
          <ShieldAlert className="w-5 h-5 text-warning flex-shrink-0" />
          <div className="flex-1 text-sm text-text-primary">{configBanner}</div>
          <button
            type="button"
            onClick={() => { setSettingsOpen(true); }}
            className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-bg-primary hover:bg-accent-hover transition-colors"
          >
            Open Settings
          </button>
          <button
            onClick={() => setConfigBanner(null)}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Limit exceeded banner */}
      {limitBanner && (
        <div className="mx-4 mb-2 flex items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
          <Zap className="w-5 h-5 text-warning flex-shrink-0" />
          <div className="flex-1 text-sm">
            <span className="text-warning font-medium">{limitBanner.error}</span>
          </div>
          <button
            onClick={() => setLimitBanner(null)}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Tool / sandbox approval */}
      {pendingApproval && (
        <div className="mx-4 mb-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
          <div className="flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-warning">
                {pendingApproval.reason === "tool_review"
                  ? "Tool review approval required"
                  : "Sandbox approval required"}
              </div>
              <div className="mt-1 text-xs text-text-secondary">
                {pendingApproval.message || (
                  pendingApproval.reason === "tool_review"
                    ? "Approve this tool call to resume the turn:"
                    : "Approve this command to resume the turn:"
                )}
              </div>
              <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-bg-primary border border-border p-2 text-xs font-mono text-text-primary whitespace-pre-wrap break-all">
                {pendingApproval.displayCommand || pendingApproval.command}
              </pre>
            </div>
            <button
              onClick={handleApproveCommand}
              disabled={isStreaming}
              className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-md bg-warning text-bg-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              Approve
            </button>
            <button
              onClick={() => setPendingApproval(null)}
              className="p-1 text-text-muted hover:text-text-primary transition-colors"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="p-4 border-t border-border">
        <div className="overflow-hidden rounded-[28px] border border-border bg-bg-tertiary/95 shadow-[0_18px_48px_rgba(0,0,0,0.22)] transition-colors focus-within:border-accent/70">
          {structureSelection && (
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
              <div
                className={`flex min-w-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs ${
                  attachStructureSelection
                    ? "border-accent/60 bg-accent/10"
                    : "border-border bg-bg-primary opacity-70"
                }`}
                title={attachStructureSelection ? "This selection will be sent with your message" : "Selection not attached"}
              >
                <Atom className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                <span className="max-w-[320px] truncate text-text-primary">
                  {describeSelection(structureSelection)}
                </span>
                <button
                  type="button"
                  onClick={() => setAttachStructureSelection(!attachStructureSelection)}
                  className="ml-1 text-[10px] uppercase tracking-wide text-text-muted transition-colors hover:text-text-primary"
                  title={attachStructureSelection ? "Detach from next message" : "Attach to next message"}
                >
                  {attachStructureSelection ? "attached" : "detached"}
                </button>
                <button
                  type="button"
                  onClick={() => setStructureSelection(null)}
                  className="text-text-muted transition-colors hover:text-error"
                  title="Clear selection context"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {pendingFiles.map((file, i) => (
                <div
                  key={i}
                  className="flex min-w-0 items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-2.5 py-1.5 text-xs"
                >
                  <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                  <span className="max-w-[160px] truncate text-text-primary">
                    {file.name}
                  </span>
                  <button
                    onClick={() => removePendingFile(i)}
                    className="text-text-muted transition-colors hover:text-error"
                    title="Remove file"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            placeholder="Ask me anything..."
            rows={1}
            className="block w-full max-h-32 resize-none bg-transparent px-5 pb-2 pt-4 text-sm leading-6 text-text-primary outline-none placeholder-text-muted"
            style={{ minHeight: "24px", overflowY: "hidden" }}
            onInput={(e) => resizeInputTextarea(e.currentTarget)}
          />
          {memoryNotice && (
            <div className="mb-2 flex items-start justify-between gap-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-text-secondary">
              <div>
                ChatMol now remembers reusable knowledge across sessions (saved: {memoryNotice.join(", ")}).
                Review, edit or turn it off in Settings → Memory.
              </div>
              <button
                type="button"
                className="text-text-muted hover:text-text-primary"
                title="Dismiss"
                onClick={() => {
                  try {
                    window.localStorage.setItem("chatmol.memoryNoticeShown", "1");
                  } catch {
                    // ignore
                  }
                  setMemoryNotice(null);
                }}
              >
                ×
              </button>
            </div>
          )}
          {activeSkills.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pb-2">
              {activeSkills.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-lg bg-accent/10 px-2 py-1 text-xs text-accent"
                >
                  @{id}
                  <button
                    onClick={() => removeActiveSkill(id)}
                    className="transition-colors hover:text-text-primary"
                    title="Remove skill"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-3 px-3 pb-3">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
                title="Attach file"
              >
                <Plus className="h-5 w-5" />
              </button>
              <button
                onClick={() => setSkillPickerOpen(true)}
                className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                  activeSkills.length > 0
                    ? "bg-accent/10 text-accent"
                    : "text-text-muted hover:bg-bg-hover hover:text-text-secondary"
                }`}
                title="Mention skill"
              >
                <AtSign className="h-5 w-5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <ModelBadge />
              <button
                onClick={isStreaming ? handleStop : handleSubmit}
                disabled={!inputValue.trim() && !isStreaming}
                className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                  isStreaming
                    ? "border border-error text-error hover:bg-error/10"
                    : inputValue.trim()
                      ? "bg-accent text-bg-primary hover:bg-accent-hover"
                      : "bg-bg-primary text-text-muted"
                }`}
                title={isStreaming ? "Stop" : "Send"}
              >
                {isStreaming ? (
                  <Square className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
        <p className="text-center text-[10px] text-text-muted mt-1.5 leading-tight">
          Research preview — do not upload sensitive data. AI-generated content may be inaccurate, always verify.
        </p>
      </div>
      <SkillPicker
        open={skillPickerOpen}
        onClose={() => setSkillPickerOpen(false)}
        onSelect={setActiveSkills}
        selectedSkills={activeSkills}
      />
    </div>
  );
}
