import { NextRequest, NextResponse } from "next/server";
import { completeText } from "@/lib/llm-client";
import { buildTitleUserPrompt, fallbackTitle, sanitizeGeneratedTitle, TITLE_SYSTEM_PROMPT } from "@/lib/session-title";
import { getFastApiConfig, loadSettings } from "@/lib/settings";
import { captureLlmDiagnostic } from "@/lib/llm-diagnostics";

export async function POST(request: NextRequest) {
  const { message } = await request.json();
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // Use the fast/cheap model for title generation, not the main chat model.
  const config = getFastApiConfig(loadSettings());
  if (!config.key || !config.url) {
    return NextResponse.json({ title: fallbackTitle(message) });
  }

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text, model } = await completeText({
        apiConfig: config,
        system: TITLE_SYSTEM_PROMPT,
        user: buildTitleUserPrompt(message),
        maxTokens: attempt === 0 ? 128 : 256,
        temperature: 0,
        timeoutMs: 15_000,
      });
      const title = sanitizeGeneratedTitle(text, message);
      captureLlmDiagnostic("title", { model, attempt: attempt + 1, message, text, accepted: !!title }, [config.key]);
      if (title) return NextResponse.json({ title });
      console.warn(`[title] rejected model output: attempt=${attempt + 1} chars=${text.length}`);
    }
    return NextResponse.json({ title: fallbackTitle(message) });
  } catch (err) {
    console.error("Title generation failed:", err);
    return NextResponse.json({ title: fallbackTitle(message) });
  }
}
