"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  MessageSquare,
  Send,
  Terminal,
  XCircle,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { SubagentRun, SubagentTraceItem } from "@/lib/types";
import {
  countToolCalls,
  describeLastActivity,
  formatDuration,
  formatToolArgsPreview,
  groupSubagentTrace,
  type SubagentTraceEntry,
} from "@/lib/subagent-trace";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const STATUS_LABEL: Record<SubagentRun["status"], string> = {
  running: "Running",
  completed: "Completed",
  error: "Failed",
};

const STATUS_TEXT: Record<SubagentRun["status"], string> = {
  running: "text-warning",
  completed: "text-success",
  error: "text-error",
};

function StatusIcon({ status, className = "h-3.5 w-3.5" }: { status: SubagentRun["status"]; className?: string }) {
  if (status === "running") return <Loader2 className={`${className} animate-spin text-warning`} />;
  if (status === "completed") return <CheckCircle2 className={`${className} text-success`} />;
  return <XCircle className={`${className} text-error`} />;
}

/** Ticks once a second while `active` so elapsed times stay live. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function elapsedFor(run: SubagentRun, now: number): string {
  const end = run.status === "running" ? now : run.updatedAt;
  return formatDuration(end - run.startedAt);
}

function formatTraceForContext(trace: SubagentTraceItem[]): string {
  return trace
    .slice(-40)
    .map((item) => {
      if (item.type === "tool_call") {
        return `[tool_call:${item.toolName || "tool"}]\n${JSON.stringify(item.arguments || {}, null, 2)}`;
      }
      if (item.type === "tool_result") {
        return `[tool_result:${item.toolName || "tool"}:${item.success === false ? "failed" : "success"}]\n${item.content || ""}`;
      }
      return `[${item.type}${item.title ? `:${item.title}` : ""}]\n${item.content || ""}`;
    })
    .join("\n\n---\n\n")
    .slice(-24000);
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function RunRow({ run, now, onOpen }: { run: SubagentRun; now: number; onOpen: () => void }) {
  const toolCount = countToolCalls(run.trace);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-start gap-2.5 border-b border-border/60 px-3 py-2.5 text-left transition-colors hover:bg-bg-hover"
    >
      <div className="mt-0.5 shrink-0">
        <StatusIcon status={run.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-xs leading-snug text-text-primary">{run.task || run.name}</div>
        <div className="mt-1 flex items-center gap-1 text-[11px] text-text-muted">
          <span className="truncate">{run.name}</span>
          <span className="opacity-60">·</span>
          <span className="shrink-0">{toolCount} {toolCount === 1 ? "tool" : "tools"}</span>
          <span className="opacity-60">·</span>
          <span className="shrink-0 tabular-nums">{elapsedFor(run, now)}</span>
        </div>
        <div className={`mt-0.5 truncate text-[11px] ${run.status === "running" ? "text-text-secondary" : STATUS_TEXT[run.status]}`}>
          {describeLastActivity(run)}
        </div>
      </div>
      <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function RunList({ runs, now, onOpen }: { runs: SubagentRun[]; now: number; onOpen: (id: string) => void }) {
  const counts = useMemo(() => {
    const result = { running: 0, completed: 0, error: 0 };
    for (const run of runs) result[run.status] += 1;
    return result;
  }, [runs]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5 text-[11px] text-text-muted">
        {counts.running > 0 && (
          <span className="flex items-center gap-1 text-warning">
            <Loader2 className="h-3 w-3 animate-spin" />
            {counts.running} running
          </span>
        )}
        {counts.completed > 0 && (
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {counts.completed} done
          </span>
        )}
        {counts.error > 0 && (
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-error" />
            {counts.error} failed
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs.map((run) => (
          <RunRow key={run.id} run={run} now={now} onOpen={() => onOpen(run.id)} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function ToolEntry({ call, result }: { call?: SubagentTraceItem; result?: SubagentTraceItem }) {
  const toolName = call?.toolName || result?.toolName || "tool";
  const failed = result?.success === false;
  const pending = Boolean(call) && !result;
  const [expanded, setExpanded] = useState(failed);
  const argsPreview = formatToolArgsPreview(toolName, call?.arguments);
  const argsFull = call?.arguments && Object.keys(call.arguments).length > 0
    ? toolName === "bash" && typeof call.arguments.command === "string"
      ? call.arguments.command
      : JSON.stringify(call.arguments, null, 2)
    : "";

  return (
    <div className={`overflow-hidden rounded-md border ${failed ? "border-error/30" : "border-border"}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
          failed ? "bg-error/5 hover:bg-error/10" : "bg-bg-tertiary hover:bg-bg-hover"
        }`}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" />
        ) : failed ? (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-error" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        )}
        <Terminal className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="max-w-[60%] shrink-0 truncate font-mono font-medium text-text-primary">{toolName}</span>
        <span className="min-w-0 flex-1 basis-0 truncate font-mono text-text-muted">{argsPreview}</span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-border">
          {argsFull && (
            <div className="bg-bg-secondary px-2.5 py-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">Input</div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-text-secondary">
                {argsFull}
              </pre>
            </div>
          )}
          {result?.content && (
            <div className={`border-t border-border px-2.5 py-2 ${failed ? "bg-error/5" : "bg-bg-primary"}`}>
              <div className={`mb-1 text-[10px] font-medium uppercase tracking-wider ${failed ? "text-error" : "text-text-muted"}`}>
                {failed ? "Error" : "Output"}
              </div>
              <pre className={`max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] ${
                failed ? "text-error" : "text-text-secondary"
              }`}>
                {result.content}
              </pre>
            </div>
          )}
          {pending && (
            <div className="flex items-center gap-2 bg-bg-primary px-2.5 py-2 text-[11px] text-warning">
              <Loader2 className="h-3 w-3 animate-spin" />
              Running…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageEntry({ item, defaultCollapsed }: { item: SubagentTraceItem; defaultCollapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const failed = item.success === false;

  if (item.type === "user") {
    return (
      <div className="rounded-md border border-accent/25 bg-accent/5 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-accent">
          <MessageSquare className="h-3.5 w-3.5" />
          {item.title || "You"}
        </div>
        <div className="whitespace-pre-wrap break-words text-xs text-text-primary">{item.content}</div>
      </div>
    );
  }

  if (item.type === "assistant") {
    const isFinal = item.title === "Final summary";
    return (
      <div className={`px-2.5 py-2 ${isFinal ? "rounded-md border border-success/25 bg-success/5" : "border-l-2 border-border pl-2.5"}`}>
        <div className={`mb-1 flex items-center gap-1.5 text-[11px] font-medium ${isFinal ? "text-success" : "text-text-secondary"}`}>
          <Bot className="h-3.5 w-3.5" />
          {item.title || "Assistant"}
        </div>
        <div className="markdown-body markdown-compact text-text-primary">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content || ""}</ReactMarkdown>
        </div>
      </div>
    );
  }

  // status
  const hasContent = Boolean(item.content && item.content.trim());
  return (
    <div className={`rounded-md border px-2.5 py-1.5 ${failed ? "border-error/30 bg-error/5" : "border-border/60 bg-bg-tertiary/60"}`}>
      <button
        type="button"
        onClick={() => hasContent && setCollapsed((v) => !v)}
        className={`flex w-full items-center gap-1.5 text-left text-[11px] font-medium ${failed ? "text-error" : "text-text-muted"}`}
      >
        {failed ? <XCircle className="h-3.5 w-3.5 shrink-0" /> : <Info className="h-3.5 w-3.5 shrink-0" />}
        <span className="flex-1">{item.title || "Status"}</span>
        {hasContent && (collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)}
      </button>
      {hasContent && !collapsed && (
        <pre className={`mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] ${
          failed ? "text-error" : "text-text-secondary"
        }`}>
          {item.content}
        </pre>
      )}
    </div>
  );
}

function TraceEntryView({ entry }: { entry: SubagentTraceEntry }) {
  if (entry.kind === "tool") return <ToolEntry call={entry.call} result={entry.result} />;
  // The header already shows the task, so the initial "Task" note starts collapsed.
  const defaultCollapsed = entry.item.type === "status" && entry.item.title === "Task";
  return <MessageEntry item={entry.item} defaultCollapsed={defaultCollapsed} />;
}

function RunDetail({
  run,
  now,
  onBack,
  onSend,
  sending,
}: {
  run: SubagentRun;
  now: number;
  onBack: () => void;
  onSend: (text: string) => void;
  sending: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [taskExpanded, setTaskExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const entries = useMemo(() => groupSubagentTrace(run.trace), [run.trace]);
  const toolCount = countToolCalls(run.trace);
  const lastItem = run.trace[run.trace.length - 1];
  const waitingOnModel = run.status === "running" && (!lastItem || lastItem.type !== "tool_call");

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [run.trace.length, run.status]);

  const submit = () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    stickToBottom.current = true;
    onSend(text);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-2 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onBack}
            className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            title="Back to all subagents"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <StatusIcon status={run.status} />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text-primary">{run.name}</span>
          <span className={`shrink-0 text-[11px] ${STATUS_TEXT[run.status]}`}>{STATUS_LABEL[run.status]}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-text-muted">{elapsedFor(run, now)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1 pl-7 text-[11px] text-text-muted">
          {run.model && (
            <>
              <span className="truncate font-mono">{run.model}</span>
              <span className="opacity-60">·</span>
            </>
          )}
          <span className="shrink-0">{toolCount} {toolCount === 1 ? "tool call" : "tool calls"}</span>
        </div>
        {run.task && (
          <button
            type="button"
            onClick={() => setTaskExpanded((v) => !v)}
            className={`mt-1.5 w-full pl-7 text-left text-xs leading-snug text-text-secondary ${taskExpanded ? "" : "line-clamp-2"}`}
            title={taskExpanded ? "Collapse task" : "Show full task"}
          >
            {run.task}
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2.5 py-2"
      >
        {entries.length === 0 && run.status === "running" && (
          <div className="py-6 text-center text-xs text-text-muted">Waiting for the subagent to start…</div>
        )}
        {entries.map((entry, index) => (
          <TraceEntryView
            key={entry.kind === "tool" ? (entry.call?.id || entry.result?.id || index) : entry.item.id}
            entry={entry}
          />
        ))}
        {waitingOnModel && entries.length > 0 && (
          <div className="flex items-center gap-2 px-1 py-1 text-[11px] text-warning">
            <Loader2 className="h-3 w-3 animate-spin" />
            Thinking…
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={`Message ${run.name}…`}
            className="max-h-24 min-h-[34px] flex-1 resize-none rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary outline-none transition-colors placeholder:text-text-muted/70 focus:border-accent/50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || sending}
            className="rounded-md bg-accent p-1.5 text-bg-primary transition-opacity hover:bg-accent-hover disabled:opacity-40"
            title="Send to subagent"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function SubagentsPanel() {
  const {
    getActiveSession,
    activeSessionId,
    upsertSubagentRun,
    appendSubagentTrace,
    updateSubagentRun,
  } = useAppStore();
  const session = getActiveSession();
  const runs = useMemo(
    () => [...(session?.subagentRuns || [])].sort((a, b) => b.startedAt - a.startedAt),
    [session?.subagentRuns],
  );
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [sendingRunId, setSendingRunId] = useState<string | null>(null);
  const anyRunning = runs.some((run) => run.status === "running");
  const now = useNow(anyRunning);

  const openRun = openRunId ? runs.find((run) => run.id === openRunId) || null : null;

  // Leave the detail view when the session changes or the run disappears.
  useEffect(() => {
    setOpenRunId(null);
  }, [activeSessionId]);
  useEffect(() => {
    if (openRunId && !runs.some((run) => run.id === openRunId)) setOpenRunId(null);
  }, [runs, openRunId]);

  const applySubagentEvent = (sessionId: string, event: Record<string, unknown>) => {
    const runId = typeof event.subagentRunId === "string" ? event.subagentRunId : "";
    if (!runId) return;
    const agentId = typeof event.agentId === "string" ? event.agentId : "subagent";
    const name = typeof event.name === "string" ? event.name : agentId;
    const ts = Date.now();
    if (event.event === "subagent_start") {
      upsertSubagentRun(sessionId, {
        id: runId,
        agentId,
        name,
        model: typeof event.model === "string" ? event.model : undefined,
        task: typeof event.task === "string" ? event.task : "",
        status: "running",
        startedAt: ts,
        updatedAt: ts,
        trace: [],
      });
      return;
    }
    if (event.event === "subagent_trace") {
      const item = event.item;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        appendSubagentTrace(sessionId, runId, item as SubagentTraceItem);
      }
      return;
    }
    if (event.event === "subagent_end") {
      updateSubagentRun(sessionId, runId, {
        status: event.status === "success" ? "completed" : "error",
        summary: typeof event.summary === "string" ? event.summary : undefined,
        error: typeof event.error === "string" ? event.error : undefined,
        updatedAt: ts,
      });
    }
  };

  const sendToSubagent = async (run: SubagentRun, text: string) => {
    if (!activeSessionId || sendingRunId) return;
    setSendingRunId(run.id);
    updateSubagentRun(activeSessionId, run.id, { status: "running", updatedAt: Date.now() });
    appendSubagentTrace(activeSessionId, run.id, {
      id: generateId(),
      type: "user",
      title: "You",
      content: text,
      ts: Date.now(),
    });

    try {
      const res = await fetch("/api/subagents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSessionId,
          agentId: run.agentId,
          runId: run.id,
          message: text,
          context: formatTraceForContext(run.trace),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Subagent request failed.");
      for (const event of Array.isArray(data.events) ? data.events : []) {
        applySubagentEvent(activeSessionId, event);
      }
    } catch (err: any) {
      updateSubagentRun(activeSessionId, run.id, {
        status: "error",
        error: err.message || "Subagent request failed.",
        updatedAt: Date.now(),
      });
      appendSubagentTrace(activeSessionId, run.id, {
        id: generateId(),
        type: "status",
        title: "Error",
        content: err.message || "Subagent request failed.",
        success: false,
        ts: Date.now(),
      });
    } finally {
      setSendingRunId(null);
    }
  };

  if (runs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-bg-secondary px-6 text-center">
        <Bot className="mb-3 h-8 w-8 text-text-muted" />
        <div className="text-sm text-text-muted">No subagents yet</div>
        <div className="mt-1 text-xs text-text-muted">
          Runs appear here when the conversation delegates work to a subagent.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-bg-secondary">
      {openRun ? (
        <RunDetail
          key={openRun.id}
          run={openRun}
          now={now}
          onBack={() => setOpenRunId(null)}
          onSend={(text) => void sendToSubagent(openRun, text)}
          sending={sendingRunId === openRun.id}
        />
      ) : (
        <RunList runs={runs} now={now} onOpen={setOpenRunId} />
      )}
    </div>
  );
}
