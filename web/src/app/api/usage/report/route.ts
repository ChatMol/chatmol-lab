import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isElectronServer } from "@/lib/electron";
import { completeText } from "@/lib/llm-client";
import { getFastApiConfig, loadSettings } from "@/lib/settings";
import {
  buildFallbackRecentActivityReport,
  buildRecentActivityContext,
  buildRecentActivityPrompt,
  RECENT_ACTIVITY_WELCOME,
} from "@/lib/recent-activity";

export const dynamic = "force-dynamic";
export const revalidate = 0;


function jsonNoStore(data: Record<string, unknown>, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      ...init?.headers,
    },
  });
}

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id || null;
  if (!userId && !isElectronServer()) {
    return jsonNoStore({ error: "Unauthorized" }, { status: 401 });
  }
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [recentSessions, usageSummary] = await Promise.all([
    prisma.chatSession.findMany({
      where: { userId, updatedAt: { gte: since } },
      select: {
        id: true,
        title: true,
        messages: true,
        plan: true,
        artifacts: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 12,
    }),
    prisma.apiUsage.aggregate({
      where: { userId, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true },
    }),
  ]);

  const context = buildRecentActivityContext(recentSessions, {
    apiCalls: usageSummary._count._all,
    inputTokens: usageSummary._sum.inputTokens || 0,
    outputTokens: usageSummary._sum.outputTokens || 0,
  });

  const fallbackReport = buildFallbackRecentActivityReport(context);
  if (fallbackReport === RECENT_ACTIVITY_WELCOME) {
    return jsonNoStore({
      report: fallbackReport,
      generatedAt: context.generatedAt,
      source: "fallback",
    });
  }

  const config = getFastApiConfig(loadSettings());
  if (!config.key || !config.url) {
    return jsonNoStore({
      report: fallbackReport,
      generatedAt: context.generatedAt,
      source: "fallback",
    });
  }

  try {
    const { text, model } = await completeText({
      apiConfig: config,
      user: buildRecentActivityPrompt(context),
      maxTokens: 200,
      temperature: 0.2,
      timeoutMs: 30_000,
    });
    const report = text || fallbackReport;

    return jsonNoStore({
      report,
      generatedAt: context.generatedAt,
      source: "llm",
      model,
    });
  } catch (err) {
    console.error("Report generation failed:", err);
    return jsonNoStore({
      report: fallbackReport,
      generatedAt: context.generatedAt,
      source: "fallback",
    });
  }
}
