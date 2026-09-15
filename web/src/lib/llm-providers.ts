/**
 * Provider catalog for the chat LLM.
 *
 * Modeled on the DeepSeek Harness "llm seam": one provider-neutral ApiConfig
 * that the agent loop streams through, plus per-provider adapters that only
 * differ in wire format (OpenAI chat-completions vs Anthropic messages),
 * endpoint, auth header, and which optional request fields are allowed.
 *
 * Adding a provider = adding one entry to LLM_PROVIDERS. Anything that speaks
 * the OpenAI chat-completions protocol (Ollama, vLLM, LM Studio, Moonshot,
 * Qwen, ...) works through the `custom` provider with a base URL.
 */

export type LlmProviderId =
  | "deepseek"
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "custom";

export type LlmWireFormat = "openai-chat" | "anthropic-messages";

export interface LlmModelSuggestion {
  value: string;
  label: string;
}

export interface LlmProviderSpec {
  id: LlmProviderId;
  label: string;
  wireFormat: LlmWireFormat;
  /** Full chat endpoint URL. Empty for `custom` (user supplies a base URL). */
  chatUrl: string;
  /** Environment variable that carries the API key. */
  envKey: string;
  /** Where users obtain a key. */
  keyUrl: string;
  defaultModel: string;
  /** Cheaper model for titles, reports, reviewer, and subagents. */
  defaultFastModel: string;
  models: LlmModelSuggestion[];
  /** Whether the provider accepts DeepSeek-style `thinking` / `reasoning_effort` fields. */
  supportsThinkingFields: boolean;
  /** Short note shown in the settings UI. */
  note: string;
}

export const LLM_PROVIDER_IDS: LlmProviderId[] = [
  "deepseek",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "custom",
];

export const LLM_PROVIDERS: Record<LlmProviderId, LlmProviderSpec> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    wireFormat: "openai-chat",
    chatUrl: "https://api.deepseek.com/chat/completions",
    envKey: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-v4-pro",
    defaultFastModel: "deepseek-v4-flash",
    models: [
      { value: "deepseek-v4-pro", label: "deepseek-v4-pro — most capable (1M ctx)" },
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash — faster & cheaper (1M ctx)" },
    ],
    supportsThinkingFields: true,
    note: "Official DeepSeek open-platform API (api.deepseek.com).",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    wireFormat: "openai-chat",
    chatUrl: "https://api.openai.com/v1/chat/completions",
    envKey: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5",
    defaultFastModel: "gpt-5-mini",
    models: [
      { value: "gpt-5", label: "gpt-5" },
      { value: "gpt-5-mini", label: "gpt-5-mini — faster & cheaper" },
      { value: "gpt-4.1", label: "gpt-4.1" },
    ],
    supportsThinkingFields: false,
    note: "OpenAI chat-completions API.",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    wireFormat: "anthropic-messages",
    chatUrl: "https://api.anthropic.com/v1/messages",
    envKey: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-5",
    defaultFastModel: "claude-haiku-4-5-20251001",
    models: [
      { value: "claude-opus-5", label: "claude-opus-5 — most capable" },
      { value: "claude-sonnet-5", label: "claude-sonnet-5 — balanced" },
      { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5 — fastest" },
    ],
    supportsThinkingFields: false,
    note: "Anthropic Messages API (native tool_use blocks).",
  },
  google: {
    id: "google",
    label: "Google Gemini",
    wireFormat: "openai-chat",
    chatUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    envKey: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/app/apikey",
    defaultModel: "gemini-2.5-pro",
    defaultFastModel: "gemini-2.5-flash",
    models: [
      { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
      { value: "gemini-2.5-flash", label: "gemini-2.5-flash — faster & cheaper" },
    ],
    supportsThinkingFields: false,
    note: "Gemini through Google's OpenAI-compatible endpoint.",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    wireFormat: "openai-chat",
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
    envKey: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    defaultModel: "anthropic/claude-sonnet-5",
    defaultFastModel: "deepseek/deepseek-v4-flash",
    models: [
      { value: "anthropic/claude-sonnet-5", label: "anthropic/claude-sonnet-5" },
      { value: "openai/gpt-5", label: "openai/gpt-5" },
      { value: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
      { value: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" },
      { value: "deepseek/deepseek-v4-flash", label: "deepseek/deepseek-v4-flash" },
    ],
    supportsThinkingFields: false,
    note: "One key, many models. Model ids use the vendor/model form.",
  },
  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    wireFormat: "openai-chat",
    chatUrl: "",
    envKey: "LLM_API_KEY",
    keyUrl: "",
    defaultModel: "",
    defaultFastModel: "",
    models: [],
    supportsThinkingFields: false,
    note: "Any OpenAI-compatible server: Ollama, vLLM, LM Studio, Moonshot, Qwen, ...",
  },
};

export function normalizeLlmProvider(value: unknown): LlmProviderId {
  if (typeof value === "string") {
    const id = value.trim().toLowerCase();
    if ((LLM_PROVIDER_IDS as string[]).includes(id)) return id as LlmProviderId;
  }
  return "deepseek";
}

export function getLlmProviderSpec(provider: unknown): LlmProviderSpec {
  return LLM_PROVIDERS[normalizeLlmProvider(provider)];
}

type EnvLike = Record<string, string | undefined>;

/** API key from the provider's environment variable (empty when unset). */
export function getEnvApiKey(provider: LlmProviderId, env: EnvLike = process.env): string {
  return env[LLM_PROVIDERS[provider].envKey] || "";
}

/**
 * Pick a provider from the environment: explicit LLM_PROVIDER wins, then the
 * first provider whose key is set (DeepSeek first to preserve the previous
 * DeepSeek-only default).
 */
export function detectEnvProvider(env: EnvLike = process.env): LlmProviderId {
  if (env.LLM_PROVIDER) return normalizeLlmProvider(env.LLM_PROVIDER);
  for (const id of LLM_PROVIDER_IDS) {
    if (id === "custom") continue;
    if (getEnvApiKey(id, env)) return id;
  }
  if (env.LLM_BASE_URL && env.LLM_API_KEY) return "custom";
  return "deepseek";
}

/**
 * Turn a user-supplied base URL into a chat-completions endpoint.
 *   http://localhost:11434            -> http://localhost:11434/v1/chat/completions
 *   http://localhost:11434/v1         -> http://localhost:11434/v1/chat/completions
 *   https://x/v1/chat/completions     -> unchanged
 */
export function resolveCustomChatUrl(baseUrl: string): string {
  const trimmed = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

/** Chat endpoint for a provider (custom uses the configured base URL). */
export function resolveChatUrl(provider: LlmProviderId, customBaseUrl?: string): string {
  if (provider === "custom") return resolveCustomChatUrl(customBaseUrl || "");
  return LLM_PROVIDERS[provider].chatUrl;
}

/**
 * Model id normalization. Persisted settings from the OpenRouter era may hold
 * "vendor/model" ids; direct providers reject the vendor prefix, OpenRouter
 * requires it.
 */
export function normalizeModelForProvider(provider: LlmProviderId, model: string | undefined): string {
  const spec = LLM_PROVIDERS[provider];
  const raw = (model || "").trim();
  if (!raw) return spec.defaultModel;
  if (provider === "openrouter" || provider === "custom") return raw;
  return raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) || spec.defaultModel : raw;
}

export function defaultFastModelFor(provider: LlmProviderId, mainModel: string): string {
  const spec = LLM_PROVIDERS[provider];
  return spec.defaultFastModel || mainModel;
}

export function isAnthropicWire(provider: LlmProviderId): boolean {
  return LLM_PROVIDERS[provider].wireFormat === "anthropic-messages";
}

/** Human-readable hint for the "no key" error. */
export function missingKeyMessage(provider: LlmProviderId): string {
  const spec = LLM_PROVIDERS[provider];
  const where = spec.keyUrl ? ` Get a key at ${spec.keyUrl}.` : "";
  return `No ${spec.label} API key configured. Set one in Settings → API, or via the ${spec.envKey} env var.${where}`;
}

/** True when the provider accepts DeepSeek `thinking` / `reasoning_effort` request fields. */
export function providerSupportsThinkingFields(provider: unknown): boolean {
  return LLM_PROVIDERS[normalizeLlmProvider(provider)].supportsThinkingFields;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Known context windows (tokens) by provider + model prefix. */
const CONTEXT_WINDOWS: Array<{ provider?: LlmProviderId; pattern: RegExp; window: number }> = [
  { pattern: /deepseek-v4/i, window: 1_000_000 },
  { pattern: /deepseek-(chat|reasoner)/i, window: 128_000 },
  { pattern: /gpt-4\.1/i, window: 1_047_576 },
  { pattern: /gpt-5/i, window: 400_000 },
  { pattern: /gpt-4o/i, window: 128_000 },
  { pattern: /o[1-4](-|$)/i, window: 200_000 },
  { pattern: /claude/i, window: 200_000 },
  { pattern: /gemini-2\.5|gemini-2\.0|gemini-3/i, window: 1_048_576 },
  { pattern: /gemini/i, window: 1_000_000 },
  { pattern: /qwen3|qwen-?max|kimi|moonshot|glm-4\.5/i, window: 128_000 },
  { pattern: /llama/i, window: 128_000 },
];

/** Context window for a model (tokens); `LLM_CONTEXT_WINDOW` env overrides the custom provider. */
export function getModelContextWindow(provider: unknown, model: string | undefined, env: EnvLike = process.env): number {
  const id = normalizeLlmProvider(provider);
  if (id === "custom") {
    const override = Number.parseInt(env.LLM_CONTEXT_WINDOW || "", 10);
    if (Number.isFinite(override) && override > 0) return override;
  }
  const name = (model || "").trim();
  for (const entry of CONTEXT_WINDOWS) {
    if (entry.provider && entry.provider !== id) continue;
    if (entry.pattern.test(name)) return entry.window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}
