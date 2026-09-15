import { afterEach, describe, expect, it, vi } from "vitest";
import { completeText, extractAnthropicText, extractOpenAiText } from "./llm-client";
import {
  LLM_PROVIDER_IDS,
  isAnthropicWire,
  providerSupportsThinkingFields,
  resolveChatUrl,
  type LlmProviderId,
} from "./llm-providers";
import type { ApiConfig } from "./settings";

const LEAKED_REASONING = "We need answer only title max 6 words. Need understand messa";

function configFor(provider: LlmProviderId): ApiConfig {
  return {
    provider,
    url: resolveChatUrl(provider, "http://localhost:11434"),
    key: "test-key",
    model: "fast-model",
    isAnthropic: isAnthropicWire(provider),
    maxOutputTokens: 8192,
  };
}

function stubFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractOpenAiText", () => {
  it("never returns reasoning_content or reasoning as the answer", () => {
    expect(extractOpenAiText({ choices: [{ message: { content: "", reasoning_content: LEAKED_REASONING } }] })).toBe("");
    expect(extractOpenAiText({ choices: [{ message: { content: null, reasoning: LEAKED_REASONING } }] })).toBe("");
    expect(extractOpenAiText({ choices: [{ message: { content: "Ubiquitin Structure", reasoning_content: LEAKED_REASONING } }] }))
      .toBe("Ubiquitin Structure");
  });

  it("strips inline <think> blocks emitted by OpenAI-compatible reasoning servers", () => {
    expect(extractOpenAiText({ choices: [{ message: { content: "<think>\nThe user wants a title.\n</think>\n\nUbiquitin Structure" } }] }))
      .toBe("Ubiquitin Structure");
    // Budget ran out mid-thought: nothing after the open tag is an answer.
    expect(extractOpenAiText({ choices: [{ message: { content: `<think>${LEAKED_REASONING}` } }] })).toBe("");
  });
});

describe("extractAnthropicText", () => {
  it("ignores thinking blocks", () => {
    expect(extractAnthropicText({
      content: [
        { type: "thinking", thinking: LEAKED_REASONING },
        { type: "text", text: "Ubiquitin Structure" },
      ],
    })).toBe("Ubiquitin Structure");
  });
});

describe("completeText across providers", () => {
  it.each(LLM_PROVIDER_IDS)("%s: disables thinking only where the provider accepts the field", async (provider) => {
    const config = configFor(provider);
    const fetchMock = stubFetch(config.isAnthropic
      ? { content: [{ type: "text", text: "Title" }] }
      : { choices: [{ message: { content: "Title" } }] });

    await completeText({ apiConfig: config, user: "hi", maxTokens: 30 });

    const body = sentBody(fetchMock);
    if (providerSupportsThinkingFields(provider)) {
      expect(body.thinking).toEqual({ type: "disabled" });
    } else {
      expect(body).not.toHaveProperty("thinking");
    }
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it.each(LLM_PROVIDER_IDS.filter((provider) => !isAnthropicWire(provider)))(
    "%s: an empty answer with only reasoning text yields empty text",
    async (provider) => {
      stubFetch({ choices: [{ message: { content: "", reasoning_content: LEAKED_REASONING, reasoning: LEAKED_REASONING } }] });
      const { text } = await completeText({ apiConfig: configFor(provider), user: "hi", maxTokens: 30 });
      expect(text).toBe("");
    },
  );

  it("disables thinking even when the main config enables it", async () => {
    const fetchMock = stubFetch({ choices: [{ message: { content: "Title" } }] });
    await completeText({
      apiConfig: { ...configFor("deepseek"), thinking: { type: "enabled" }, reasoningEffort: "high" },
      user: "hi",
    });
    const body = sentBody(fetchMock);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});
