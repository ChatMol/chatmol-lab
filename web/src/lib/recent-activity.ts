const DEFAULT_SESSION_TITLE = "New Research Session";

export const RECENT_ACTIVITY_WELCOME =
  "Welcome to ChatMol Lab! Start a conversation to explore protein design, structure prediction, molecular dynamics, and more.";

export interface RecentActivityUsageInput {
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface RecentActivitySessionInput {
  id?: string;
  title?: string | null;
  messages?: unknown;
  plan?: unknown;
  artifacts?: unknown;
  updatedAt?: Date | string | number | null;
}

export interface RecentActivitySessionSummary {
  id?: string;
  title: string;
  updatedAt?: string;
  recentUserRequests: string[];
  recentAssistantResults: string[];
  planItems: string[];
  artifactItems: string[];
  toolItems: string[];
}

export interface RecentActivityContext {
  generatedAt: string;
  sessions: RecentActivitySessionSummary[];
  usage: {
    apiCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  const cleaned = compactWhitespace(value);
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const record = asRecord(block);
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  const record = asRecord(content);
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  return "";
}

function timestampLabel(value: Date | string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function summarizePlan(plan: unknown): string[] {
  return asArray(plan)
    .map((item) => {
      const record = asRecord(item);
      const title = typeof record.title === "string" ? record.title : "";
      if (!title) return "";
      const status = typeof record.status === "string" ? record.status : "pending";
      return `${status}: ${truncate(title, 90)}`;
    })
    .filter(Boolean)
    .slice(0, 6);
}

function summarizeArtifacts(artifacts: unknown): string[] {
  return asArray(artifacts)
    .map((item) => {
      const record = asRecord(item);
      const name = typeof record.name === "string" ? record.name : "";
      const path = typeof record.path === "string" ? record.path : "";
      const type = typeof record.type === "string" ? record.type : "";
      const label = name || path;
      if (!label) return "";
      return truncate([label, type ? `(${type})` : ""].filter(Boolean).join(" "), 120);
    })
    .filter(Boolean)
    .slice(0, 6);
}

function summarizeToolCalls(messages: unknown[]): string[] {
  const tools: string[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    for (const tool of asArray(record.toolCalls)) {
      const toolRecord = asRecord(tool);
      const name = typeof toolRecord.name === "string" ? toolRecord.name : "";
      if (!name) continue;
      const status = typeof toolRecord.status === "string" ? toolRecord.status : "";
      tools.push([name, status].filter(Boolean).join(": "));
    }
    for (const block of asArray(record.content)) {
      const blockRecord = asRecord(block);
      if (blockRecord.type !== "tool_use") continue;
      const name = typeof blockRecord.name === "string" ? blockRecord.name : "";
      if (name) tools.push(name);
    }
  }
  return [...new Set(tools)].slice(-8);
}

function summarizeMessages(messages: unknown[]): Pick<RecentActivitySessionSummary, "recentUserRequests" | "recentAssistantResults"> {
  const recentUserRequests: string[] = [];
  const recentAssistantResults: string[] = [];

  for (const raw of messages.slice().reverse()) {
    const message = asRecord(raw);
    const role = typeof message.role === "string" ? message.role : "";
    const text = truncate(textFromContent(message.content), 220);
    if (!text) continue;
    if (role === "user" && recentUserRequests.length < 3) {
      recentUserRequests.push(text);
    } else if (role === "assistant" && recentAssistantResults.length < 3) {
      recentAssistantResults.push(text);
    }
    if (recentUserRequests.length >= 3 && recentAssistantResults.length >= 3) break;
  }

  return {
    recentUserRequests: recentUserRequests.reverse(),
    recentAssistantResults: recentAssistantResults.reverse(),
  };
}

export function buildRecentActivityContext(
  sessions: RecentActivitySessionInput[],
  usage: RecentActivityUsageInput,
  now = new Date(),
): RecentActivityContext {
  const sessionSummaries = sessions.map((session) => {
    const messages = asArray(session.messages);
    const messageSummary = summarizeMessages(messages);
    const title = compactWhitespace(session.title || "") || DEFAULT_SESSION_TITLE;
    return {
      id: session.id,
      title,
      updatedAt: timestampLabel(session.updatedAt),
      ...messageSummary,
      planItems: summarizePlan(session.plan),
      artifactItems: summarizeArtifacts(session.artifacts),
      toolItems: summarizeToolCalls(messages),
    };
  });

  const inputTokens = Math.max(0, usage.inputTokens || 0);
  const outputTokens = Math.max(0, usage.outputTokens || 0);
  return {
    generatedAt: now.toISOString(),
    sessions: sessionSummaries,
    usage: {
      apiCalls: Math.max(0, usage.apiCalls || 0),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

export function buildRecentActivityPrompt(context: RecentActivityContext): string {
  const sessionLines = context.sessions.map((session, index) => {
    return [
      `Session ${index + 1}: ${session.title}`,
      session.updatedAt ? `Updated: ${session.updatedAt}` : "",
      session.recentUserRequests.length > 0 ? `User asked: ${session.recentUserRequests.join(" | ")}` : "",
      session.recentAssistantResults.length > 0 ? `Assistant reported: ${session.recentAssistantResults.join(" | ")}` : "",
      session.planItems.length > 0 ? `Plan: ${session.planItems.join(" | ")}` : "",
      session.artifactItems.length > 0 ? `Artifacts/files: ${session.artifactItems.join(" | ")}` : "",
      session.toolItems.length > 0 ? `Tools: ${session.toolItems.join(", ")}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return `You summarize recent work in ChatMol Lab, a Claude-science style agent for computational biology, molecular modeling, and drug discovery.

Write a concise 3-5 line status report for the dashboard.
Start exactly with: "ChatMol Lab helped you do the following things in the last week:"
Be specific about scientific tasks, files, plans, tools, and unresolved work when the data supports it.
Do not invent experiments, results, metrics, molecules, structures, or files that are not in the data.
No markdown formatting.

Usage:
- API calls: ${context.usage.apiCalls}
- Input tokens: ${context.usage.inputTokens}
- Output tokens: ${context.usage.outputTokens}
- Total tokens: ${context.usage.totalTokens}

Recent sessions:
${sessionLines || "No recent sessions."}`;
}

function listSentence(items: string[], fallback: string): string {
  if (items.length === 0) return fallback;
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function buildFallbackRecentActivityReport(context: RecentActivityContext): string {
  if (context.sessions.length === 0 && context.usage.apiCalls === 0) {
    return RECENT_ACTIVITY_WELCOME;
  }

  const meaningfulTitles = context.sessions
    .map((session) => session.title)
    .filter((title) => title && title !== DEFAULT_SESSION_TITLE)
    .slice(0, 4);
  const userRequests = context.sessions
    .flatMap((session) => session.recentUserRequests)
    .slice(-3);
  const artifacts = context.sessions
    .flatMap((session) => session.artifactItems)
    .slice(0, 4);
  const planItems = context.sessions
    .flatMap((session) => session.planItems)
    .slice(0, 4);
  const tools = context.sessions
    .flatMap((session) => session.toolItems)
    .slice(0, 5);

  const details: string[] = [];

  if (meaningfulTitles.length > 0) {
    details.push(`Recent session focus: ${listSentence(meaningfulTitles, "general research workflows")}.`);
  } else if (userRequests.length > 0) {
    details.push(`Recent focus: ${listSentence(userRequests.map((item) => truncate(item, 110)), "general research workflows")}.`);
  } else {
    details.push(`Recent focus: ${context.sessions.length} research session${context.sessions.length === 1 ? "" : "s"}.`);
  }

  if (planItems.length > 0) {
    details.push(`Plan state included ${listSentence(planItems, "tracked workflow steps")}.`);
  }

  if (artifacts.length > 0) {
    details.push(`Files and artifacts surfaced: ${listSentence(artifacts, "workspace outputs")}.`);
  }

  if (tools.length > 0) {
    details.push(`Tools used included ${listSentence([...new Set(tools)], "agent tools")}.`);
  }

  return [
    "ChatMol Lab helped you do the following things in the last week:",
    ...details.slice(0, 3),
    `${context.usage.apiCalls} API calls used ${context.usage.totalTokens.toLocaleString()} tokens.`,
  ].join("\n");
}
