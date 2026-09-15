/**
 * ChatMol Router client — the provider-neutral control plane façade from
 * docs/chatmol-router-design.md §4: `/v1/capabilities`, `/v1/offerings`,
 * `/v1/quotes`, `/v1/jobs` (+ confirm / cancel / events / artifacts),
 * `/v1/artifacts/{id}/download`, Bearer auth with a desktop token or a
 * `cmr_live_*` API key.
 *
 * A plain HTTP client: it sends a capability request and reads back a job.
 * Everything that matters commercially — whether the account may compute,
 * the price, which offering runs it — is decided by the Router, never here.
 * The client is public by design; a copy of it buys nothing without a valid
 * account and balance on the server side. Jobs are asynchronous: `submit`
 * returns the queued job and the desktop poller tracks it.
 */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { getDesktopSyncToken } from "../settings";
import type { ComputeOffering, ComputeProvider, ComputeQuote, ComputeRequest, ProviderJob, ProviderJobStatus } from "./provider";

export const CHATMOL_ROUTER_PROVIDER_ID = "chatmol-router";
const ROUTER_URL = () => (process.env.CHATMOL_ROUTER_URL || "https://api.chatmol.org").replace(/\/+$/, "");

interface RouterJobDto {
  id: string;
  capability: string;
  offering?: string;
  offering_version?: string;
  status: ProviderJobStatus;
  provider_status?: string;
  progress_percent?: number | null;
  output?: string;
  error?: string;
  artifacts?: Array<{ id: string; name: string; download_url?: string }>;
}

interface RouterOfferingDto {
  id: string;
  provider: string;
  offering: string;
  capability: string;
  label?: string;
  description?: string;
  offering_version?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  price_model?: { kind: "fixed" | "estimate" | "usage" | "quote_required"; note?: string };
}

/**
 * Artifact URLs come back from the Router and may point at third-party
 * pre-signed storage. The Bearer token is only ever sent to the Router's own
 * origin over HTTPS, so a tampered or redirected URL cannot walk off with it.
 */
export function isRouterOrigin(url: string, base = ROUTER_URL()): boolean {
  try {
    const target = new URL(url);
    const origin = new URL(base);
    if (target.origin !== origin.origin) return false;
    return target.protocol === "https:" || target.hostname === "localhost" || target.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function accessToken(): string {
  return process.env.CHATMOL_ROUTER_API_KEY || getDesktopSyncToken() || "";
}

async function call<T>(method: string, route: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const token = accessToken();
  const res = await fetch(`${ROUTER_URL()}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ChatMol Router ${method} ${route} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

let offeringCache: { at: number; offerings: ComputeOffering[] } | null = null;

function toOffering(dto: RouterOfferingDto): ComputeOffering {
  return {
    id: dto.id || `${dto.provider}/${dto.offering}`,
    provider: dto.provider,
    name: dto.offering,
    label: dto.label || `${dto.provider}/${dto.offering}`,
    description: dto.description || "",
    capability: dto.capability,
    version: dto.offering_version,
    inputSchema: dto.input_schema || { type: "object", properties: {} },
    outputSchema: dto.output_schema,
    priceModel: dto.price_model,
  };
}

async function fetchOfferings(): Promise<ComputeOffering[]> {
  if (offeringCache && Date.now() - offeringCache.at < 5 * 60_000) return offeringCache.offerings;
  try {
    const data = await call<{ offerings: RouterOfferingDto[] }>("GET", "/v1/offerings");
    offeringCache = { at: Date.now(), offerings: data.offerings.map(toOffering) };
  } catch {
    offeringCache = { at: Date.now(), offerings: [] };
  }
  return offeringCache.offerings;
}

function toJob(dto: RouterJobDto, artifacts: string[] = []): ProviderJob {
  return {
    id: dto.id,
    provider: CHATMOL_ROUTER_PROVIDER_ID,
    capability: dto.offering || dto.capability,
    status: dto.status,
    providerStatus: dto.provider_status,
    progressPercent: dto.progress_percent ?? null,
    output: dto.status === "failed" ? `ChatMol Router job failed: ${dto.error || "unknown error"}` : dto.output || `ChatMol Router job ${dto.id}: ${dto.status}`,
    artifacts,
  };
}

export const chatmolRouterProvider: ComputeProvider = {
  id: CHATMOL_ROUTER_PROVIDER_ID,
  label: "ChatMol Router",
  kind: "gateway",
  capabilities: () => (offeringCache?.offerings ?? []).map((offering) => offering.id),
  async availability() {
    if (!accessToken()) return { ok: false, reason: "ChatMol Router is not connected. Connect ChatMol Cloud in Settings → General or set CHATMOL_ROUTER_API_KEY." };
    const offerings = await fetchOfferings();
    return offerings.length > 0 ? { ok: true } : { ok: false, reason: "ChatMol Router lists no offering for this account yet." };
  },
  async catalog() {
    return fetchOfferings();
  },
  async getOffering(id) {
    const [provider, ...rest] = id.split("/");
    if (!provider || rest.length === 0) return null;
    try {
      return toOffering(await call<RouterOfferingDto>("GET", `/v1/offerings/${encodeURIComponent(provider)}/${encodeURIComponent(rest.join("/"))}`));
    } catch {
      return null;
    }
  },
  async quote(request: ComputeRequest): Promise<ComputeQuote | null> {
    try {
      const quote = await call<{ id: string; total: number; currency: string; expires_at?: string; note?: string }>("POST", "/v1/quotes", {
        offering: request.capability,
        inputs: request.inputs,
        constraints: request.constraints,
      });
      return { amount: quote.total, currency: quote.currency, note: [quote.note, quote.expires_at ? `expires ${quote.expires_at}` : ""].filter(Boolean).join("; ") || undefined };
    } catch {
      return null;
    }
  },
  async submit(request: ComputeRequest): Promise<ProviderJob> {
    const created = await call<RouterJobDto>("POST", "/v1/jobs", {
      offering: request.capability,
      inputs: request.inputs,
      constraints: request.constraints,
      client_session_id: request.sessionId,
    }, { "Idempotency-Key": randomUUID() });
    const job = toJob(created);
    job.output = `ChatMol Router job ${job.id} submitted (${job.capability}); status ${job.status}. It runs in the background; the app tracks it.`;
    job.trackedJob = {
      id: job.id,
      provider: "chatmol-router",
      sessionId: request.sessionId,
      label: request.capability,
      offering: request.capability,
      status: "pending",
      submittedAt: Date.now(),
      updatedAt: Date.now(),
    };
    return job;
  },
  async getJob(id: string) {
    try {
      return toJob(await call<RouterJobDto>("GET", `/v1/jobs/${encodeURIComponent(id)}`));
    } catch {
      return null;
    }
  },
  async cancel(id: string) {
    await call("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`);
  },
  async downloadArtifacts(id: string, sessionWorkspace: string) {
    const data = await call<{ artifacts: Array<{ id: string; name: string; download_url?: string }> }>("GET", `/v1/jobs/${encodeURIComponent(id)}/artifacts`);
    const saved: string[] = [];
    for (const artifact of data.artifacts ?? []) {
      const url = artifact.download_url || `${ROUTER_URL()}/v1/artifacts/${encodeURIComponent(artifact.id)}/download`;
      const sameOrigin = isRouterOrigin(url);
      if (!sameOrigin && !/^https:/i.test(url)) continue;
      const res = await fetch(url, {
        headers: sameOrigin ? { Authorization: `Bearer ${accessToken()}` } : {},
        redirect: "follow",
      });
      if (!res.ok) continue;
      const target = path.join(sessionWorkspace, path.basename(artifact.name || artifact.id));
      fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
      saved.push(target);
    }
    return saved;
  },
};
