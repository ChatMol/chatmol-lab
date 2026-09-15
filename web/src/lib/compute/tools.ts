/**
 * Generic compute tools (ChatMol Router design §3 "Desktop 工具面").
 *
 * Instead of one LLM tool per offering, the agent gets a small stable set:
 * search the catalog, read an offering's schema, quote, submit (returns at
 * once — the desktop poller tracks the job), check, cancel and import
 * artifacts. They join a run only when a catalog provider (ChatMol Bio,
 * ChatMol Router) is configured.
 */
import type { ToolDefinition, ToolResult } from "../tools";
import type { ComputeOffering, ComputeProvider } from "./provider";
import { toTrackedStatus } from "./provider";
import { availableCatalogProviders, getComputeProvider } from "./registry";

export const COMPUTE_TOOL_NAMES = [
  "search_compute_capabilities",
  "get_compute_offering",
  "quote_compute_job",
  "submit_compute_job",
  "get_compute_job",
  "cancel_compute_job",
  "import_compute_artifacts",
] as const;

export function isGenericComputeTool(name: string): boolean {
  return (COMPUTE_TOOL_NAMES as readonly string[]).includes(name);
}

export const COMPUTE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "search_compute_capabilities",
    description: "Search the compute catalog (ChatMol Bio GPU tools, ChatMol Router offerings) for offerings matching a query. Returns offering ids like `chatmol-bio/esmfold_predict_structure` with a one-line description. Call this before submit_compute_job when you do not already know the offering id.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Free text or keywords (e.g. 'structure prediction', 'docking', 'boltz')." },
        provider: { type: "string", description: "Restrict to one provider id (chatmol-bio, chatmol-router)." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
    },
  },
  {
    name: "get_compute_offering",
    description: "Get one offering's input schema, category, GPU type and price model. Always read the schema before submitting: parameter names must match exactly.",
    input_schema: {
      type: "object" as const,
      properties: { offering: { type: "string", description: "Offering id, e.g. chatmol-bio/esmfold_predict_structure" } },
      required: ["offering"],
    },
  },
  {
    name: "quote_compute_job",
    description: "Ask the provider for a price/time estimate before submitting an expensive job. Returns null when the provider bills purely by usage.",
    input_schema: {
      type: "object" as const,
      properties: {
        offering: { type: "string" },
        inputs: { type: "object", description: "Parameters per the offering's input schema." },
      },
      required: ["offering", "inputs"],
    },
  },
  {
    name: "submit_compute_job",
    description: "Submit a background compute job to a catalog offering and return immediately with its job id. Workspace files go in `inputs.files` (array of workspace paths) when the offering accepts files. The app tracks the job and continues the conversation when it finishes; do NOT poll in a loop.",
    input_schema: {
      type: "object" as const,
      properties: {
        offering: { type: "string", description: "Offering id from search_compute_capabilities." },
        inputs: { type: "object", description: "Parameters per the offering's input schema (plus `files` for uploads)." },
        label: { type: "string", description: "Short human label for the jobs indicator." },
      },
      required: ["offering", "inputs"],
    },
  },
  {
    name: "get_compute_job",
    description: "Check a background compute job's status once (use only when the user asks; the app polls automatically).",
    input_schema: {
      type: "object" as const,
      properties: {
        provider: { type: "string", description: "Provider id (chatmol-bio, chatmol-router)." },
        job_id: { type: "string" },
      },
      required: ["provider", "job_id"],
    },
  },
  {
    name: "cancel_compute_job",
    description: "Cancel a running background compute job.",
    input_schema: {
      type: "object" as const,
      properties: { provider: { type: "string" }, job_id: { type: "string" } },
      required: ["provider", "job_id"],
    },
  },
  {
    name: "import_compute_artifacts",
    description: "Download a finished compute job's results into the session workspace (archives are extracted). Returns the saved paths; then inspect them and save_artifact the important files.",
    input_schema: {
      type: "object" as const,
      properties: { provider: { type: "string" }, job_id: { type: "string" } },
      required: ["provider", "job_id"],
    },
  },
];

export function buildComputePromptSection(providers: ComputeProvider[]): string {
  if (providers.length === 0) return "";
  const names = providers.map((p) => `${p.label} (provider id: ${p.id})`).join(", ");
  return `\n\n## Compute catalog (background GPU jobs)
Connected: ${names}. Use search_compute_capabilities → get_compute_offering → submit_compute_job. A submitted job returns at once and is tracked by the app; report the job id and stop. When the app tells you a job finished, call import_compute_artifacts, inspect the files, save_artifact the results and summarize. Use quote_compute_job first for large or expensive runs.`;
}

function fmtOffering(o: ComputeOffering): string {
  const bits = [o.id, o.category ? `[${o.category}]` : "", o.gpuType ? `(${o.gpuType})` : ""].filter(Boolean).join(" ");
  return `${bits} — ${o.description.split("\n")[0].slice(0, 160)}`;
}

function providerForOffering(offering: string, providers: ComputeProvider[]): ComputeProvider | null {
  const prefix = offering.split("/")[0];
  return providers.find((p) => p.id === prefix) ?? providers.find((p) => p.id === "chatmol-router") ?? null;
}

export interface ComputeToolContext {
  sessionWorkspace: string;
  sessionId: string;
  userId: string | null;
  signal?: AbortSignal;
}

export async function executeGenericComputeTool(name: string, input: Record<string, unknown>, ctx: ComputeToolContext): Promise<ToolResult> {
  const providers = await availableCatalogProviders(ctx.userId);
  if (providers.length === 0) {
    return { output: "No compute catalog is connected. Add a ChatMol Bio API key (Settings → API) or connect ChatMol Cloud.", success: false };
  }
  try {
    switch (name) {
      case "search_compute_capabilities": {
        const query = String(input.query || "").toLowerCase().split(/\s+/).filter(Boolean);
        const wanted = typeof input.provider === "string" ? input.provider : null;
        const limit = Math.max(1, Math.min(Number(input.limit) || 20, 100));
        const offerings: ComputeOffering[] = [];
        for (const provider of providers) {
          if (wanted && provider.id !== wanted) continue;
          offerings.push(...(await provider.catalog?.() ?? []));
        }
        const scored = offerings
          .map((o) => {
            const hay = `${o.id} ${o.label} ${o.description} ${o.category || ""}`.toLowerCase();
            const score = query.length === 0 ? 1 : query.filter((term) => hay.includes(term)).length;
            return { o, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        if (scored.length === 0) return { output: `No offering matches "${input.query || ""}" (${offerings.length} in catalog).`, success: true };
        return { output: `${scored.length} of ${offerings.length} offerings:\n${scored.map((entry) => fmtOffering(entry.o)).join("\n")}`, success: true };
      }
      case "get_compute_offering": {
        const id = String(input.offering || "");
        const provider = providerForOffering(id, providers);
        const offering = await provider?.getOffering?.(id);
        if (!offering) return { output: `Offering not found: ${id}`, success: false };
        return {
          output: [
            `${offering.id} (${offering.label})`,
            offering.description,
            offering.category ? `Category: ${offering.category}` : "",
            offering.gpuType ? `GPU: ${offering.gpuType}` : "",
            offering.version ? `Version: ${offering.version}` : "",
            offering.priceModel ? `Pricing: ${offering.priceModel.kind}${offering.priceModel.note ? ` — ${offering.priceModel.note}` : ""}` : "",
            `Input schema:\n${JSON.stringify(offering.inputSchema, null, 2)}`,
          ].filter(Boolean).join("\n"),
          success: true,
        };
      }
      case "quote_compute_job": {
        const id = String(input.offering || "");
        const provider = providerForOffering(id, providers);
        if (!provider) return { output: `No provider serves ${id}`, success: false };
        const quote = await provider.quote?.({ capability: id, inputs: (input.inputs as Record<string, unknown>) || {}, ...ctx });
        return { output: quote ? `Quote: ${quote.amount} ${quote.currency}${quote.note ? ` (${quote.note})` : ""}` : `${provider.label} bills by usage; no fixed quote for ${id}.`, success: true };
      }
      case "submit_compute_job": {
        const id = String(input.offering || "");
        const provider = providerForOffering(id, providers);
        if (!provider) return { output: `No provider serves ${id}`, success: false };
        const job = await provider.submit({ capability: id, inputs: (input.inputs as Record<string, unknown>) || {}, ...ctx });
        if (job.trackedJob && typeof input.label === "string" && input.label.trim()) job.trackedJob.label = input.label.trim();
        return { output: job.output, success: job.status !== "failed", computeJob: job.trackedJob };
      }
      case "get_compute_job":
      case "cancel_compute_job":
      case "import_compute_artifacts": {
        const provider = getComputeProvider(String(input.provider || ""));
        const jobId = String(input.job_id || "");
        if (!provider || !jobId) return { output: "provider and job_id are required.", success: false };
        if (name === "cancel_compute_job") {
          await provider.cancel(jobId);
          return { output: `Cancellation requested for ${provider.label} job ${jobId}.`, success: true };
        }
        if (name === "import_compute_artifacts") {
          if (!provider.downloadArtifacts) return { output: `${provider.label} has no downloadable artifacts.`, success: false };
          const saved = await provider.downloadArtifacts(jobId, ctx.sessionWorkspace);
          return { output: saved.length > 0 ? `Imported ${saved.length} file(s):\n${saved.join("\n")}` : "The job produced no files.", success: saved.length > 0 };
        }
        const job = await provider.getJob(jobId);
        if (!job) return { output: `Job ${jobId} not found at ${provider.label}.`, success: false };
        return { output: `${job.output}\nTracked status: ${toTrackedStatus(job.status)}`, success: true };
      }
      default:
        return { output: `Unknown compute tool: ${name}`, success: false };
    }
  } catch (err) {
    return { output: `${name} error: ${err instanceof Error ? err.message : String(err)}`, success: false };
  }
}
