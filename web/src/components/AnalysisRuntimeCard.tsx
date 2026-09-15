"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleX, Loader2, Microscope } from "lucide-react";

interface AnalysisStatus {
  ready: boolean;
  python: string | null;
  script: string | null;
  reason?: string;
  versions?: { biotite?: string; python?: string };
  requirements: string[];
  install?: { ok: boolean; log: string; dsspInstalled: boolean };
}

/**
 * Settings → General card for the structure-analysis backend. The packages
 * install themselves on first use; this card exists so the state is visible
 * and can be repaired or upgraded to full DSSP without running a tool.
 */
export default function AnalysisRuntimeCard() {
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");

  const load = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`/api/analysis${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (res.ok) setStatus(await res.json());
    } catch {
      // leave the previous state in place
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const install = useCallback(async (dssp: boolean) => {
    setBusy(true);
    setLog("");
    try {
      const res = await fetch("/api/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install", dssp }),
      });
      const data = (await res.json()) as AnalysisStatus;
      setStatus(data);
      if (data.install && !data.install.ok) setLog(data.install.log.slice(-1200));
    } catch (err) {
      setLog(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Microscope className="w-4 h-4 text-text-primary" />
        <h3 className="text-lg font-medium text-text-primary">Structure analysis</h3>
      </div>
      <p className="text-xs text-text-muted mb-2">
        Secondary structure, RMSD, interface contacts, surface area and model confidence run locally through
        biotite and Biopython in the bundled runtime. They install themselves the first time the agent uses
        <code className="mx-1">analyze_structure</code>.
      </p>

      <div className="flex items-start gap-2 text-xs">
        {status?.ready ? (
          <CircleCheck className="w-3.5 h-3.5 mt-0.5 text-success flex-shrink-0" />
        ) : (
          <CircleX className="w-3.5 h-3.5 mt-0.5 text-text-muted flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          {status?.ready ? (
            <span className="text-text-primary">
              Ready{status.versions?.biotite ? ` — biotite ${status.versions.biotite}, Python ${status.versions.python}` : ""}
            </span>
          ) : (
            <span className="text-text-muted">{status?.reason || "Not installed yet"}</span>
          )}
          {status && !status.ready && status.requirements?.length > 0 && (
            <div className="text-text-muted font-mono mt-0.5">{status.requirements.join(", ")}</div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => install(false)}
          className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-xs text-text-secondary hover:border-accent/40 hover:text-text-primary disabled:opacity-50"
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          {status?.ready ? "Reinstall" : "Install now"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => install(true)}
          title="Adds mkdssp from conda-forge for full 8-state DSSP codes instead of 3-state assignment"
          className="rounded border border-border px-2.5 py-1 text-xs text-text-secondary hover:border-accent/40 hover:text-text-primary disabled:opacity-50"
        >
          Add full DSSP
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => load(true)}
          className="text-xs text-text-muted hover:text-text-primary disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {log && <pre className="mt-2 max-h-32 overflow-auto rounded bg-bg-tertiary p-2 text-[10px] text-text-muted whitespace-pre-wrap">{log}</pre>}
    </div>
  );
}
