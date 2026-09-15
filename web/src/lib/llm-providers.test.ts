import { describe, expect, it } from "vitest";

import {
  detectEnvProvider,
  getEnvApiKey,
  normalizeLlmProvider,
  normalizeModelForProvider,
  resolveChatUrl,
  resolveCustomChatUrl,
} from "./llm-providers";

describe("llm providers", () => {
  it("normalizes unknown providers to deepseek", () => {
    expect(normalizeLlmProvider("anthropic")).toBe("anthropic");
    expect(normalizeLlmProvider(" OpenAI ")).toBe("openai");
    expect(normalizeLlmProvider("nope")).toBe("deepseek");
    expect(normalizeLlmProvider(undefined)).toBe("deepseek");
  });

  it("detects the provider from the environment", () => {
    expect(detectEnvProvider({})).toBe("deepseek");
    expect(detectEnvProvider({ ANTHROPIC_API_KEY: "k" })).toBe("anthropic");
    expect(detectEnvProvider({ DEEPSEEK_API_KEY: "a", OPENAI_API_KEY: "b" })).toBe("deepseek");
    expect(detectEnvProvider({ LLM_PROVIDER: "openai", DEEPSEEK_API_KEY: "a" })).toBe("openai");
    expect(detectEnvProvider({ LLM_BASE_URL: "http://localhost:11434", LLM_API_KEY: "x" })).toBe("custom");
    expect(getEnvApiKey("google", { GEMINI_API_KEY: "g" })).toBe("g");
  });

  it("builds custom chat endpoints from base URLs", () => {
    expect(resolveCustomChatUrl("http://localhost:11434")).toBe("http://localhost:11434/v1/chat/completions");
    expect(resolveCustomChatUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1/chat/completions");
    expect(resolveCustomChatUrl("https://x.example/v1/chat/completions")).toBe("https://x.example/v1/chat/completions");
    expect(resolveCustomChatUrl("")).toBe("");
    expect(resolveChatUrl("anthropic")).toBe("https://api.anthropic.com/v1/messages");
    expect(resolveChatUrl("custom", "http://h:1/v1")).toBe("http://h:1/v1/chat/completions");
  });

  it("strips vendor prefixes for direct providers only", () => {
    expect(normalizeModelForProvider("deepseek", "deepseek/deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeModelForProvider("deepseek", "")).toBe("deepseek-v4-pro");
    expect(normalizeModelForProvider("openrouter", "anthropic/claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(normalizeModelForProvider("custom", "qwen3:32b")).toBe("qwen3:32b");
  });
});
