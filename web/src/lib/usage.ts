import { prisma } from "./db";

export interface UsageRecord {
  userId?: string | null;
  sessionId?: string | null;
  provider: string;
  model?: string | null;
  tool?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

export async function logUsage(record: UsageRecord): Promise<void> {
  try {
    await prisma.apiUsage.create({
      data: {
        userId: record.userId || null,
        sessionId: record.sessionId || null,
        provider: record.provider,
        model: record.model || null,
        tool: record.tool || null,
        inputTokens: record.inputTokens || 0,
        outputTokens: record.outputTokens || 0,
        durationMs: record.durationMs || 0,
      },
    });
  } catch (err) {
    console.error("[usage] Failed to log API usage:", err);
  }
}

/** Extract token usage from an LLM API response (Anthropic or OpenAI format). */
export function extractUsage(result: any, isAnthropic: boolean): { inputTokens: number; outputTokens: number } {
  if (!result?.usage) return { inputTokens: 0, outputTokens: 0 };

  if (isAnthropic) {
    return {
      inputTokens: result.usage.input_tokens || 0,
      outputTokens: result.usage.output_tokens || 0,
    };
  }

  return {
    inputTokens: result.usage.prompt_tokens || 0,
    outputTokens: result.usage.completion_tokens || 0,
  };
}
