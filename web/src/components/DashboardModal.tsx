"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Activity, Terminal, Clock, MessageSquare, Hash, Sparkles } from "lucide-react";

interface UsageStats {
  today: { llmCalls: number; toolCalls: number; tokens: number; inputTokens: number; outputTokens: number };
  week: { llmCalls: number; toolCalls: number; tokens: number; sessions: number; avgLatencyMs: number };
  topTools: { tool: string; calls: number; avgMs: number }[];
}

interface DashboardModalProps {
  open: boolean;
  onClose: () => void;
}

interface ActivityReport {
  report: string;
  generatedAt?: string;
  source?: "llm" | "fallback";
  model?: string;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-primary p-4">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold text-text-primary tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[10px] text-text-muted">{sub}</div>}
    </div>
  );
}

export default function DashboardModal({ open, onClose }: DashboardModalProps) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [report, setReport] = useState<ActivityReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setStats(null);
    setReport(null);

    const cacheBust = Date.now();
    const fetchFresh = (url: string) =>
      fetch(`${url}?t=${cacheBust}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));

    Promise.all([
      fetchFresh("/api/usage"),
      fetchFresh("/api/usage/report"),
    ])
      .then(([statsData, reportData]) => {
        if (statsData) setStats(statsData);
        if (reportData?.report) setReport(reportData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const maxToolCalls = stats?.topTools.reduce((m, t) => Math.max(m, t.calls), 0) || 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-bg-secondary border border-border rounded-xl shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <Activity className="w-4 h-4 text-accent" />
            <h2 className="text-base font-semibold text-text-primary">Dashboard</h2>
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted border border-border">
              local workbench
            </span>
          </div>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text-primary transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-accent" />
            </div>
          ) : !stats && !report ? (
            <div className="py-16 text-center text-sm text-text-muted">No usage data yet.</div>
          ) : (
            <>
              {/* Today */}
              {stats && (
                <section>
                  <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                    Today
                  </h3>
                  <div className="grid grid-cols-3 gap-3">
                    <Stat
                      icon={<Hash className="w-3 h-3" />}
                      label="Tokens"
                      value={fmtNum(stats.today.tokens)}
                      sub={`${fmtNum(stats.today.inputTokens)} in · ${fmtNum(stats.today.outputTokens)} out`}
                    />
                    <Stat icon={<MessageSquare className="w-3 h-3" />} label="LLM calls" value={fmtNum(stats.today.llmCalls)} />
                    <Stat icon={<Terminal className="w-3 h-3" />} label="Tool calls" value={fmtNum(stats.today.toolCalls)} />
                  </div>
                </section>
              )}

              {/* Last 7 days */}
              {stats && (
                <section>
                  <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">Last 7 days</h3>
                  <div className="grid grid-cols-4 gap-3">
                    <Stat icon={<MessageSquare className="w-3 h-3" />} label="Sessions" value={fmtNum(stats.week.sessions)} />
                    <Stat icon={<Terminal className="w-3 h-3" />} label="Tool calls" value={fmtNum(stats.week.toolCalls)} />
                    <Stat icon={<Hash className="w-3 h-3" />} label="Tokens" value={fmtNum(stats.week.tokens)} />
                    <Stat icon={<Clock className="w-3 h-3" />} label="Avg latency" value={fmtMs(stats.week.avgLatencyMs)} />
                  </div>
                </section>
              )}

              {/* Top tools */}
              {stats && stats.topTools.length > 0 && (
                <section>
                  <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">Top tools · 7d</h3>
                  <div className="rounded-lg border border-border bg-bg-primary divide-y divide-border">
                    {stats.topTools.map((t) => (
                      <div key={t.tool} className="flex items-center gap-3 px-3 py-2">
                        <code className="w-40 flex-shrink-0 truncate font-mono text-xs text-text-secondary">{t.tool}</code>
                        <div className="flex-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                          <div className="h-full rounded-full bg-accent/70" style={{ width: `${(t.calls / maxToolCalls) * 100}%` }} />
                        </div>
                        <span className="w-10 text-right font-mono text-xs text-text-primary tabular-nums">{t.calls}</span>
                        <span className="w-12 text-right font-mono text-[10px] text-text-muted tabular-nums">{fmtMs(t.avgMs)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* AI summary */}
              {report && (
                <section>
                  <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-text-muted">
                    <Sparkles className="w-3 h-3 text-accent" />
                    Recent activity
                  </h3>
                  <div className="rounded-lg border border-accent/20 bg-accent/[0.04] p-4">
                    <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-line">{report.report}</p>
                    <p className="mt-3 font-mono text-[10px] text-text-muted">
                      {report.source === "llm" ? `generated by ${report.model || "the configured model"}` : "generated locally"}
                      {report.generatedAt ? ` · ${new Date(report.generatedAt).toLocaleString()}` : ""}
                    </p>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
