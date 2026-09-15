import type { HostedTools } from "@/lib/hosted-tools";

/** ChatMol Lab (open source) has no hosted-only tools. */
export const hostedTools: HostedTools = {
  definitions: [],
  timeouts: {},
  systemPromptLines: [],
  async execute() { return null; },
};
