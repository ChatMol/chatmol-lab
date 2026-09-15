"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  Key,
  Cpu,
  Sparkles,
  LogOut,
  User as UserIcon,
  Eye,
  EyeOff,
  Check,
  Loader2,
  Zap,
  ExternalLink,
  CircleCheck,
  CircleX,
  Brain,
  Cloud,
  FolderOpen,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { isElectronClient } from "@/lib/electron";
import { useDeployment } from "@/lib/use-deployment";
import AnalysisRuntimeCard from "./AnalysisRuntimeCard";
import McpViewersCard from "./McpViewersCard";
import PluginsCard from "./PluginsCard";
import MemoryCard from "./MemoryCard";

interface ComputeProviderInfo {
  id: string;
  label: string;
  kind: "direct" | "local" | "gateway";
  capabilities: string[];
  availability: { ok: boolean; reason?: string };
}

interface RuntimeComponentStatus {
  path?: string;
  exists: boolean;
}

interface RuntimeStatus {
  isElectron: boolean;
  platform: string;
  activeBackend: "native" | "wsl" | "system";
  native: {
    prefix?: string;
    pathPrepend: string;
    conda: RuntimeComponentStatus;
    python: RuntimeComponentStatus;
    wemolCli: RuntimeComponentStatus;
    ready: boolean;
  };
  wsl: {
    ready: boolean;
    prefix: string;
    pathPrepend: string;
  };
}

interface ProviderInfo {
  id: string;
  label: string;
  note: string;
  keyUrl: string;
  envKey: string;
  defaultModel: string;
  defaultFastModel: string;
  models: { value: string; label: string }[];
  hasKey: boolean;
  maskedKey: string;
}

interface SettingsData {
  provider: string;
  providers: ProviderInfo[];
  apiKey: string;
  llmBaseUrl: string;
  model: string;
  fastModel: string;
  maxOutputTokens: number;
  toolReviewMode: "manual" | "reviewer" | "auto" | "unrestricted";
  computeBackend?: "direct" | "chatmol-cloud";
  chatmolBioApiKey?: string;
  chatmolBioBaseUrl?: string;
  wemolComputeProfile: "pre_experiment" | "industrial";
  shellPath: string;
  workspaceDir: string;
  mpnnPython: string;
  mpnnScript: string;
  systemPrompt: string;
  nvidiaApiKey: string;
  wemolUsername: string;
  wemolPassword: string;
  wemolStatus?: {
    state: "unknown" | "connected" | "error";
    checkedAt?: string;
    username?: string;
    cliVersion?: string;
    message?: string;
    accountOutput?: string;
  };
  runtime?: RuntimeStatus;
}

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const FALLBACK_PROVIDER: ProviderInfo = {
  id: "deepseek",
  label: "DeepSeek",
  note: "",
  keyUrl: "https://platform.deepseek.com/api_keys",
  envKey: "DEEPSEEK_API_KEY",
  defaultModel: "deepseek-v4-pro",
  defaultFastModel: "deepseek-v4-flash",
  models: [],
  hasKey: false,
  maskedKey: "",
};

function RuntimeRow({ label, value, ok }: { label: string; value?: string; ok?: boolean }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${ok ? "bg-green-500" : "bg-text-muted"}`} />
      <div className="min-w-0">
        <div className="font-medium text-text-secondary">{label}</div>
        <div className="font-mono text-text-muted break-all">{value || "not discovered"}</div>
      </div>
    </div>
  );
}

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { data: session } = useSession();
  const deployment = useDeployment();
  const [activeTab, setActiveTab] = useState<"general" | "api" | "skills" | "memory">(
    "general"
  );

  // API settings form state
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [formProvider, setFormProvider] = useState("deepseek");
  const [formApiKey, setFormApiKey] = useState("");
  const [formLlmBaseUrl, setFormLlmBaseUrl] = useState("");
  const [formModel, setFormModel] = useState("deepseek-v4-pro");
  const [formFastModel, setFormFastModel] = useState("");
  const [formMaxOutputTokens, setFormMaxOutputTokens] = useState(8192);
  const [formToolReviewMode, setFormToolReviewMode] = useState<"manual" | "reviewer" | "auto" | "unrestricted">("auto");
  const [formComputeBackend, setFormComputeBackend] = useState<"direct" | "chatmol-cloud">("direct");
  const [computeProviders, setComputeProviders] = useState<ComputeProviderInfo[] | null>(null);
  const [formWemolComputeProfile, setFormWemolComputeProfile] = useState<"pre_experiment" | "industrial">("pre_experiment");
  const [formShellPath, setFormShellPath] = useState("");
  const [formSystemPrompt, setFormSystemPrompt] = useState("");
  const [formNvidiaApiKey, setFormNvidiaApiKey] = useState("");
  const [formChatmolBioApiKey, setFormChatmolBioApiKey] = useState("");
  const [formChatmolBioBaseUrl, setFormChatmolBioBaseUrl] = useState("");
  const [showChatmolBioKey, setShowChatmolBioKey] = useState(false);
  const [formWemolUsername, setFormWemolUsername] = useState("");
  const [formWemolPassword, setFormWemolPassword] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showNvidiaKey, setShowNvidiaKey] = useState(false);
  const [showWemolPassword, setShowWemolPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">(
    "idle"
  );
  const [saveError, setSaveError] = useState("");
  const [loading, setLoading] = useState(false);

  // Modal GPU state
  const [modalInstalled, setModalInstalled] = useState(false);
  const [modalAuthenticated, setModalAuthenticated] = useState(false);
  const [modalVersion, setModalVersion] = useState("");
  const [modalTokenId, setModalTokenId] = useState("");
  const [modalSetupRunning, setModalSetupRunning] = useState(false);
  const [modalSetupLines, setModalSetupLines] = useState<
    { type: "output" | "url" | "done"; line?: string; url?: string; success?: boolean; message?: string }[]
  >([]);
  const [modalSetupDone, setModalSetupDone] = useState(false);
  const modalOutputRef = useRef<HTMLDivElement>(null);

  const fetchModalStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/modal-status");
      if (res.ok) {
        const data = await res.json();
        setModalInstalled(data.installed);
        setModalAuthenticated(data.authenticated);
        setModalVersion(data.version);
        setModalTokenId(data.tokenId);
      }
    } catch {}
  }, []);

  const startModalSetup = async () => {
    setModalSetupRunning(true);
    setModalSetupLines([]);
    setModalSetupDone(false);

    try {
      const res = await fetch("/api/settings/modal-setup", { method: "POST" });
      if (!res.body) {
        setModalSetupLines([{ type: "done", success: false, message: "No response from server." }]);
        setModalSetupDone(true);
        setModalSetupRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: [DONE]")) {
            continue;
          }
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6));
              setModalSetupLines((prev) => [...prev, event]);
              if (event.type === "done") {
                setModalSetupDone(true);
                setModalSetupRunning(false);
                if (event.success) {
                  // Refresh status after successful setup
                  fetchModalStatus();
                }
              }
            } catch {}
          }
        }
      }
    } catch {
      setModalSetupLines((prev) => [
        ...prev,
        { type: "done", success: false, message: "Network error during Modal setup." },
      ]);
      setModalSetupDone(true);
      setModalSetupRunning(false);
    }
  };

  // Auto-scroll modal output
  useEffect(() => {
    if (modalOutputRef.current) {
      modalOutputRef.current.scrollTop = modalOutputRef.current.scrollHeight;
    }
  }, [modalSetupLines]);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data: SettingsData = await res.json();
        setSettings(data);
        setFormApiKey(""); // Don't prefill with masked key
        setFormNvidiaApiKey(""); // Don't prefill with masked key
        setFormWemolUsername(data.wemolUsername || "");
        setFormWemolPassword(""); // Don't prefill
        setFormProvider(data.provider || "deepseek");
        setFormLlmBaseUrl(data.llmBaseUrl || "");
        setFormModel(data.model || "");
        setFormFastModel(data.fastModel || "");
        setFormMaxOutputTokens(data.maxOutputTokens || 8192);
        setFormToolReviewMode(data.toolReviewMode || "auto");
        setFormComputeBackend(data.computeBackend || "direct");
        setFormChatmolBioBaseUrl(data.chatmolBioBaseUrl || "");
        setFormChatmolBioApiKey("");
        setFormWemolComputeProfile(data.wemolComputeProfile || "pre_experiment");
        setFormShellPath(data.shellPath || "");
        setFormSystemPrompt(data.systemPrompt || "");
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchComputeProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/compute/providers", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setComputeProviders(Array.isArray(data.providers) ? data.providers : []);
      }
    } catch {
      // ignore
    }
  }, []);

  // Fetch settings and modal status when modal opens
  useEffect(() => {
    if (open) {
      fetchSettings();
      fetchModalStatus();
      fetchComputeProviders();
    }
  }, [open, fetchSettings, fetchModalStatus, fetchComputeProviders]);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus("idle");
    setSaveError("");
    try {
      const body: Record<string, unknown> = {
        provider: formProvider,
        llmBaseUrl: formLlmBaseUrl,
        model: formModel,
        fastModel: formFastModel,
        maxOutputTokens: formMaxOutputTokens,
        toolReviewMode: formToolReviewMode,
        computeBackend: formComputeBackend,
        wemolComputeProfile: formWemolComputeProfile,
        shellPath: formShellPath,
        systemPrompt: formSystemPrompt,
      };
      // Only send API keys if user typed new ones
      if (formApiKey) {
        body.apiKey = formApiKey;
      }
      if (formNvidiaApiKey) {
        body.nvidiaApiKey = formNvidiaApiKey;
      }
      if (formChatmolBioApiKey) {
        body.chatmolBioApiKey = formChatmolBioApiKey;
      }
      body.chatmolBioBaseUrl = formChatmolBioBaseUrl;
      if (formWemolUsername || formWemolPassword) {
        body.wemolUsername = formWemolUsername;
        body.wemolPassword = formWemolPassword;
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data: SettingsData = await res.json();
        setSettings(data);
        setFormApiKey("");
        setFormNvidiaApiKey("");
        setFormWemolPassword("");
        setFormWemolUsername(data.wemolUsername || "");
        setFormToolReviewMode(data.toolReviewMode || "auto");
        setFormComputeBackend(data.computeBackend || "direct");
        setFormWemolComputeProfile(data.wemolComputeProfile || "pre_experiment");
        fetchComputeProviders();
        setSaveStatus("success");
        setTimeout(() => setSaveStatus("idle"), 2000);
      } else {
        const err = await res.json();
        setSaveError(err.error || "Failed to save");
        setSaveStatus("error");
      }
    } catch {
      setSaveError("Network error");
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  // Bring-your-own-key is the product: the API tab is never plan-gated.
  const apiTabAllowed = true;

  const tabs = [
    { id: "general" as const, label: "General", icon: Cpu, disabled: false },
    { id: "api" as const, label: "API", icon: Key, disabled: !apiTabAllowed },
    { id: "skills" as const, label: "Plugins & Skills", icon: Sparkles, disabled: false },
    { id: "memory" as const, label: "Memory", icon: Brain, disabled: false },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-bg-secondary border border-border rounded-xl shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-xl font-semibold text-text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Tab sidebar */}
          <div className="w-44 border-r border-border p-3 space-y-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => !tab.disabled && setActiveTab(tab.id)}
                disabled={tab.disabled}
                className={`w-full flex items-start gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  tab.disabled
                    ? "opacity-40 cursor-not-allowed"
                    : activeTab === tab.id
                      ? "bg-accent/10 text-accent"
                      : "text-text-secondary hover:bg-bg-hover"
                }`}
              >
                <tab.icon className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  {tab.label}
                  {tab.disabled && (
                    <span className="block text-[10px] text-text-muted font-normal leading-tight">
                      {(tab as Record<string, unknown>).disabledReason as string || "coming soon..."}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === "general" && (
              <div className="space-y-6">
                {/* Workspace identity */}
                <div>
                  <h3 className="text-lg font-medium text-text-primary mb-3">
                    Workspace
                  </h3>
                  {deployment?.mode === "hosted" && session?.user ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 p-3 bg-bg-tertiary rounded-lg">
                        {session.user.image ? (
                          <img
                            src={session.user.image}
                            alt=""
                            className="w-10 h-10 rounded-full"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
                            <UserIcon className="w-5 h-5 text-accent" />
                          </div>
                        )}
                        <div>
                          <div className="font-medium text-text-primary">
                            {session.user.name}
                          </div>
                          {session.user.email && (
                            <div className="text-xs text-text-muted">
                              {session.user.email}
                            </div>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => signOut({ callbackUrl: "/auth/signin" })}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors text-sm"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Sign Out
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-3 p-3 bg-bg-tertiary rounded-lg">
                        <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
                          <FolderOpen className="w-5 h-5 text-accent" />
                        </div>
                        <div>
                          <div className="font-medium text-text-primary">Local workspace</div>
                          <div className="text-xs text-text-muted">
                            No ChatMol account is needed. Compute runs with the credentials you configure under API.
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 p-3 rounded-lg border border-border">
                        <Cloud className="w-4 h-4 text-text-muted flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-text-primary">
                            ChatMol Cloud
                            <span className={`ml-2 text-[11px] ${deployment?.cloud.connected ? "text-success" : "text-text-muted"}`}>
                              {deployment?.cloud.connected ? "Connected" : "Not connected"}
                            </span>
                          </div>
                          <div className="text-xs text-text-muted">
                            Optional connection. Syncs sessions across devices and can serve as a compute backend (see API → Compute backend).
                          </div>
                        </div>
                        {isElectronClient() && deployment && !deployment.cloud.connected && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const response = await fetch("/api/auth/desktop-session", { method: "POST" });
                                const data = await response.json();
                                if (!response.ok) throw new Error(data.error || "Cannot connect to Cloud");
                                window.electronAPI?.openExternal?.(data.url);
                              } catch (error) {
                                window.alert(error instanceof Error ? error.message : "Cannot connect to Cloud");
                              }
                            }}
                            className="flex-shrink-0 px-3 py-1.5 rounded-lg border border-border text-xs text-text-secondary hover:border-accent/40 hover:text-text-primary transition-colors"
                          >
                            Connect
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Custom System Prompt */}
                <div>
                  <h3 className="text-lg font-medium text-text-primary mb-2">
                    Custom System Prompt
                  </h3>
                  <p className="text-xs text-text-muted mb-2">
                    Additional instructions appended to the default system prompt. Use this to customize the agent&apos;s behavior, output format, or focus areas.
                  </p>
                  <textarea
                    value={formSystemPrompt}
                    onChange={(e) => setFormSystemPrompt(e.target.value)}
                    placeholder="e.g., Always output results as markdown tables. Focus on enzyme engineering tasks."
                    rows={5}
                    className="w-full px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50 resize-y"
                  />
                  <div className="flex items-center gap-3 mt-2">
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
                    >
                      {saving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : saveStatus === "success" ? (
                        <Check className="w-4 h-4" />
                      ) : null}
                      {saving
                        ? "Saving..."
                        : saveStatus === "success"
                          ? "Saved"
                          : "Save"}
                    </button>
                    {formSystemPrompt && (
                      <button
                        onClick={() => setFormSystemPrompt("")}
                        className="text-xs text-text-muted hover:text-text-primary transition-colors"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                {/* Structure analysis runtime */}
                <AnalysisRuntimeCard />

                {/* Molecular viewers via MCP */}
                <McpViewersCard />

                {/* About */}
                <div>
                  <h3 className="text-lg font-medium text-text-primary mb-2">
                    About
                  </h3>
                  <div className="text-sm text-text-muted space-y-1">
                    <p>ChatMol Lab v1.0.0</p>
                    <p>AI Research Assistant for Computational Biology</p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "skills" && <PluginsCard />}

            {activeTab === "memory" && <MemoryCard />}

            {activeTab === "api" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-lg font-medium text-text-primary">
                    API Configuration
                  </h3>
                  <p className="text-xs text-text-muted mt-1">
                    Configure your LLM provider and API key. Changes take effect
                    immediately.
                  </p>
                </div>

                {loading ? (
                  <div className="flex items-center gap-2 text-sm text-text-muted py-4">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading settings...
                  </div>
                ) : (
                  <>
                    {/* Provider */}
                    {(() => {
                      const providers = settings?.providers?.length ? settings.providers : [FALLBACK_PROVIDER];
                      const current = providers.find((p) => p.id === formProvider) || providers[0];
                      const onProviderChange = (id: string) => {
                        const next = providers.find((p) => p.id === id) || providers[0];
                        setFormProvider(next.id);
                        setFormApiKey("");
                        setFormModel(next.defaultModel);
                        setFormFastModel(next.defaultFastModel);
                      };
                      return (
                        <>
                          <div>
                            <label className="block text-sm font-medium text-text-primary mb-1">
                              Provider
                            </label>
                            <p className="text-xs text-text-muted mb-2">
                              Any provider with tool calling works. Keys are stored per provider, so
                              switching back later keeps the previous key.
                            </p>
                            <select
                              value={current.id}
                              onChange={(e) => onProviderChange(e.target.value)}
                              className="w-full px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent/50"
                            >
                              {providers.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.label}{p.hasKey ? " ✓" : ""}
                                </option>
                              ))}
                            </select>
                            {current.note && (
                              <p className="text-xs text-text-muted mt-1">{current.note}</p>
                            )}
                          </div>

                          {current.id === "custom" && (
                            <div>
                              <label className="block text-sm font-medium text-text-primary mb-1">
                                Base URL
                              </label>
                              <p className="text-xs text-text-muted mb-2">
                                OpenAI-compatible server root, e.g.{" "}
                                <code className="bg-bg-tertiary px-1 rounded">http://localhost:11434</code>{" "}
                                (Ollama) or{" "}
                                <code className="bg-bg-tertiary px-1 rounded">https://api.moonshot.cn/v1</code>.
                              </p>
                              <input
                                type="text"
                                value={formLlmBaseUrl}
                                onChange={(e) => setFormLlmBaseUrl(e.target.value)}
                                placeholder="http://localhost:11434"
                                className="w-full px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                              />
                            </div>
                          )}

                          {/* API Key */}
                          <div>
                            <label className="block text-sm font-medium text-text-primary mb-1">
                              {current.label} API Key
                            </label>
                            <p className="text-xs text-text-muted mb-2">
                              {current.keyUrl ? (
                                <>
                                  Get a key from{" "}
                                  <a
                                    href={current.keyUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-accent hover:underline"
                                  >
                                    {current.keyUrl.replace(/^https?:\/\//, "").split("/")[0]}
                                  </a>
                                  . Also read from the{" "}
                                  <code className="bg-bg-tertiary px-1 rounded">{current.envKey}</code>{" "}
                                  env var.
                                </>
                              ) : (
                                <>
                                  Optional for local servers. Also read from the{" "}
                                  <code className="bg-bg-tertiary px-1 rounded">{current.envKey}</code>{" "}
                                  env var.
                                </>
                              )}
                            </p>
                            <div className="relative">
                              <input
                                type={showKey ? "text" : "password"}
                                value={formApiKey}
                                onChange={(e) => setFormApiKey(e.target.value)}
                                placeholder={
                                  current.maskedKey
                                    ? `Current: ${current.maskedKey}`
                                    : "Enter API key..."
                                }
                                className="w-full px-3 py-2 pr-10 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                              />
                              <button
                                type="button"
                                onClick={() => setShowKey(!showKey)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                              >
                                {showKey ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>

                          {/* Model */}
                          <div>
                            <label className="block text-sm font-medium text-text-primary mb-1">
                              Model
                            </label>
                            <p className="text-xs text-text-muted mb-2">
                              Main chat model. Pick a suggestion or type any model id the provider accepts.
                            </p>
                            <input
                              type="text"
                              list="chatmol-model-suggestions"
                              value={formModel}
                              onChange={(e) => setFormModel(e.target.value)}
                              placeholder={current.defaultModel || "model id"}
                              className="w-full px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                            />
                            <datalist id="chatmol-model-suggestions">
                              {current.models.map(({ value, label }) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </datalist>
                          </div>

                          {/* Fast model */}
                          <div>
                            <label className="block text-sm font-medium text-text-primary mb-1">
                              Fast Model
                            </label>
                            <p className="text-xs text-text-muted mb-2">
                              Cheaper model for session titles, the activity report, and the tool
                              reviewer. Leave empty to use the main model.
                            </p>
                            <input
                              type="text"
                              list="chatmol-model-suggestions"
                              value={formFastModel}
                              onChange={(e) => setFormFastModel(e.target.value)}
                              placeholder={current.defaultFastModel || formModel || "model id"}
                              className="w-full px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                            />
                          </div>
                        </>
                      );
                    })()}

                    {/* Max Output Tokens */}
                    <div>
                      <label className="block text-sm font-medium text-text-primary mb-1">
                        Max Output Tokens
                      </label>
                      <p className="text-xs text-text-muted mb-2">
                        Maximum number of tokens the model can generate per
                        response. Higher values allow longer outputs but cost
                        more. Default: 8192.
                      </p>
                      <input
                        type="number"
                        min={1}
                        max={128000}
                        step={1024}
                        value={formMaxOutputTokens}
                        onChange={(e) =>
                          setFormMaxOutputTokens(
                            Math.max(1, parseInt(e.target.value) || 8192)
                          )
                        }
                        className="w-full px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                      />
                    </div>

                    {/* Tool Review Mode */}
                    <div>
                      <label className="block text-sm font-medium text-text-primary mb-1">
                        Tool Review Mode
                      </label>
                      <p className="text-xs text-text-muted mb-2">
                        Controls what happens before the agent executes tool calls.
                        Auto works like Codex / Claude Code: read-only shell commands
                        run immediately, destructive ones always ask, and everything
                        else is checked by the fast model against your task and the
                        workspace boundary.
                      </p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {[
                          {
                            value: "auto" as const,
                            label: "Auto (recommended)",
                            description: "Bash: safe → run, risky → ask, rest → fast-model review. Other tools run.",
                          },
                          {
                            value: "reviewer" as const,
                            label: "Model reviewer",
                            description: "Fast model audits every tool call; uncertain calls pause.",
                          },
                          {
                            value: "manual" as const,
                            label: "Manual audit",
                            description: "Pause before each tool call.",
                          },
                          {
                            value: "unrestricted" as const,
                            label: "Unrestricted",
                            description: "Run everything without review (hard sandbox still applies).",
                          },
                        ].map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setFormToolReviewMode(option.value)}
                            className={`rounded-lg border p-3 text-left transition-colors ${
                              formToolReviewMode === option.value
                                ? "border-accent bg-accent/10"
                                : "border-border bg-bg-tertiary hover:border-accent/40"
                            }`}
                          >
                            <div className="text-sm font-medium text-text-primary">
                              {option.label}
                            </div>
                            <div className="mt-1 text-xs text-text-muted">
                              {option.description}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* WeMol Compute Profile */}
                    <div>
                      <label className="block text-sm font-medium text-text-primary mb-1">
                        WeMol Compute Profile
                      </label>
                      <p className="text-xs text-text-muted mb-2">
                        Controls how aggressively the agent spends WeMol compute.
                        Free/local/NVIDIA tools are still used when they fit.
                      </p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {[
                          {
                            value: "pre_experiment" as const,
                            label: "预实验",
                            description: "Prefer free NVIDIA/local runs; use WeMol for unique capabilities or after discovery.",
                          },
                          {
                            value: "industrial" as const,
                            label: "工业级",
                            description: "Prefer validated WeMol modules/flows for final production-grade runs.",
                          },
                        ].map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setFormWemolComputeProfile(option.value)}
                            className={`rounded-lg border p-3 text-left transition-colors ${
                              formWemolComputeProfile === option.value
                                ? "border-accent bg-accent/10"
                                : "border-border bg-bg-tertiary hover:border-accent/40"
                            }`}
                          >
                            <div className="text-sm font-medium text-text-primary">
                              {option.label}
                            </div>
                            <div className="mt-1 text-xs text-text-muted">
                              {option.description}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Shell PATH */}
                    <div>
                      <label className="block text-sm font-medium text-text-primary mb-1">
                        Extra shell PATH
                      </label>
                      <p className="text-xs text-text-muted mb-2">
                        Directories added <strong>after</strong> the bundled runtime when
                        running bash commands. The bundled Miniforge env always comes
                        first, so{" "}
                        <code className="bg-bg-tertiary px-1 rounded">python</code>,{" "}
                        <code className="bg-bg-tertiary px-1 rounded">pip</code> and{" "}
                        <code className="bg-bg-tertiary px-1 rounded">conda</code> are
                        the app&apos;s own; add other conda installs here only for tools that
                        are not in the runtime. Colon-separated, e.g.{" "}
                        <code className="bg-bg-tertiary px-1 rounded">/opt/homebrew/bin</code>.
                        Leave empty in most cases.
                      </p>
                      {settings?.runtime?.native?.pathPrepend && (
                        <p className="text-[11px] font-mono text-text-muted mb-2 break-all">
                          runtime first: {settings.runtime.native.pathPrepend}
                        </p>
                      )}
                      <input
                        type="text"
                        value={formShellPath}
                        onChange={(e) => setFormShellPath(e.target.value)}
                        placeholder="/opt/homebrew/bin"
                        className="w-full px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                      />
                      {settings?.runtime && (
                        <div className="mt-3 rounded-lg border border-border bg-bg-primary p-3">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <div className="text-xs font-medium uppercase tracking-wider text-text-muted">
                                Detected runtime
                              </div>
                              <div className="mt-1 text-sm text-text-primary">
                                Active:{" "}
                                <span className="font-mono">
                                  {settings.runtime.activeBackend}
                                </span>
                                <span className="ml-2 text-xs text-text-muted">
                                  {settings.runtime.platform}
                                </span>
                              </div>
                            </div>
                            {settings.runtime.native.pathPrepend && (
                              <button
                                type="button"
                                onClick={() =>
                                  setFormShellPath(
                                    settings.runtime?.native.pathPrepend || ""
                                  )
                                }
                                className="self-start rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:border-accent/50 hover:text-text-primary"
                              >
                                Use bundled PATH
                              </button>
                            )}
                          </div>
                          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <RuntimeRow
                              label="Native conda"
                              value={settings.runtime.native.conda.path}
                              ok={settings.runtime.native.conda.exists}
                            />
                            <RuntimeRow
                              label="Native python"
                              value={settings.runtime.native.python.path}
                              ok={settings.runtime.native.python.exists}
                            />
                            <RuntimeRow
                              label="Native wemol-cli"
                              value={settings.runtime.native.wemolCli.path}
                              ok={settings.runtime.native.wemolCli.exists}
                            />
                            {(settings.runtime.platform === "win32" ||
                              settings.runtime.wsl.ready) && (
                              <RuntimeRow
                                label="WSL conda"
                                value={settings.runtime.wsl.pathPrepend}
                                ok={settings.runtime.wsl.ready}
                              />
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Compute backend */}
                    <div className="border-t border-border pt-4 mt-2 space-y-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Cloud className="w-4 h-4 text-text-primary" />
                          <h4 className="text-sm font-medium text-text-primary">Compute backend</h4>
                        </div>
                        <p className="text-xs text-text-muted mb-2">
                          Where structure prediction, design and WeMol jobs run. Direct uses the credentials below and
                          bills you through each provider; ChatMol Cloud routes the same requests through your ChatMol
                          Cloud connection and falls back to Direct for anything it does not serve.
                        </p>
                        <div className="space-y-1.5">
                          {([
                            { id: "direct", label: "Direct — bring your own credentials" },
                            { id: "chatmol-cloud", label: "ChatMol Cloud" },
                          ] as const).map((option) => (
                            <label key={option.id} className="flex items-center gap-2 text-sm text-text-primary">
                              <input
                                type="radio"
                                name="computeBackend"
                                checked={formComputeBackend === option.id}
                                onChange={() => setFormComputeBackend(option.id)}
                              />
                              {option.label}
                            </label>
                          ))}
                        </div>
                        {computeProviders && (
                          <div className="mt-2 space-y-1">
                            {computeProviders.map((provider) => (
                              <div key={provider.id} className="flex items-start gap-2 text-xs">
                                {provider.availability.ok ? (
                                  <CircleCheck className="w-3.5 h-3.5 mt-0.5 text-success flex-shrink-0" />
                                ) : (
                                  <CircleX className="w-3.5 h-3.5 mt-0.5 text-text-muted flex-shrink-0" />
                                )}
                                <div className="min-w-0">
                                  <span className="text-text-primary">{provider.label}</span>
                                  {provider.capabilities.length > 0 && (
                                    <span className="text-text-muted"> · {provider.capabilities.length} capabilities</span>
                                  )}
                                  {!provider.availability.ok && provider.availability.reason && (
                                    <div className="text-text-muted">{provider.availability.reason}</div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* NVIDIA BioNeMo NIM */}
                    <div className="border-t border-border pt-4 mt-2 space-y-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Cpu className="w-4 h-4 text-text-primary" />
                          <h4 className="text-sm font-medium text-text-primary">
                            NVIDIA BioNeMo NIM
                          </h4>
                        </div>
                        <p className="text-xs text-text-muted mb-2">
                          Cloud API for structure prediction (OpenFold2/3, Boltz-2),
                          protein design (RFdiffusion, ProteinMPNN), molecular docking (DiffDock),
                          and more. No GPU needed. Get a key from{" "}
                          <a
                            href="https://build.nvidia.com/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent hover:underline"
                          >
                            build.nvidia.com
                          </a>
                          .
                        </p>
                        <div className="relative">
                          <input
                            type={showNvidiaKey ? "text" : "password"}
                            value={formNvidiaApiKey}
                            onChange={(e) => setFormNvidiaApiKey(e.target.value)}
                            placeholder={
                              settings?.nvidiaApiKey
                                ? `Current: ${settings.nvidiaApiKey}`
                                : "nvapi-..."
                            }
                            className="w-full px-3 py-2 pr-10 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                          />
                          <button
                            type="button"
                            onClick={() => setShowNvidiaKey(!showNvidiaKey)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                          >
                            {showNvidiaKey ? (
                              <EyeOff className="w-4 h-4" />
                            ) : (
                              <Eye className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* ChatMol Bio API */}
                    <div className="border-t border-border pt-4 mt-2 space-y-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Cloud className="w-4 h-4 text-text-primary" />
                          <h4 className="text-sm font-medium text-text-primary">ChatMol Bio API</h4>
                        </div>
                        <p className="text-xs text-text-muted mb-2">
                          GPU tools (structure prediction, design, docking, MD) run as background jobs on
                          ChatMol Bio with your own API key; the agent finds them through the compute catalog
                          and imports results into the workspace when they finish.
                        </p>
                        <div className="relative">
                          <input
                            type={showChatmolBioKey ? "text" : "password"}
                            value={formChatmolBioApiKey}
                            onChange={(e) => setFormChatmolBioApiKey(e.target.value)}
                            placeholder={settings?.chatmolBioApiKey ? `Current: ${settings.chatmolBioApiKey}` : "cmol_..."}
                            className="w-full px-3 py-2 pr-10 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                          />
                          <button
                            type="button"
                            onClick={() => setShowChatmolBioKey(!showChatmolBioKey)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                          >
                            {showChatmolBioKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        <input
                          type="text"
                          value={formChatmolBioBaseUrl}
                          onChange={(e) => setFormChatmolBioBaseUrl(e.target.value)}
                          placeholder="API URL (default: https://bio-api.cloudmol.org)"
                          className="mt-2 w-full px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                        />
                      </div>
                    </div>

                    {/* WeMol Platform */}
                    <div className="border-t border-border pt-4 mt-2 space-y-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Zap className="w-4 h-4 text-text-primary" />
                          <h4 className="text-sm font-medium text-text-primary">
                            WeMol Platform
                          </h4>
                        </div>
                        <p className="text-xs text-text-muted mb-2">
                          Molecular digital intelligent computing platform for drug discovery workflows —
                          antibody design, virtual screening, molecular simulation, and more.
                          Sign up at{" "}
                          <a
                            href="https://wemol.wecomput.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent hover:underline"
                          >
                            wemol.wecomput.com
                          </a>
                          .
                        </p>
                        <div className="space-y-2">
                          <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1">
                              Username
                            </label>
                            <input
                              type="text"
                              value={formWemolUsername}
                              onChange={(e) => setFormWemolUsername(e.target.value)}
                              placeholder={
                                settings?.wemolUsername
                                  ? settings.wemolUsername
                                  : "WeMol account username"
                              }
                              className="w-full px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1">
                              Password
                            </label>
                            <div className="relative">
                              <input
                                type={showWemolPassword ? "text" : "password"}
                                value={formWemolPassword}
                                onChange={(e) => setFormWemolPassword(e.target.value)}
                                placeholder={
                                  settings?.wemolPassword
                                    ? "Current: ********"
                                    : "WeMol account password"
                                }
                                className="w-full px-3 py-2 pr-10 bg-bg-tertiary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted/50 font-mono focus:outline-none focus:border-accent/50"
                              />
                              <button
                                type="button"
                                onClick={() => setShowWemolPassword(!showWemolPassword)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                              >
                                {showWemolPassword ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                          {settings?.wemolStatus && settings.wemolStatus.state !== "unknown" && (
                            <div
                              className={`rounded-lg border px-3 py-2 text-xs ${
                                settings.wemolStatus.state === "connected"
                                  ? "border-green-500/30 bg-green-500/10 text-green-200"
                                  : "border-red-500/30 bg-red-500/10 text-red-200"
                              }`}
                            >
                              <div className="flex items-center gap-2 font-medium">
                                {settings.wemolStatus.state === "connected" ? (
                                  <CircleCheck className="w-4 h-4" />
                                ) : (
                                  <CircleX className="w-4 h-4" />
                                )}
                                <span>
                                  {settings.wemolStatus.state === "connected"
                                    ? "WeMol account verified"
                                    : "WeMol account verification failed"}
                                </span>
                              </div>
                              {settings.wemolStatus.message && (
                                <p className="mt-1 text-current/80">
                                  {settings.wemolStatus.message}
                                </p>
                              )}
                              <div className="mt-1 text-current/60">
                                {settings.wemolStatus.checkedAt && (
                                  <span>
                                    Checked {new Date(settings.wemolStatus.checkedAt).toLocaleString()}
                                  </span>
                                )}
                                {settings.wemolStatus.cliVersion && (
                                  <span className="ml-2">
                                    {settings.wemolStatus.cliVersion}
                                  </span>
                                )}
                              </div>
                              {settings.wemolStatus.accountOutput && (
                                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 font-mono text-[11px] text-current/75">
                                  {settings.wemolStatus.accountOutput}
                                </pre>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Save button */}
                    <div className="flex items-center gap-3 pt-2">
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
                      >
                        {saving ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : saveStatus === "success" ? (
                          <Check className="w-4 h-4" />
                        ) : null}
                        {saving
                          ? formWemolPassword
                            ? "Saving & verifying..."
                            : "Saving..."
                          : saveStatus === "success"
                            ? "Saved"
                            : "Save"}
                      </button>
                      {saveStatus === "error" && (
                        <span className="text-xs text-red-400">
                          {saveError}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
