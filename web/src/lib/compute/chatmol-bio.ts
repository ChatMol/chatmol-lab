/**
 * ChatMol Bio provider — the current ChatMol Bio API (`bio-api.cloudmol.org`,
 * `/v1/tools`, `/v1/jobs`, `X-API-Key: cmol_...`), used directly with the
 * user's own API key until the ChatMol Router façade is live (see
 * docs/chatmol-router-design.md §3 "对现有 ChatMol Bio API 的渐进兼容").
 *
 * Jobs are asynchronous: `submit` returns a queued job that the desktop
 * poller tracks; `downloadArtifacts` fetches the result archive into the
 * session workspace once the job succeeded.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import { loadSettings } from "../settings";
import { safeResolvePath } from "../workspace";
import type { ComputeOffering, ComputeProvider, ComputeRequest, ProviderJob, ProviderJobStatus } from "./provider";

const execFileAsync = promisify(execFile);

export const CHATMOL_BIO_PROVIDER_ID = "chatmol-bio";
export const DEFAULT_CHATMOL_BIO_URL = "https://bio-api.cloudmol.org";

export interface ChatmolBioConfig {
  baseUrl: string;
  apiKey: string;
}

export function getChatmolBioConfig(settings = loadSettings()): ChatmolBioConfig {
  return {
    baseUrl: (settings.chatmolBioBaseUrl || process.env.CHATMOL_API_URL || DEFAULT_CHATMOL_BIO_URL).replace(/\/+$/, ""),
    apiKey: settings.chatmolBioApiKey || process.env.CHATMOL_API_KEY || "",
  };
}

/** Wire shapes of the current ChatMol Bio API (modals_tools/api/models.py). */
export interface BioToolInfo {
  tool_name: string;
  category: string;
  description: string;
  gpu_type: string;
  accepts_files?: boolean;
}
export interface BioToolDetail extends BioToolInfo {
  parameters?: Array<{ name: string; type?: string; required?: boolean; description?: string; default?: string | null }>;
}
export interface BioJob {
  job_id: string;
  status: string;
  tool: string;
  params?: Record<string, unknown>;
  file_names?: string[];
  gpu_type?: string | null;
  gpu_seconds?: number | null;
  error_message?: string | null;
  result_size_bytes?: number | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export function offeringId(toolName: string): string {
  return `${CHATMOL_BIO_PROVIDER_ID}/${toolName}`;
}

export function toolNameFromOffering(id: string): string | null {
  const prefix = `${CHATMOL_BIO_PROVIDER_ID}/`;
  if (id.startsWith(prefix)) return id.slice(prefix.length) || null;
  return id.includes("/") ? null : id;
}

/** ChatMol Bio statuses → unified state machine. */
export function mapBioStatus(status: string): ProviderJobStatus {
  switch (status) {
    case "submitted":
    case "queued":
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "completed":
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "running";
  }
}

const JSON_SCHEMA_TYPES: Record<string, string> = {
  str: "string", string: "string", int: "integer", integer: "integer", float: "number", number: "number",
  bool: "boolean", boolean: "boolean", list: "array", array: "array", dict: "object", object: "object",
};

export function toOffering(detail: BioToolDetail): ComputeOffering {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of detail.parameters ?? []) {
    properties[param.name] = {
      type: JSON_SCHEMA_TYPES[(param.type || "string").toLowerCase()] || "string",
      description: param.description || "",
      ...(param.default != null ? { default: param.default } : {}),
    };
    if (param.required) required.push(param.name);
  }
  if (detail.accepts_files) {
    properties.files = {
      type: "array",
      items: { type: "string" },
      description: "Workspace paths of input files to upload with the job.",
    };
  }
  return {
    id: offeringId(detail.tool_name),
    provider: CHATMOL_BIO_PROVIDER_ID,
    name: detail.tool_name,
    label: detail.tool_name,
    description: detail.description,
    category: detail.category,
    inputSchema: { type: "object", properties, required },
    acceptsFiles: Boolean(detail.accepts_files),
    gpuType: detail.gpu_type,
    priceModel: { kind: "usage", note: detail.gpu_type ? `Billed by GPU time on ${detail.gpu_type}` : "Billed by GPU time" },
  };
}

async function request<T>(config: ChatmolBioConfig, method: string, route: string, init: { body?: BodyInit; json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "X-API-Key": config.apiKey };
  let body: BodyInit | undefined = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${config.baseUrl}${route}`, { method, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try { detail = (JSON.parse(text) as { detail?: string }).detail || text; } catch { /* plain text */ }
    throw new Error(`ChatMol Bio ${method} ${route} failed (${res.status}): ${String(detail).slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

let catalogCache: { at: number; baseUrl: string; tools: BioToolInfo[] } | null = null;
const CATALOG_TTL_MS = 5 * 60_000;

async function listTools(config: ChatmolBioConfig): Promise<BioToolInfo[]> {
  if (catalogCache && catalogCache.baseUrl === config.baseUrl && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.tools;
  const tools = await request<BioToolInfo[]>(config, "GET", "/v1/tools");
  catalogCache = { at: Date.now(), baseUrl: config.baseUrl, tools };
  return tools;
}

function extensionFor(contentType: string, disposition: string): string {
  const match = /filename="?([^";]+)"?/.exec(disposition);
  if (match) {
    const ext = path.extname(match[1]);
    if (ext) return ext;
  }
  if (contentType.includes("zip")) return ".zip";
  if (contentType.includes("gzip") || contentType.includes("tar")) return ".tar.gz";
  if (contentType.includes("json")) return ".json";
  if (contentType.includes("text")) return ".txt";
  return ".bin";
}

/** Largest result archive we will download, and the cap on what it may contain. */
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;

/**
 * Reject archive entries that would write outside the target directory.
 * An absolute path, a `..` segment, or a link entry all escape the extraction
 * root, so the archive is refused rather than partially extracted.
 */
export function unsafeArchiveEntry(listingLine: string): string | null {
  const line = listingLine.trim();
  if (!line) return null;
  // `tar -tvf` output: the type is the first character of the mode column.
  const verbose = /^([bcdhlps-])[rwxSsTt-]{9}\s/.exec(line);
  const name = verbose ? line.replace(/^.*?\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?\s+/, "") : line;
  if (verbose && (verbose[1] === "l" || verbose[1] === "h")) return `link entry: ${name}`;
  if (verbose && verbose[1] !== "d" && verbose[1] !== "-") return `special entry: ${name}`;
  if (/\s->\s/.test(line)) return `link entry: ${name}`;
  if (name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) return `absolute path: ${name}`;
  if (name.split(/[\\/]/).some((segment) => segment === "..")) return `parent-directory path: ${name}`;
  return null;
}

async function tryExtract(archive: string, outDir: string): Promise<boolean> {
  try {
    // Vet the listing before writing anything: the archive comes from a
    // server, so path traversal, symlinks and entry-count bombs are refused.
    const listing = await execFileAsync("tar", ["-tvf", archive], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    const lines = listing.stdout.split("\n").filter((line) => line.trim());
    if (lines.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`archive has ${lines.length} entries (limit ${MAX_ARCHIVE_ENTRIES})`);
    }
    for (const line of lines) {
      const problem = unsafeArchiveEntry(line);
      if (problem) throw new Error(`refusing to extract — ${problem}`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    // bsdtar (macOS, Windows 10+) and GNU tar both read .tar.gz; bsdtar also reads .zip.
    await execFileAsync("tar", ["xf", archive, "-C", outDir, "--no-same-owner", "--no-same-permissions"], { timeout: 120_000 });
    return true;
  } catch (err) {
    console.warn(`[chatmol-bio] archive not extracted: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export const chatmolBioProvider: ComputeProvider = {
  id: CHATMOL_BIO_PROVIDER_ID,
  label: "ChatMol Bio (your API key)",
  kind: "direct",
  capabilities: () => (catalogCache?.tools ?? []).map((tool) => offeringId(tool.tool_name)),

  async availability() {
    const config = getChatmolBioConfig();
    if (!config.apiKey) {
      return { ok: false, reason: "ChatMol Bio API key is not set. Add it in Settings → API (keys look like cmol_...)." };
    }
    try {
      await listTools(config);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },

  async catalog() {
    const config = getChatmolBioConfig();
    const tools = await listTools(config);
    return tools.map((tool) => toOffering(tool));
  },

  async getOffering(id) {
    const toolName = toolNameFromOffering(id);
    if (!toolName) return null;
    const config = getChatmolBioConfig();
    try {
      return toOffering(await request<BioToolDetail>(config, "GET", `/v1/tools/${encodeURIComponent(toolName)}`));
    } catch {
      return null;
    }
  },

  async submit(req: ComputeRequest): Promise<ProviderJob> {
    const config = getChatmolBioConfig();
    const toolName = toolNameFromOffering(req.capability);
    if (!toolName) throw new Error(`Not a ChatMol Bio offering: ${req.capability}`);

    const { files, ...params } = req.inputs as { files?: unknown } & Record<string, unknown>;
    const form = new FormData();
    form.append("request", JSON.stringify({ tool: toolName, params }));
    for (const rel of Array.isArray(files) ? (files as unknown[]) : []) {
      if (typeof rel !== "string") continue;
      const abs = safeResolvePath(rel, req.sessionWorkspace);
      if (!abs || !fs.existsSync(abs)) throw new Error(`Input file not found in workspace: ${rel}`);
      form.append("files", new Blob([fs.readFileSync(abs)]), path.basename(abs));
    }
    const created = await request<BioJob>(config, "POST", "/v1/jobs", { body: form });
    const status = mapBioStatus(created.status);
    return {
      id: created.job_id,
      provider: this.id,
      capability: req.capability,
      status,
      providerStatus: created.status,
      output: `ChatMol Bio job ${created.job_id} submitted (${toolName}). It runs in the background; the app tracks it and will continue when it finishes.`,
      artifacts: [],
      trackedJob: {
        id: created.job_id,
        provider: "chatmol-bio",
        sessionId: req.sessionId,
        label: toolName,
        offering: req.capability,
        status: "pending",
        submittedAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
  },

  async getJob(id) {
    const config = getChatmolBioConfig();
    try {
      const job = await request<BioJob>(config, "GET", `/v1/jobs/${encodeURIComponent(id)}`);
      const status = mapBioStatus(job.status);
      const lines = [`ChatMol Bio job ${job.job_id} (${job.tool}): ${job.status}`];
      if (job.gpu_seconds != null) lines.push(`GPU seconds: ${job.gpu_seconds}`);
      if (job.error_message) lines.push(`Error: ${job.error_message}`);
      return {
        id: job.job_id,
        provider: this.id,
        capability: offeringId(job.tool),
        status,
        providerStatus: job.status,
        output: lines.join("\n"),
        artifacts: [],
      };
    } catch {
      return null;
    }
  },

  async cancel(id) {
    await request(getChatmolBioConfig(), "DELETE", `/v1/jobs/${encodeURIComponent(id)}`);
  },

  async downloadArtifacts(id, sessionWorkspace) {
    const config = getChatmolBioConfig();
    const res = await fetch(`${config.baseUrl}/v1/jobs/${encodeURIComponent(id)}/results`, { headers: { "X-API-Key": config.apiKey } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ChatMol Bio results download failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_ARCHIVE_BYTES) {
      throw new Error(`ChatMol Bio result is ${declared} bytes, above the ${MAX_ARCHIVE_BYTES} byte limit.`);
    }
    const ext = extensionFor(res.headers.get("content-type") || "", res.headers.get("content-disposition") || "");
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, "");
    const target = path.join(sessionWorkspace, `chatmol_bio_${safeId}${ext}`);
    // Stream to disk with a running cap so an unbounded response cannot fill
    // the disk or the heap.
    const body = res.body;
    if (!body) throw new Error("ChatMol Bio returned an empty response body.");
    const handle = fs.openSync(target, "w", 0o600);
    let written = 0;
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > MAX_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`ChatMol Bio result exceeded the ${MAX_ARCHIVE_BYTES} byte limit.`);
        }
        fs.writeSync(handle, value);
      }
    } catch (err) {
      fs.closeSync(handle);
      fs.rmSync(target, { force: true });
      throw err;
    }
    fs.closeSync(handle);
    const saved = [target];
    if (ext === ".zip" || ext === ".tar.gz") {
      const outDir = path.join(sessionWorkspace, `chatmol_bio_${safeId}`);
      if (await tryExtract(target, outDir)) {
        const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
        saved.push(...walk(outDir));
      }
    }
    return saved;
  },
};
