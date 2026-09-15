"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";

interface PluginRow {
  key: string;
  name: string;
  version: string | null;
  description: string | null;
  dir: string;
  source: "bundled" | "installed" | "linked";
  origin: string | null;
  enabled: boolean;
  error: string | null;
  skills: string[];
  agents: string[];
  mcpServers: string[];
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  source: string;
  modelInvocable: boolean;
  userInvocable: boolean;
}

interface AgentRow {
  id: string;
  name: string;
  description: string;
  source: string;
}

interface PluginsResponse {
  canManage: boolean;
  plugins: PluginRow[];
  skills: SkillRow[];
  agents: AgentRow[];
  installed?: string[];
  log?: string;
  error?: string;
}

const SOURCE_LABEL: Record<PluginRow["source"], string> = {
  bundled: "bundled",
  installed: "git",
  linked: "local folder",
};

function sourceLabel(source: string): string {
  if (source.startsWith("plugin:")) return source.slice("plugin:".length);
  return source;
}

/**
 * Settings card: installed plugins (skills / agents / MCP servers bundled in
 * Claude Code / Codex layout), plus the resulting skill and agent catalogs.
 */
export default function PluginsCard() {
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [log, setLog] = useState("");
  const [showSkills, setShowSkills] = useState(false);
  const [showAgents, setShowAgents] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/plugins", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const request = useCallback(async (key: string, init: RequestInit, url = "/api/plugins") => {
    setBusy(key);
    setError("");
    try {
      const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
      const json: PluginsResponse = await res.json();
      if (res.ok) {
        setData(json);
        if (json.log) setLog(json.log);
        return true;
      }
      setError(json.error || "Request failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
    return false;
  }, []);

  const install = useCallback(async () => {
    const value = source.trim();
    if (!value) return;
    const ok = await request("install", { method: "POST", body: JSON.stringify({ source: value }) });
    if (ok) setSource("");
  }, [request, source]);

  const canManage = data?.canManage ?? false;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-medium text-text-primary">Plugins</h3>
          <button
            type="button"
            onClick={() => load()}
            className="p-1.5 text-text-muted hover:text-text-primary rounded"
            title="Refresh"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-xs text-text-muted mb-3">
          A plugin is a folder with <code className="bg-bg-tertiary px-1 rounded">skills/</code> (Agent Skills,{" "}
          <code className="bg-bg-tertiary px-1 rounded">SKILL.md</code>),{" "}
          <code className="bg-bg-tertiary px-1 rounded">agents/</code> (subagents) and{" "}
          <code className="bg-bg-tertiary px-1 rounded">.mcp.json</code> — the same layout Claude Code and Codex
          plugins use, so they work in both directions. Skills found in{" "}
          <code className="bg-bg-tertiary px-1 rounded">~/.agents/skills</code>,{" "}
          <code className="bg-bg-tertiary px-1 rounded">~/.claude/skills</code> and a session workspace&apos;s{" "}
          <code className="bg-bg-tertiary px-1 rounded">.agents/skills</code> are picked up too.
        </p>

        <div className="space-y-2">
          {(data?.plugins || []).map((plugin) => (
            <div key={plugin.key} className="rounded-lg border border-border bg-bg-tertiary p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`h-2 w-2 rounded-full ${plugin.error ? "bg-red-500" : plugin.enabled ? "bg-green-500" : "bg-text-muted"}`} />
                    <span className="text-sm font-medium text-text-primary">{plugin.name}</span>
                    {plugin.version && <span className="text-[11px] font-mono text-text-muted">v{plugin.version}</span>}
                    <span className="text-[10px] uppercase tracking-wide text-text-muted border border-border rounded px-1">
                      {SOURCE_LABEL[plugin.source]}
                    </span>
                  </div>
                  {plugin.description && <p className="text-xs text-text-muted mt-1">{plugin.description}</p>}
                  <div className="mt-1 text-[11px] text-text-muted">
                    {plugin.skills.length} skills · {plugin.agents.length} agents · {plugin.mcpServers.length} MCP servers
                  </div>
                  <div className="mt-0.5 text-[11px] font-mono text-text-muted break-all">{plugin.origin || plugin.dir}</div>
                  {plugin.error && <div className="mt-1 text-[11px] text-red-400">{plugin.error}</div>}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!canManage || busy === plugin.key}
                    onClick={() => request(plugin.key, { method: "PATCH", body: JSON.stringify({ key: plugin.key, enabled: !plugin.enabled }) })}
                    className={`px-3 py-1.5 rounded text-xs border transition-colors ${
                      plugin.enabled
                        ? "border-accent bg-accent/10 text-text-primary"
                        : "border-border text-text-secondary hover:border-accent/40"
                    } disabled:opacity-50`}
                  >
                    {busy === plugin.key ? "…" : plugin.enabled ? "Disable" : "Enable"}
                  </button>
                  {plugin.source !== "bundled" && (
                    <button
                      type="button"
                      disabled={!canManage || busy === `rm:${plugin.key}`}
                      onClick={() => request(`rm:${plugin.key}`, { method: "DELETE" }, `/api/plugins?key=${encodeURIComponent(plugin.key)}`)}
                      className="p-1.5 rounded text-text-muted hover:text-red-400 disabled:opacity-50"
                      title={plugin.source === "installed" ? "Remove (deletes the clone)" : "Unlink (keeps the folder)"}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {data && data.plugins.length === 0 && (
            <div className="text-xs text-text-muted">No plugins found.</div>
          )}
        </div>

        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") install(); }}
              disabled={!canManage}
              placeholder="https://github.com/ChatMol/ChatMol-Skills  or  /absolute/path/to/plugin"
              className="flex-1 px-3 py-2 bg-bg-primary border border-border rounded-lg text-xs text-text-primary font-mono focus:outline-none focus:border-accent/50 disabled:opacity-50"
            />
            <button
              type="button"
              disabled={!canManage || busy === "install" || !source.trim()}
              onClick={install}
              className="px-3 py-1.5 rounded bg-accent text-white text-xs disabled:opacity-50"
            >
              {busy === "install" ? "Installing…" : "Install"}
            </button>
          </div>
          {!canManage && data && (
            <p className="text-[11px] text-text-muted">
              Installing and toggling plugins is available in the desktop app (or with{" "}
              <code className="bg-bg-tertiary px-1 rounded">CHATMOL_ALLOW_PLUGIN_INSTALL=1</code> on a server).
            </p>
          )}
          {error && <div className="text-xs text-red-400">{error}</div>}
          {log && (
            <pre className="max-h-24 overflow-auto rounded bg-bg-primary p-2 text-[10px] text-text-muted whitespace-pre-wrap">{log}</pre>
          )}
        </div>
      </div>

      <div>
        <button type="button" onClick={() => setShowSkills((v) => !v)} className="text-sm font-medium text-text-primary hover:text-accent">
          {showSkills ? "▾" : "▸"} Skills ({data?.skills.length ?? 0})
        </button>
        <p className="text-[11px] text-text-muted mt-1">
          The agent sees every skill&apos;s name and description and loads the full instructions with the{" "}
          <code className="bg-bg-tertiary px-1 rounded">skill</code> tool when relevant. Type{" "}
          <code className="bg-bg-tertiary px-1 rounded">/skill-name</code> at the start of a message to invoke one yourself.
        </p>
        {showSkills && (
          <div className="mt-2 space-y-1">
            {(data?.skills || []).map((skill) => (
              <div key={skill.id} className="rounded border border-border bg-bg-tertiary px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono text-text-primary">{skill.id}</span>
                  <span className="text-[10px] text-text-muted border border-border rounded px-1">{sourceLabel(skill.source)}</span>
                  {!skill.modelInvocable && <span className="text-[10px] text-amber-400">user-only</span>}
                  {!skill.userInvocable && <span className="text-[10px] text-text-muted">model-only</span>}
                </div>
                <div className="text-[11px] text-text-muted mt-0.5 line-clamp-2">{skill.description}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <button type="button" onClick={() => setShowAgents((v) => !v)} className="text-sm font-medium text-text-primary hover:text-accent">
          {showAgents ? "▾" : "▸"} Subagents ({data?.agents.length ?? 0})
        </button>
        <p className="text-[11px] text-text-muted mt-1">
          Subagents are <code className="bg-bg-tertiary px-1 rounded">agents/&lt;id&gt;.md</code> files (name, description,
          tools, model, skills). Every discovered agent is available to the main agent through <code className="bg-bg-tertiary px-1 rounded">run_subagent</code>.
        </p>
        {showAgents && (
          <div className="mt-2 space-y-1">
            {(data?.agents || []).map((agent) => (
              <div key={agent.id} className="rounded border border-border bg-bg-tertiary px-3 py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono text-text-primary">{agent.id}</span>
                  <span className="text-xs text-text-secondary">{agent.name}</span>
                  <span className="text-[10px] text-text-muted border border-border rounded px-1">{sourceLabel(agent.source)}</span>
                </div>
                <div className="text-[11px] text-text-muted mt-0.5 line-clamp-2">{agent.description}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
