import * as fs from "fs";
import * as path from "path";
import { prisma } from "./db";
import { isElectronServer } from "./electron";
import { getDefaultRuntimeShellPath } from "./runtime";
import { normalizeToolReviewMode, type ToolReviewMode } from "./tool-review";
import { normalizeWemolComputeProfile, type WemolComputeProfile } from "./wemol-policy";

import {
  LLM_PROVIDERS,
  LLM_PROVIDER_IDS,
  defaultFastModelFor,
  detectEnvProvider,
  getEnvApiKey,
  isAnthropicWire,
  normalizeLlmProvider,
  normalizeModelForProvider,
  providerSupportsThinkingFields,
  resolveChatUrl,
  type LlmProviderId,
} from "./llm-providers";

export { LLM_PROVIDERS, LLM_PROVIDER_IDS, type LlmProviderId } from "./llm-providers";

/** Kept for callers that still import the DeepSeek default. */
export const DEFAULT_MODEL: string = LLM_PROVIDERS.deepseek.defaultModel;

export type ProviderApiKeys = Partial<Record<LlmProviderId, string>>;

export type ComputeBackend = "direct" | "chatmol-cloud";

export function normalizeComputeBackend(value: unknown): ComputeBackend {
  return value === "chatmol-cloud" ? "chatmol-cloud" : "direct";
}

export interface AppSettings {
  /** Active chat LLM provider. */
  provider: LlmProviderId;
  /** Effective API key for the active provider (settings file, else env). */
  apiKey: string;
  /** Per-provider keys persisted in the settings file. */
  apiKeys: ProviderApiKeys;
  /** Base URL for the `custom` provider (OpenAI-compatible). */
  llmBaseUrl: string;
  /** ChatMol Bio API (bio-api.cloudmol.org) — the user's own `cmol_...` key; empty when unused. */
  chatmolBioApiKey: string;
  chatmolBioBaseUrl: string;
  model: string;
  /** Cheaper model for titles, activity reports, the tool reviewer, and subagents. */
  fastModel: string;
  maxOutputTokens: number;
  shellPath: string;
  workspaceDir: string;
  mpnnPython: string;
  mpnnScript: string;
  systemPrompt: string;
  nvidiaApiKey: string;
  desktopSyncToken: string;
  wemolUsername?: string;
  wemolPassword?: string;
  wemolStatus?: WemolAccountStatus;
  mcpServers: McpServerConfig[];
  toolReviewMode: ToolReviewMode;
  /** Which compute backend serves nvidia_* / wemol_cli: the user's own credentials, or the ChatMol Cloud gateway. */
  computeBackend: ComputeBackend;
  wemolComputeProfile: WemolComputeProfile;
  /** Persistent memory (index in the prompt, memory tool, end-of-run distillation). */
  memoryEnabled: boolean;
}

export interface McpServerConfig {
  id: string;
  name?: string;
  /** Built-in preset id (pymol, chimerax). Presets resolve their own command. */
  preset?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export type WemolAccountState = "unknown" | "connected" | "error";

export interface WemolAccountStatus {
  state: WemolAccountState;
  checkedAt?: string;
  username?: string;
  cliVersion?: string;
  message?: string;
  accountOutput?: string;
}

export interface ApiConfig {
  provider: LlmProviderId;
  url: string;
  key: string;
  model: string;
  /** True when the endpoint speaks the Anthropic Messages protocol. */
  isAnthropic: boolean;
  maxOutputTokens: number;
  /** DeepSeek-only request fields; ignored for providers that reject them. */
  thinking?: { type: "enabled" | "disabled" };
  reasoningEffort?: "low" | "medium" | "high";
}

const SETTINGS_PATH = process.env.SETTINGS_PATH || path.join(process.cwd(), ".settings.json");

/**
 * Write a file that holds secrets: the data directory is owner-only and the
 * file is 0600. `mode` in writeFileSync only applies when the file is created,
 * so existing files are chmod-ed explicitly. POSIX only; Windows inherits the
 * user profile ACL.
 */
function writeProtectedFile(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
}

/** Read .settings.json overrides (returns empty object if file doesn't exist) */
function readSettingsFile(): Partial<AppSettings> {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function normalizeMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return [];
  const servers: McpServerConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const command = typeof record.command === "string" ? record.command.trim() : "";
    const preset = typeof record.preset === "string" ? record.preset.trim() : "";
    if (!id || (!command && !preset)) continue;
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const env = record.env && typeof record.env === "object" && !Array.isArray(record.env)
      ? Object.fromEntries(
        Object.entries(record.env as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      )
      : {};
    servers.push({
      id,
      command,
      ...(preset ? { preset } : {}),
      ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      enabled: record.enabled !== false,
    });
  }
  return servers;
}

/**
 * Bin dirs of the bundled conda runtime (desktop) — always first on the tool
 * PATH regardless of settings. Returns "" off-desktop.
 */
export function defaultCondaShellPath(): string {
  return getDefaultRuntimeShellPath();
}

/**
 * `shellPath` holds the user's EXTRA dirs, appended after the bundled runtime.
 * Older builds persisted the runtime dirs themselves (and users copied their
 * own conda in front); strip anything that duplicates the runtime so it can
 * never shadow the bundled python.
 */
function normalizeExtraShellPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const runtimeDirs = new Set(getDefaultRuntimeShellPath().split(path.delimiter).filter(Boolean));
  return value
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir && !runtimeDirs.has(dir))
    .join(path.delimiter);
}

/**
 * Load effective settings: .settings.json overrides merged with env var defaults.
 * Called per-request so changes take effect without restart.
 */
function normalizeApiKeys(value: unknown, legacyApiKey: unknown): ProviderApiKeys {
  const keys: ProviderApiKeys = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [id, key] of Object.entries(value as Record<string, unknown>)) {
      if ((LLM_PROVIDER_IDS as string[]).includes(id) && typeof key === "string" && key) {
        keys[id as LlmProviderId] = key;
      }
    }
  }
  // Settings files written by the DeepSeek-only builds stored a single apiKey.
  if (!keys.deepseek && typeof legacyApiKey === "string" && legacyApiKey) {
    keys.deepseek = legacyApiKey;
  }
  return keys;
}

export function loadSettings(): AppSettings {
  const overrides = readSettingsFile() as Partial<AppSettings> & { apiKey?: string };
  const provider = normalizeLlmProvider(overrides.provider || detectEnvProvider());
  const apiKeys = normalizeApiKeys(overrides.apiKeys, overrides.apiKey);
  const model = normalizeModelForProvider(provider, overrides.model || process.env.MODEL);
  const fastModel = (overrides.fastModel || process.env.FAST_MODEL || "").trim() || defaultFastModelFor(provider, model);

  return {
    provider,
    apiKey: apiKeys[provider] || getEnvApiKey(provider),
    apiKeys,
    llmBaseUrl: (overrides.llmBaseUrl as string) || process.env.LLM_BASE_URL || "",
    chatmolBioApiKey: (overrides.chatmolBioApiKey as string) || process.env.CHATMOL_API_KEY || "",
    chatmolBioBaseUrl: (overrides.chatmolBioBaseUrl as string) || process.env.CHATMOL_API_URL || "",
    model,
    fastModel,
    maxOutputTokens: overrides.maxOutputTokens || Number(process.env.MAX_OUTPUT_TOKENS) || 8192,
    shellPath: normalizeExtraShellPath(overrides.shellPath),
    workspaceDir: process.env.WORKSPACE_DIR || "/tmp/chatmol-workspace",
    mpnnPython: process.env.MPNN_PYTHON || "",
    mpnnScript: process.env.MPNN_SCRIPT || "",
    systemPrompt: (overrides.systemPrompt as string) || "",
    nvidiaApiKey: (overrides.nvidiaApiKey as string) || process.env.NVIDIA_API_KEY || "",
    desktopSyncToken: (overrides.desktopSyncToken as string) || "",
    mcpServers: normalizeMcpServers(overrides.mcpServers),
    toolReviewMode: normalizeToolReviewMode(overrides.toolReviewMode || process.env.TOOL_REVIEW_MODE),
    computeBackend: normalizeComputeBackend(overrides.computeBackend || process.env.COMPUTE_BACKEND),
    wemolComputeProfile: normalizeWemolComputeProfile(overrides.wemolComputeProfile || process.env.WEMOL_COMPUTE_PROFILE),
    memoryEnabled: overrides.memoryEnabled !== false && !/^(off|0|false|no)$/i.test((process.env.CHATMOL_MEMORY || "").trim()),
  };
}

/** Save partial settings overrides to .settings.json */
export function saveSettings(partial: Partial<AppSettings>): void {
  const existing = readSettingsFile() as Partial<AppSettings> & { apiKey?: string };
  const merged: Record<string, unknown> = { ...existing, ...partial };
  // `apiKey` is a per-provider secret: store it under apiKeys[provider] so
  // switching providers keeps every key.
  if (typeof partial.apiKey === "string") {
    const provider = normalizeLlmProvider(partial.provider || existing.provider || detectEnvProvider());
    const keys = normalizeApiKeys(existing.apiKeys, existing.apiKey);
    if (partial.apiKey) keys[provider] = partial.apiKey;
    else delete keys[provider];
    merged.apiKeys = keys;
  } else if (existing.apiKey && !existing.apiKeys) {
    merged.apiKeys = normalizeApiKeys(undefined, existing.apiKey);
  }
  delete merged.apiKey;
  // Don't persist read-only or per-user fields
  delete (merged as Record<string, unknown>).workspaceDir;
  delete (merged as Record<string, unknown>).mpnnPython;
  delete (merged as Record<string, unknown>).mpnnScript;
  // In Electron mode, keep nvidiaApiKey in settings file; in server mode, strip it
  if (!isElectronServer()) {
    delete (merged as Record<string, unknown>).nvidiaApiKey;
    delete (merged as Record<string, unknown>).desktopSyncToken;
  }
  writeProtectedFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));
}

/** Mask an API key for safe display: show first 5 + last 4 chars */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "****" + key.slice(-4);
  return key.slice(0, 5) + "..." + key.slice(-4);
}

/** Check if a value looks like a masked key (contains "...") */
export function isMaskedKey(value: string): boolean {
  return /^.{3,5}\.\.\..{4}$/.test(value);
}

// --- Per-user settings ---

// In Electron mode, per-user settings are stored in the settings file
// since there's only one user. In server mode, they use the Prisma DB.

interface FileUserSettings {
  nvidiaApiKey?: string;
  systemPrompt?: string;
  desktopSyncToken?: string;
  wemolUsername?: string;
  wemolPassword?: string;
  wemolStatus?: WemolAccountStatus;
}

function readFileUserSettings(): FileUserSettings {
  try {
    const data = readSettingsFile();
    return {
      nvidiaApiKey: data.nvidiaApiKey as string | undefined,
      systemPrompt: data.systemPrompt as string | undefined,
      desktopSyncToken: data.desktopSyncToken as string | undefined,
      wemolUsername: data.wemolUsername as string | undefined,
      wemolPassword: data.wemolPassword as string | undefined,
      wemolStatus: data.wemolStatus as WemolAccountStatus | undefined,
    };
  } catch {}
  return {};
}

function writeFileUserSettings(updates: Partial<FileUserSettings>): void {
  const existing = readSettingsFile();
  const merged = { ...existing, ...updates };
  writeProtectedFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));
}

/** Get per-user NVIDIA API key. Falls back to env var for guests. */
export async function getUserNvidiaApiKey(userId: string | null): Promise<string> {
  if (isElectronServer()) {
    const settings = readFileUserSettings();
    return settings.nvidiaApiKey || process.env.NVIDIA_API_KEY || "";
  }

  if (userId) {
    try {
      const row = await prisma.userSettings.findUnique({
        where: { userId },
        select: { nvidiaApiKey: true },
      });
      if (row?.nvidiaApiKey) return row.nvidiaApiKey;
    } catch {}
  }
  // Fallback: env var
  return process.env.NVIDIA_API_KEY || "";
}

/** Save per-user NVIDIA API key to database. */
export async function saveUserNvidiaApiKey(userId: string, key: string): Promise<void> {
  if (isElectronServer()) {
    writeFileUserSettings({ nvidiaApiKey: key });
    return;
  }

  await prisma.userSettings.upsert({
    where: { userId },
    update: { nvidiaApiKey: key },
    create: { userId, nvidiaApiKey: key },
  });
}

/** Get per-user system prompt. Returns empty string if not set. */
export async function getUserSystemPrompt(userId: string | null): Promise<string> {
  const filePrompt = readFileUserSettings().systemPrompt || "";
  if (isElectronServer()) {
    return filePrompt;
  }

  if (userId) {
    try {
      const row = await prisma.userSettings.findUnique({
        where: { userId },
        select: { systemPrompt: true },
      });
      if (row?.systemPrompt) return row.systemPrompt;
    } catch {}
  }
  return filePrompt;
}

/** Save per-user system prompt to database. */
export async function saveUserSystemPrompt(userId: string | null, prompt: string): Promise<void> {
  if (isElectronServer() || !userId) {
    writeFileUserSettings({ systemPrompt: prompt });
    return;
  }

  await prisma.userSettings.upsert({
    where: { userId },
    update: { systemPrompt: prompt },
    create: { userId, systemPrompt: prompt },
  });
}

export function getDesktopSyncToken(): string {
  if (!isElectronServer()) return "";
  return readFileUserSettings().desktopSyncToken || "";
}

export function saveDesktopSyncToken(token: string): void {
  if (!isElectronServer()) return;
  writeFileUserSettings({ desktopSyncToken: token });
}

// --- WeMol credential encryption ---
import * as crypto from "crypto";

/**
 * Key for the WeMol password at rest: an explicit WEMOL_ENCRYPT_KEY, else the
 * auth secret, else a random per-install secret stored next to the settings
 * file (0600). Never a constant that ships in the source.
 */
function wemolEncryptKey(): string {
  if (process.env.WEMOL_ENCRYPT_KEY) return process.env.WEMOL_ENCRYPT_KEY;
  if (process.env.NEXTAUTH_SECRET) return process.env.NEXTAUTH_SECRET;
  const keyPath = path.join(path.dirname(SETTINGS_PATH), ".wemol-key");
  try {
    return fs.readFileSync(keyPath, "utf-8").trim();
  } catch {
    const generated = crypto.randomBytes(32).toString("hex");
    writeProtectedFile(keyPath, generated);
    return generated;
  }
}

function encryptPassword(plaintext: string): string {
  const key = crypto.scryptSync(wemolEncryptKey(), "wemol-salt", 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted.toString("hex");
}

function decryptWith(secret: string, ivHex: string, tagHex: string, encHex: string): string {
  const key = crypto.scryptSync(secret, "wemol-salt", 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(encHex, "hex")) + decipher.final("utf8");
}

/** Returns "" when the ciphertext cannot be read with the current key (the user re-enters it). */
function decryptPassword(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) return ciphertext; // legacy plaintext fallback
  const [ivHex, tagHex, encHex] = parts;
  try {
    return decryptWith(wemolEncryptKey(), ivHex, tagHex, encHex);
  } catch {
    return "";
  }
}

/** Get per-user WeMol credentials. Returns { username, password } or nulls. */
export async function getUserWemolCredentials(userId: string | null): Promise<{ username: string; password: string } | null> {
  if (isElectronServer()) {
    const settings = readFileUserSettings();
    if (settings.wemolUsername && settings.wemolPassword) {
      const password = decryptPassword(settings.wemolPassword);
      return password ? { username: settings.wemolUsername, password } : null;
    }
    return null;
  }

  if (userId) {
    try {
      const row = await prisma.userSettings.findUnique({
        where: { userId },
        select: { wemolUsername: true, wemolPassword: true },
      });
      if (row?.wemolUsername && row?.wemolPassword) {
        const password = decryptPassword(row.wemolPassword);
        if (password) return { username: row.wemolUsername, password };
      }
    } catch {}
  }
  return null;
}

/** Save per-user WeMol credentials to database (password encrypted at rest). */
export async function saveUserWemolCredentials(userId: string | null, username: string, password: string): Promise<void> {
  const encryptedPassword = encryptPassword(password);
  if (isElectronServer()) {
    writeFileUserSettings({ wemolUsername: username, wemolPassword: encryptedPassword });
    return;
  }

  if (!userId) return;
  await prisma.userSettings.upsert({
    where: { userId },
    update: { wemolUsername: username, wemolPassword: encryptedPassword },
    create: { userId, wemolUsername: username, wemolPassword: encryptedPassword },
  });
}

export async function getUserWemolStatus(_userId: string | null): Promise<WemolAccountStatus> {
  if (isElectronServer()) {
    return readFileUserSettings().wemolStatus || { state: "unknown" };
  }
  return { state: "unknown" };
}

export async function saveUserWemolStatus(_userId: string | null, status: WemolAccountStatus): Promise<void> {
  if (isElectronServer()) {
    writeFileUserSettings({ wemolStatus: status });
  }
}

/** Convert AppSettings into the ApiConfig the chat route streams through. */
export function getEffectiveApiConfig(settings: AppSettings): ApiConfig {
  const provider = normalizeLlmProvider(settings.provider);
  return {
    provider,
    url: resolveChatUrl(provider, settings.llmBaseUrl),
    key: settings.apiKey,
    model: normalizeModelForProvider(provider, settings.model),
    isAnthropic: isAnthropicWire(provider),
    maxOutputTokens: settings.maxOutputTokens,
  };
}

/**
 * Same provider and key as the main config, but the cheaper "fast" model.
 * Used for titles, activity reports, the tool reviewer, and subagents.
 */
export function getFastApiConfig(settings: AppSettings): ApiConfig {
  const main = getEffectiveApiConfig(settings);
  const fast = (settings.fastModel || "").trim();
  return { ...main, model: fast ? normalizeModelForProvider(main.provider, fast) : main.model };
}

/** True when the provider accepts DeepSeek `thinking` / `reasoning_effort` fields. */
export function supportsThinkingFields(apiConfig: ApiConfig): boolean {
  return providerSupportsThinkingFields(apiConfig.provider);
}
