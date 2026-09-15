"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  FlaskConical,
  CheckCircle2,
  XCircle,
  Terminal,
  ChevronRight,
  ChevronDown,
  Share2,
} from "lucide-react";
import type { Message, ToolCall, ContentBlock, PlanStep, Artifact } from "@/lib/types";

// --- Shared data shape from the API ---
interface SharedData {
  id: string;
  title: string;
  messages: Message[];
  plan: PlanStep[];
  artifacts: Artifact[];
  createdAt: number;
}

// --- Rendering components (standalone, no store) ---

function TextBlock({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="markdown-body text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const isError = toolCall.status === "error";
  const hasOutput = toolCall.result || toolCall.errorOutput;

  const argsPreview = toolCall.name === "bash" && toolCall.arguments.command
    ? String(toolCall.arguments.command)
    : Object.entries(toolCall.arguments || {})
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n");

  return (
    <div className={`my-1.5 rounded-lg border overflow-hidden ${isError ? "border-error/30" : "border-border"}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-2 px-3 py-2 w-full text-left text-xs transition-colors ${
          isError ? "bg-error/5 hover:bg-error/10" : "bg-bg-tertiary hover:bg-bg-hover"
        }`}
      >
        {isError
          ? <XCircle className="w-3.5 h-3.5 text-error" />
          : <CheckCircle2 className="w-3.5 h-3.5 text-success" />}
        <Terminal className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        <span className="font-mono font-medium text-text-primary">{toolCall.name}</span>
        <span className="text-text-muted truncate flex-1 font-mono">
          {toolCall.name === "bash" && toolCall.arguments.command
            ? String(toolCall.arguments.command).slice(0, 80)
            : Object.entries(toolCall.arguments || {})
                .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 30) : JSON.stringify(v).slice(0, 30)}`)
                .join(" ")
                .slice(0, 80)}
        </span>
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />}
      </button>
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
        </div>
      )}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  return (
    <details className="my-1 text-xs text-text-secondary">
      <summary className="cursor-pointer select-none opacity-70 hover:opacity-100 transition-opacity">
        Thinking ({text.length} chars)
      </summary>
      <div className="mt-1 pl-3 border-l-2 border-border whitespace-pre-wrap opacity-60 max-h-40 overflow-y-auto">
        {text}
      </div>
    </details>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const toolCallsMap = new Map((message.toolCalls || []).map((tc) => [tc.id, tc]));
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
            {message.contentBlocks!.map((block: ContentBlock, i: number) => {
              if (block.type === "reasoning") {
                return <ReasoningBlock key={`r-${i}`} text={block.text} />;
              }
              if (block.type === "text") {
                return <TextBlock key={`t-${i}`} text={block.text} />;
              }
              if (block.type === "tool_use") {
                const tc = toolCallsMap.get(block.toolCallId);
                if (tc && tc.name === "create_plan") return null;
                return tc ? <ToolCallBlock key={`tc-${tc.id}`} toolCall={tc} /> : null;
              }
              return null;
            })}
          </div>
        ) : (
          <>
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="space-y-1 mb-2">
                {message.toolCalls.filter((tc) => tc.name !== "create_plan").map((tc) => (
                  <ToolCallBlock key={tc.id} toolCall={tc} />
                ))}
              </div>
            )}
            {message.content && (
              <div className="markdown-body text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {message.content}
                </ReactMarkdown>
              </div>
            )}
          </>
        )}

        {message.artifacts && message.artifacts.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {message.artifacts.map((artifact) => (
              <span
                key={artifact.id}
                className="flex items-center gap-2 px-3 py-1.5 bg-bg-tertiary border border-border rounded-lg text-xs"
              >
                <FlaskConical className="w-3.5 h-3.5 text-accent" />
                <span className="text-text-primary">{artifact.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Main page ---

export default function SharedChatPage() {
  const params = useParams();
  const id = params.id as string;
  const [data, setData] = useState<SharedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/share/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "Shared chat not found" : "Failed to load");
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-text-muted text-sm">Loading shared chat...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-center">
          <div className="text-error text-lg mb-2">{error || "Not found"}</div>
          <a href="/" className="text-accent text-sm hover:underline">Go to ChatMol Lab</a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg-secondary border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Share2 className="w-4 h-4 text-accent" />
          <h1 className="text-sm font-medium text-text-primary truncate max-w-[600px]">
            {data.title}
          </h1>
          <span className="text-xs text-text-muted">
            Shared {new Date(data.createdAt).toLocaleDateString()}
          </span>
        </div>
        <a
          href="/"
          className="text-xs text-accent hover:underline"
        >
          Open ChatMol Lab
        </a>
      </div>

      {/* Messages */}
      <div className="max-w-4xl mx-auto py-4">
        {data.messages.map((msg, i) => (
          <MessageBubble key={msg.id || `msg-${i}`} message={msg} />
        ))}
      </div>

      {/* Footer */}
      <div className="text-center py-6 text-xs text-text-muted border-t border-border">
        This is a read-only shared conversation from <a href="/" className="text-accent hover:underline">ChatMol Lab</a>
      </div>
    </div>
  );
}
