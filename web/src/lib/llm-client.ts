/**
 * Small provider-neutral, non-streaming completion helper.
 *
 * The agent loop in tools.ts owns streaming + tool calls. Helper routes
 * (session titles, activity report, tool reviewer) only need one short text
 * completion, so they share this adapter instead of each hard-coding one
 * provider's wire format.
 *
 * Helper completions want an answer, not a thought process: thinking is
 * switched off where the provider accepts the field, and reasoning output
 * (reasoning_content / reasoning / <think> blocks / thinking blocks) is never
 * returned as text. An empty result lets the caller use its own fallback.
 */
import { providerSupportsThinkingFields } from "./llm-providers";
import type { ApiConfig } from "./settings";

export interface CompleteTextOptions {
  apiConfig: ApiConfig;
  /** Overrides apiConfig.model (e.g. the configured fast model). */
  model?: string;
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface CompleteTextResult {
  text: string;
  model: string;
}

function buildOpenAiBody(opts: CompleteTextOptions, model: string): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.user });
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 512,
    stream: false,
    messages,
  };
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  if (providerSupportsThinkingFields(opts.apiConfig.provider)) body.thinking = { type: "disabled" };
  return body;
}

function buildAnthropicBody(opts: CompleteTextOptions, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 512,
    messages: [{ role: "user", content: opts.user }],
  };
  if (opts.system) body.system = opts.system;
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  return body;
}

/** Drop inline `<think>` blocks; an unclosed one means the budget ran out mid-thought. */
function stripThinkTags(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const open = closed.search(/<think>/i);
  return open === -1 ? closed : closed.slice(0, open);
}

export function extractOpenAiText(data: unknown): string {
  const record = data as { choices?: Array<{ message?: { content?: unknown } }> } | null;
  const content = record?.choices?.[0]?.message?.content;
  // Only `content` is the answer. When a reasoning model exhausts its budget
  // mid-thought, content is empty and its reasoning (e.g. "We need answer only
  // title max 6 words...") must not be passed off as the result.
  return typeof content === "string" ? stripThinkTags(content).trim() : "";
}

export function extractAnthropicText(data: unknown): string {
  const record = data as { content?: Array<{ type?: string; text?: string }> } | null;
  if (!Array.isArray(record?.content)) return "";
  return record!.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/** One text completion through whichever provider is configured. */
export async function completeText(opts: CompleteTextOptions): Promise<CompleteTextResult> {
  const { apiConfig } = opts;
  if (!apiConfig.key) throw new Error("LLM API key is not configured.");
  if (!apiConfig.url) throw new Error("LLM endpoint is not configured.");
  const model = opts.model || apiConfig.model;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);

  if (apiConfig.isAnthropic) {
    const response = await fetch(apiConfig.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiConfig.key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(buildAnthropicBody(opts, model)),
      signal,
    });
    if (!response.ok) throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return { text: extractAnthropicText(await response.json()).trim(), model };
  }

  const response = await fetch(apiConfig.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiConfig.key}`,
      ...(apiConfig.url.includes("openrouter")
        ? { "HTTP-Referer": "https://chatmol.org", "X-Title": "ChatMol Lab" }
        : {}),
    },
    body: JSON.stringify(buildOpenAiBody(opts, model)),
    signal,
  });
  if (!response.ok) throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return { text: extractOpenAiText(await response.json()).trim(), model };
}
