/**
 * Subagents (server side).
 *
 * Definitions come from `agents/<id>.md` files discovered by the agent
 * registry (bundled plugin `plugins/chatmol/agents`, installed plugins, the
 * user's `~/.chatmol-lab/agents` / `~/.claude/agents`, and the session
 * workspace) plus the runtime built-ins in `./builtin-agents` (`general`).
 * `wemol-docs` and `wemol-monitor` ship in the bundled plugin and are
 * published to the ChatMol-Skills repository.
 *
 * Client code must import constants from `./subagent-defaults` instead of
 * this module (the registry touches the filesystem).
 */
import type { ToolDefinition } from "./tools";
import type { ApiConfig } from "./settings";
import { providerSupportsThinkingFields } from "./llm-providers";
import { getAgent, listAgents, type AgentDefinition, type AgentRegistryOptions } from "./agent-registry";
import { ALL_TOOLS_SENTINEL, RUN_SUBAGENT_TOOL_NAME } from "./subagent-defaults";

export { ALL_TOOLS_SENTINEL, RUN_SUBAGENT_TOOL_NAME };

/** Any discovered agent id (historically a closed union of the four built-ins). */
export type FixedSubagentId = string;

export type FixedSubagent = AgentDefinition;

export const SUBAGENT_MAX_OUTPUT_TOKENS = 65536;
export const SUBAGENT_MAX_LOOPS = 30;

export interface SubagentLookup {
  /** Session workspace, so workspace-level `.chatmol/agents` are visible. */
  cwd?: string;
  /** Test hook forwarded to the registry. */
  registry?: AgentRegistryOptions;
}

function registryOptions(lookup: SubagentLookup = {}): AgentRegistryOptions {
  return { ...(lookup.registry || {}), ...(lookup.cwd ? { cwd: lookup.cwd } : {}) };
}

export function listFixedSubagents(lookup: SubagentLookup = {}): FixedSubagent[] {
  return listAgents(registryOptions(lookup));
}

export function getFixedSubagent(id: string, lookup: SubagentLookup = {}): FixedSubagent | null {
  return getAgent(id, registryOptions(lookup)) || null;
}

export function getFixedSubagents(ids: FixedSubagentId[], lookup: SubagentLookup = {}): FixedSubagent[] {
  const wanted = new Set(ids);
  return listFixedSubagents(lookup).filter((agent) => wanted.has(agent.id));
}

/** Keep only ids that resolve to a discovered agent (order preserved, de-duplicated). */
export function normalizeFixedSubagentIds(ids: unknown, lookup: SubagentLookup = {}): FixedSubagentId[] {
  if (!Array.isArray(ids)) return [];
  const known = new Set(listFixedSubagents(lookup).map((agent) => agent.id));
  const result: FixedSubagentId[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !known.has(id) || result.includes(id)) continue;
    result.push(id);
  }
  return result;
}

export function buildRunSubagentToolDefinition(ids: FixedSubagentId[], lookup: SubagentLookup = {}): ToolDefinition | null {
  const agents = getFixedSubagents(ids, lookup);
  if (agents.length === 0) return null;
  const catalog = agents.map((agent) => `- ${agent.id}: ${agent.description}`).join("\n");
  return {
    name: RUN_SUBAGENT_TOOL_NAME,
    description:
      "Delegate a bounded subtask to a subagent that runs its own tool loop and returns a report. " +
      "To run independent tasks in parallel, emit several run_subagent calls in the same turn — they execute concurrently. " +
      "Give each subagent a complete, self-contained task and the context it needs (paths, IDs, parameters).\n" +
      `Available agents:\n${catalog}`,
    input_schema: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string",
          enum: agents.map((agent) => agent.id),
          description: "Enabled subagent to run.",
        },
        task: {
          type: "string",
          description: "Specific delegated task. Keep it narrow and outcome-oriented.",
        },
        context: {
          type: "string",
          description: "Relevant context, files, job IDs, constraints, or prior findings for the subagent.",
        },
      },
      required: ["agent_id", "task"],
    },
  };
}

/** System-prompt section for the main agent: what each enabled agent is for. */
export function buildFixedSubagentPrompt(ids: FixedSubagentId[], lookup: SubagentLookup = {}): string {
  const agents = getFixedSubagents(ids, lookup);
  if (agents.length === 0) return "";
  return `\n\n## Enabled Subagents\nThese subagents are available through the \`${RUN_SUBAGENT_TOOL_NAME}\` tool. Delegate bounded subtasks to them when their description applies; do not merely mention them in prose.\n\nDelegation rules:\n- Follow each agent's description for when to use it; call it before acting on work it owns (for example, a WeMol docs agent before proposing payloads, a WeMol monitor agent for job status).\n- When the user asks for several independent things (or "use N subagents"), issue one ${RUN_SUBAGENT_TOOL_NAME} call per task in the same turn so they run in parallel, then integrate the reports.\n- Use the subagent result as evidence, then continue as the main agent.\n\n${agents
    .map((agent) => `### ${agent.name} (\`${agent.id}\`)\n${agent.description}`)
    .join("\n\n")}`;
}

/**
 * Subagents run on the chat model (or the fast model / an explicit model id
 * when the agent file says so) with a larger output budget. DeepSeek-style
 * thinking fields are only attached when the provider accepts them.
 */
export function getSubagentApiConfig(apiConfig: ApiConfig, agent?: Pick<FixedSubagent, "model">, fastApiConfig?: ApiConfig): ApiConfig {
  const wanted = (agent?.model || "main").trim();
  const base = wanted === "fast" && fastApiConfig ? fastApiConfig : apiConfig;
  const config: ApiConfig = {
    ...base,
    maxOutputTokens: Math.max(base.maxOutputTokens || 0, SUBAGENT_MAX_OUTPUT_TOKENS),
  };
  if (wanted !== "main" && wanted !== "fast") config.model = wanted;
  if (providerSupportsThinkingFields(config.provider)) {
    config.thinking = { type: "enabled" };
    config.reasoningEffort = "high";
  }
  return config;
}
