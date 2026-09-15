/**
 * Client-safe subagent constants (no fs / registry imports) shared by the
 * Zustand store, the pickers and the server-side registry.
 */

/** Model-facing delegation tool. */
export const RUN_SUBAGENT_TOOL_NAME = "run_subagent";

/** `tools` entry meaning "every tool except create_plan and run_subagent". */
export const ALL_TOOLS_SENTINEL = "*";
