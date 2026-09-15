"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useAppStore } from "@/lib/store";

interface MemoryRow {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  scope: "global" | "workspace";
  path: string;
  content: string;
  updatedAt: string | null;
}

interface MemoryResponse {
  enabled: boolean;
  entries: MemoryRow[];
  error?: string;
}

const TYPE_LABEL: Record<MemoryRow["type"], string> = {
  user: "user",
  feedback: "feedback",
  project: "project",
  reference: "reference",
};

/**
 * Settings → Memory: what the agent remembers across sessions (global and for
 * the active session's workspace), with edit / delete and a master toggle.
 */
export default function MemoryCard() {
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const [data, setData] = useState<MemoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ description: string; content: string }>({ description: "", content: "" });

  const query = activeSessionId ? `?sessionId=${encodeURIComponent(activeSessionId)}` : "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/memory${query}`, { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleEnabled = useCallback(async (enabled: boolean) => {
    setBusy("toggle");
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryEnabled: enabled }),
      });
      if (!res.ok) setError("Could not update the setting.");
      else setData((prev) => (prev ? { ...prev, enabled } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }, []);

  const save = useCallback(async (row: MemoryRow) => {
    setBusy(row.name);
    setError("");
    try {
      const res = await fetch("/api/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSessionId || undefined,
          name: row.name,
          scope: row.scope,
          type: row.type,
          description: draft.description,
          content: draft.content,
        }),
      });
      const json: MemoryResponse = await res.json();
      if (res.ok) {
        setData(json);
        setOpen(null);
      } else {
        setError(json.error || "Save failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }, [activeSessionId, draft]);

  const remove = useCallback(async (row: MemoryRow) => {
    setBusy(`rm:${row.name}`);
    setError("");
    try {
      const res = await fetch(`/api/memory?name=${encodeURIComponent(row.name)}&scope=${row.scope}${activeSessionId ? `&sessionId=${encodeURIComponent(activeSessionId)}` : ""}`, { method: "DELETE" });
      const json: MemoryResponse = await res.json();
      if (res.ok) setData(json);
      else setError(json.error || "Delete failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }, [activeSessionId]);

  const enabled = data?.enabled ?? true;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-medium text-text-primary">Memory</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy === "toggle"}
              onClick={() => toggleEnabled(!enabled)}
              className={`px-3 py-1.5 rounded text-xs border transition-colors ${
                enabled ? "border-accent bg-accent/10 text-text-primary" : "border-border text-text-secondary hover:border-accent/40"
              } disabled:opacity-50`}
            >
              {busy === "toggle" ? "…" : enabled ? "Enabled" : "Disabled"}
            </button>
            <button type="button" onClick={() => load()} className="p-1.5 text-text-muted hover:text-text-primary rounded" title="Refresh">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <p className="text-xs text-text-muted">
          What the agent remembers across sessions: your research goals and preferences, corrections on how to work,
          project files and job IDs, and hard-won WeMol / database details. The index is shown to the agent every turn;
          after each run a small model distills new entries. Files live in{" "}
          <code className="bg-bg-tertiary px-1 rounded">~/.chatmol-lab/memory</code> (global) and{" "}
          <code className="bg-bg-tertiary px-1 rounded">&lt;workspace&gt;/.chatmol/memory</code> (this session), one
          markdown file per entry. Credentials are never stored.
        </p>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="space-y-1.5">
        {(data?.entries || []).map((row) => {
          const isOpen = open === row.name;
          return (
            <div key={`${row.scope}:${row.name}`} className="rounded-lg border border-border bg-bg-tertiary px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    if (isOpen) {
                      setOpen(null);
                    } else {
                      setOpen(row.name);
                      setDraft({ description: row.description, content: row.content });
                    }
                  }}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono text-text-primary">{row.name}</span>
                    <span className="text-[10px] text-text-muted border border-border rounded px-1">{TYPE_LABEL[row.type]}</span>
                    <span className="text-[10px] text-text-muted border border-border rounded px-1">{row.scope}</span>
                  </div>
                  <div className="text-[11px] text-text-muted mt-0.5">{row.description}</div>
                </button>
                <button
                  type="button"
                  disabled={busy === `rm:${row.name}`}
                  onClick={() => remove(row)}
                  className="p-1.5 rounded text-text-muted hover:text-red-400 disabled:opacity-50"
                  title="Forget"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {isOpen && (
                <div className="mt-2 space-y-2">
                  <input
                    value={draft.description}
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                    className="w-full px-2 py-1.5 bg-bg-primary border border-border rounded text-xs text-text-primary focus:outline-none focus:border-accent/50"
                  />
                  <textarea
                    value={draft.content}
                    onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                    rows={6}
                    spellCheck={false}
                    className="w-full px-2 py-1.5 bg-bg-primary border border-border rounded text-xs text-text-primary font-mono focus:outline-none focus:border-accent/50"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy === row.name}
                      onClick={() => save(row)}
                      className="px-3 py-1.5 rounded bg-accent text-white text-xs disabled:opacity-50"
                    >
                      {busy === row.name ? "Saving…" : "Save"}
                    </button>
                    <span className="text-[10px] font-mono text-text-muted break-all">{row.path}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {data && data.entries.length === 0 && (
          <div className="text-xs text-text-muted">Nothing remembered yet. Entries appear after runs that produce reusable knowledge, or when the agent saves one explicitly.</div>
        )}
      </div>
    </div>
  );
}
