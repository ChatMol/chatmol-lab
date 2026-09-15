/**
 * Compute provider registry: which provider serves a capability under the
 * current Compute backend setting, and the single entry point tools use.
 */
import type { ToolResult } from "../tools";
import { loadSettings, type ComputeBackend } from "../settings";
import { chatmolBioProvider } from "./chatmol-bio";
import { chatmolRouterProvider } from "./chatmol-router";
import { nvidiaDirectProvider, NVIDIA_CAPABILITIES } from "./nvidia-direct";
import type { ComputeProvider, ComputeRequest } from "./provider";
import { wemolDirectProvider, WEMOL_CAPABILITIES } from "./wemol-direct";

export const DIRECT_PROVIDERS: ComputeProvider[] = [nvidiaDirectProvider, wemolDirectProvider];

/** Providers that expose a catalog of offerings (async jobs, generic compute tools). */
export const CATALOG_PROVIDERS: ComputeProvider[] = [chatmolBioProvider, chatmolRouterProvider];

export function listComputeProviders(): ComputeProvider[] {
  return [...DIRECT_PROVIDERS, ...CATALOG_PROVIDERS];
}

export function getComputeProvider(id: string): ComputeProvider | null {
  return [...(catalogOverride ?? []), ...listComputeProviders()].find((provider) => provider.id === id) ?? null;
}

let catalogOverride: ComputeProvider[] | null = null;

/** Tests can replace the catalog providers. */
export function setCatalogProviders(providers: ComputeProvider[] | null): void {
  catalogOverride = providers;
}

/** Catalog providers with credentials configured (their tools join the run). */
export async function availableCatalogProviders(userId: string | null): Promise<ComputeProvider[]> {
  const checks = await Promise.all((catalogOverride ?? CATALOG_PROVIDERS).map(async (provider) => ({ provider, ok: (await provider.availability({ userId }).catch(() => ({ ok: false }))).ok })));
  return checks.filter((entry) => entry.ok).map((entry) => entry.provider);
}

const CAPABILITY_IDS = new Set<string>([...NVIDIA_CAPABILITIES, ...WEMOL_CAPABILITIES]);

export function isComputeCapability(name: string): boolean {
  return CAPABILITY_IDS.has(name) || isRetiredCapability(name);
}

export function isRetiredCapability(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETIRED_CAPABILITIES, name);
}

/**
 * Capabilities a provider has withdrawn. They stay routable so an old session
 * or a compacted plan that still names one gets told what happened and what to
 * use instead, rather than "Unknown tool".
 */
export const RETIRED_CAPABILITIES: Record<string, string> = {
  nvidia_esmfold:
    "NVIDIA retired the ESMFold NIM endpoint (it now answers 404), so this tool no longer exists. " +
    "For a single-sequence fold use nvidia_openfold2, or nvidia_boltz2 for complexes and ligands.",
};

/** Default timeouts (seconds) for capability tools; a gate may cap them further. */
export const COMPUTE_TOOL_TIMEOUTS: Record<string, number> = {
  nvidia_openfold2: 30,
  nvidia_openfold3: 120,
  nvidia_boltz2: 300,
  nvidia_rfdiffusion: 60,
  nvidia_diffdock: 60,
  nvidia_colabfold_msa: 120,
  nvidia_proteinmpnn: 30,
  nvidia_genmol: 30,
  nvidia_molmim: 30,
  nvidia_evo2: 30,
  wemol_cli: 300,
};

let override: ((capability: string, backend: ComputeBackend) => ComputeProvider | null) | null = null;

/** Tests can install a resolver. */
export function setComputeProviderResolver(resolver: typeof override): void {
  override = resolver;
}

/**
 * Picks the provider for a capability.
 *
 * The `chatmol-cloud` backend fails closed: when the Router cannot serve the
 * capability the call stops with an explanation instead of quietly running on
 * the user's own NVIDIA or WeMol account. A silent fallback would send
 * research data to a backend the user did not choose, bill the wrong account,
 * and skip the wallet's quote and approval step.
 */
export async function resolveComputeProvider(
  capability: string,
  backend: ComputeBackend = loadSettings().computeBackend,
): Promise<{ provider: ComputeProvider; fallbackReason?: string } | { provider: null; reason: string }> {
  if (override) {
    const chosen = override(capability, backend);
    if (chosen) return { provider: chosen };
  }
  const direct = DIRECT_PROVIDERS.find((p) => p.capabilities().includes(capability)) ?? null;
  if (backend === "chatmol-cloud") {
    const availability = await chatmolRouterProvider.availability({ userId: null });
    if (availability.ok && chatmolRouterProvider.capabilities().includes(capability)) {
      return { provider: chatmolRouterProvider };
    }
    const why = availability.ok
      ? `ChatMol Cloud does not offer ${capability}.`
      : availability.reason || "ChatMol Cloud is unavailable.";
    const alternative = direct
      ? ` ${direct.label} could run it with your own credentials — switch Compute backend to Direct in Settings → API if that is what you want.`
      : "";
    return { provider: null, reason: `${why} The run was stopped rather than moved to another backend.${alternative}` };
  }
  if (direct) return { provider: direct };
  return { provider: null, reason: `No compute provider serves ${capability}.` };
}

export async function runComputeCapability(
  capability: string,
  inputs: Record<string, unknown>,
  ctx: Omit<ComputeRequest, "capability" | "inputs">,
): Promise<ToolResult> {
  const retired = RETIRED_CAPABILITIES[capability];
  if (retired) return { output: retired, success: false };
  const resolved = await resolveComputeProvider(capability);
  if (!resolved.provider) return { output: resolved.reason, success: false };
  const { provider } = resolved;
  const availability = await provider.availability({ userId: ctx.userId });
  if (!availability.ok) return { output: availability.reason || `${provider.label} is not available.`, success: false };
  try {
    const job = await provider.submit({ capability, inputs, ...ctx });
    const note = resolved.fallbackReason ? `[compute: ${resolved.fallbackReason}]\n` : "";
    return { output: note + job.output, success: job.status === "succeeded", computeJob: job.trackedJob };
  } catch (err) {
    return { output: `${provider.label} error: ${err instanceof Error ? err.message : String(err)}`, success: false };
  }
}
