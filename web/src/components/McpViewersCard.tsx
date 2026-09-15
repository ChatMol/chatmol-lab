"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

interface PresetStatus {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  scriptPath: string | null;
  python: string | null;
  viewerPath: string | null;
  mcpModule: boolean | null;
  ready: boolean;
  hints: string[];
}

interface CustomServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

interface PresetsResponse {
  python: string | null;
  mcpModule: boolean | null;
  presets: PresetStatus[];
  custom: CustomServer[];
  install?: { ok: boolean; log: string };
  error?: string;
}

/**
 * Settings card for the bundled molecular-viewer MCP servers (PyMOL, ChimeraX)
 * plus a raw JSON editor for user-defined stdio MCP servers.
 */
export default function McpViewersCard() {
  const [data, setData] = useState<PresetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string>("");
  const [customJson, setCustomJson] = useState<string>("");
  const [customError, setCustomError] = useState<string>("");
  const [showCustom, setShowCustom] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/mcp/presets${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (res.ok) {
        const json: PresetsResponse = await res.json();
        setData(json);
        setCustomJson(JSON.stringify(json.custom.map(({ id, name, command, args, enabled }) => ({ id, name, command, args, enabled })), null, 2));
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const post = useCallback(async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const res = await fetch("/api/mcp/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json: PresetsResponse = await res.json();
      if (res.ok) {
        setData(json);
        if (json.install) setInstallLog(json.install.log || "");
      } else {
        setCustomError(json.error || "Request failed");
      }
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }, []);

  const saveCustom = useCallback(async () => {
    setCustomError("");
    let servers: unknown;
    try {
      servers = JSON.parse(customJson || "[]");
    } catch (err) {
      setCustomError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!Array.isArray(servers)) {
      setCustomError("Expected a JSON array of servers.");
      return;
    }
    await post({ action: "set-custom", servers }, "custom");
  }, [customJson, post]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-medium text-text-primary">Molecular viewers (MCP)</h3>
        <button
          type="button"
          onClick={() => load(true)}
          className="p-1.5 text-text-muted hover:text-text-primary rounded"
          title="Re-check"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-xs text-text-muted mb-3">
        Let the agent drive a live PyMOL or ChimeraX window on this computer through the bundled
        MCP servers (from ChatMol/molecule-mcp). Enabled viewers appear to the agent as{" "}
        <code className="bg-bg-tertiary px-1 rounded">mcp__pymol__*</code> /{" "}
        <code className="bg-bg-tertiary px-1 rounded">mcp__chimerax__*</code> tools.
      </p>

      {data?.mcpModule === false && (
        <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-text-secondary">
          <div className="mb-2">
            The Python package <code className="bg-bg-tertiary px-1 rounded">mcp</code> is not installed in{" "}
            <span className="font-mono">{data.python}</span>.
          </div>
          <button
            type="button"
            disabled={busy === "install"}
            onClick={() => post({ action: "install-mcp" }, "install")}
            className="px-3 py-1.5 rounded bg-accent text-white text-xs disabled:opacity-50"
          >
            {busy === "install" ? "Installing…" : "Install Python MCP package"}
          </button>
        </div>
      )}
      {installLog && (
        <pre className="mb-3 max-h-32 overflow-auto rounded bg-bg-primary p-2 text-[10px] text-text-muted whitespace-pre-wrap">{installLog}</pre>
      )}

      <div className="space-y-2">
        {(data?.presets || []).map((preset) => (
          <div key={preset.id} className="rounded-lg border border-border bg-bg-tertiary p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${preset.ready ? "bg-green-500" : preset.enabled ? "bg-amber-500" : "bg-text-muted"}`} />
                  <span className="text-sm font-medium text-text-primary">{preset.label}</span>
                  {preset.enabled && (
                    <span className="text-[10px] uppercase tracking-wide text-accent">enabled</span>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-1">{preset.description}</p>
                <div className="mt-1 text-[11px] font-mono text-text-muted break-all">
                  {preset.viewerPath ? `app: ${preset.viewerPath}` : "app: not found"}
                </div>
                {preset.hints.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[11px] text-amber-400/90">
                    {preset.hints.map((h) => (
                      <li key={h}>• {h}</li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                type="button"
                disabled={busy === preset.id}
                onClick={() => post({ action: "toggle", id: preset.id, enabled: !preset.enabled }, preset.id)}
                className={`flex-shrink-0 px-3 py-1.5 rounded text-xs border transition-colors ${
                  preset.enabled
                    ? "border-accent bg-accent/10 text-text-primary"
                    : "border-border text-text-secondary hover:border-accent/40"
                } disabled:opacity-50`}
              >
                {busy === preset.id ? "…" : preset.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          </div>
        ))}
        {!data && !loading && (
          <div className="text-xs text-text-muted">Status unavailable.</div>
        )}
      </div>

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowCustom((v) => !v)}
          className="text-xs text-accent hover:underline"
        >
          {showCustom ? "Hide" : "Show"} custom MCP servers (JSON)
        </button>
        {showCustom && (
          <div className="mt-2 space-y-2">
            <p className="text-[11px] text-text-muted">
              Any stdio MCP server, e.g.{" "}
              <code className="bg-bg-tertiary px-1 rounded">{`[{"id":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/data"],"enabled":true}]`}</code>
            </p>
            <textarea
              value={customJson}
              onChange={(e) => setCustomJson(e.target.value)}
              rows={6}
              spellCheck={false}
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-xs text-text-primary font-mono focus:outline-none focus:border-accent/50"
            />
            {customError && <div className="text-xs text-red-400">{customError}</div>}
            <button
              type="button"
              disabled={busy === "custom"}
              onClick={saveCustom}
              className="px-3 py-1.5 rounded bg-accent text-white text-xs disabled:opacity-50"
            >
              {busy === "custom" ? "Saving…" : "Save custom servers"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
