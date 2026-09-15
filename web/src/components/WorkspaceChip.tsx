"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, X } from "lucide-react";

import { fetchSessionWorkspace, setSessionWorkspace, type SessionWorkspaceInfo } from "@/lib/api";
import { isElectronClient } from "@/lib/electron";

interface WorkspaceChipProps {
  sessionId: string | null;
  /** Called after the workspace folder changed (refresh file lists etc.). */
  onChanged?: () => void;
  /** Icon-only chip below ~520px container width (label stays in the tooltip). */
  compact?: boolean;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Header chip showing which folder the current session works in, with a
 * popover to pick another folder (native dialog on desktop, path input on
 * the web) or go back to the managed default.
 */
export default function WorkspaceChip({ sessionId, onChanged, compact = false }: WorkspaceChipProps) {
  const [info, setInfo] = useState<SessionWorkspaceInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!sessionId) {
      setInfo(null);
      return;
    }
    const next = await fetchSessionWorkspace(sessionId);
    setInfo(next);
    setPathInput(next?.isCustom ? next.path : "");
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const apply = useCallback(async (folder: string | null, create = false) => {
    if (!sessionId) return;
    setBusy(true);
    setError("");
    try {
      const next = await setSessionWorkspace(sessionId, folder, { create });
      setInfo(next);
      setPathInput(next.isCustom ? next.path : "");
      setOpen(false);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [sessionId, onChanged]);

  const chooseNative = useCallback(async () => {
    const api = (window as unknown as { electronAPI?: { chooseDirectory?: (o?: { defaultPath?: string }) => Promise<string | null> } }).electronAPI;
    if (!api?.chooseDirectory) return;
    const picked = await api.chooseDirectory({ defaultPath: info?.isCustom ? info.path : undefined });
    if (picked) await apply(picked);
  }, [apply, info]);

  if (!sessionId || !info) return null;

  const label = info.isCustom ? basename(info.path) : "default workspace";
  const canChoose = info.canChoose || isElectronClient();

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${
          info.isCustom ? "bg-accent/15 text-text-primary" : "bg-bg-tertiary text-text-muted hover:text-text-primary"
        }`}
        title={info.path}
      >
        <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
        <span className={`max-w-[140px] truncate ${compact ? "hidden @[520px]:inline" : ""}`}>{label}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-[min(360px,calc(100vw-2rem))] rounded-lg border border-border bg-bg-secondary p-3 shadow-xl">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-text-primary">Session workspace</div>
            <button type="button" onClick={() => setOpen(false)} className="text-text-muted hover:text-text-primary">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-1 break-all font-mono text-[11px] text-text-muted">{info.path}</div>
          <p className="mt-2 text-[11px] text-text-muted">
            Files the agent reads, writes, and runs live here. Point it at a project folder to work on your own data in place.
          </p>

          {canChoose ? (
            <div className="mt-3 space-y-2">
              {isElectronClient() && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={chooseNative}
                  className="w-full rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
                >
                  Choose folder…
                </button>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  placeholder="/path/to/project"
                  className="min-w-0 flex-1 rounded border border-border bg-bg-tertiary px-2 py-1 font-mono text-[11px] text-text-primary focus:border-accent/50 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={busy || !pathInput.trim()}
                  onClick={() => apply(pathInput.trim(), true)}
                  className="rounded border border-border px-2 py-1 text-xs text-text-secondary hover:border-accent/40 disabled:opacity-50"
                >
                  Use
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-[11px] text-amber-400/90">
              Custom folders are available in the desktop app. Hosted sessions use the managed workspace.
            </p>
          )}

          {info.isCustom && (
            <button
              type="button"
              disabled={busy}
              onClick={() => apply(null)}
              className="mt-2 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-50"
            >
              Reset to default workspace
            </button>
          )}
          {error && <div className="mt-2 text-[11px] text-red-400">{error}</div>}
        </div>
      )}
    </div>
  );
}
