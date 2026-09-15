/**
 * Subagents that belong to the runtime itself, not to any plugin.
 *
 * `general` is the harness's own "spawn a child agent" capability: it runs
 * every tool except plan control and recursion. Plugins and workspace files
 * cannot shadow a built-in id; the registry ignores such files with a warning.
 */
import type { AgentDefinition } from "./agent-registry";
import { ALL_TOOLS_SENTINEL } from "./subagent-defaults";

export const BUILTIN_AGENT_SOURCE = "built-in";

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: "general",
    // Shown verbatim in the transcript, which is often English; the bilingual
    // description below is what the model matches on.
    name: "General subagent",
    // English only: every description here goes into the system prompt, and
    // Chinese text in it pulled English conversations into Chinese answers.
    description:
      "Hand off a self-contained subtask and get the result back as evidence: run a prediction, " +
      "analyze a file, build a figure. Issue one run_subagent call per independent task in the " +
      "same turn so they run in parallel.",
    prompt: `Role: general-purpose worker.
- Complete the delegated task end to end with the available tools; do not ask the user questions — make reasonable assumptions and state them.
- Work only inside the session workspace; save important outputs as files and register them with save_artifact.
- Report exactly: what was run, key numbers/IDs/scores, file paths produced, and any failure with its cause.
- Keep the final report under ~400 words; the main agent will integrate it.`,
    toolNames: [ALL_TOOLS_SENTINEL],
    model: "main",
    skills: [],
    source: BUILTIN_AGENT_SOURCE,
    rank: 0,
    path: "",
  },
];

export function isBuiltinAgentId(id: string): boolean {
  return BUILTIN_AGENTS.some((agent) => agent.id === id);
}
