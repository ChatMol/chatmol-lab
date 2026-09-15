import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isElectronServer } from "@/lib/electron";

// LLM provider tags recorded by logUsage (DeepSeek records as "openai").
const LLM_PROVIDERS = ["openai", "anthropic", "openrouter"];

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

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const llmWhere = (gte: Date) => ({ userId, provider: { in: LLM_PROVIDERS }, createdAt: { gte } });
  const toolWhere = (gte: Date) => ({ userId, provider: "tool", createdAt: { gte } });

  const [
    todayLlm, todayTools,
    weekLlm, weekTools, weekSessions,
    topTools,
  ] = await Promise.all([
    prisma.apiUsage.aggregate({ where: llmWhere(startOfDay), _count: true, _sum: { inputTokens: true, outputTokens: true } }),
    prisma.apiUsage.count({ where: toolWhere(startOfDay) }),
    prisma.apiUsage.aggregate({ where: llmWhere(weekAgo), _count: true, _sum: { inputTokens: true, outputTokens: true }, _avg: { durationMs: true } }),
    prisma.apiUsage.count({ where: toolWhere(weekAgo) }),
    prisma.chatSession.count({ where: { userId, updatedAt: { gte: weekAgo } } }),
    prisma.apiUsage.groupBy({
      by: ["tool"],
      where: { ...toolWhere(weekAgo), tool: { not: null } },
      _count: true,
      _avg: { durationMs: true },
      orderBy: { _count: { tool: "desc" } },
      take: 8,
    }),
  ]);

  const tok = (a: { _sum: { inputTokens: number | null; outputTokens: number | null } }) =>
    (a._sum.inputTokens || 0) + (a._sum.outputTokens || 0);

  return jsonNoStore({
    today: {
      llmCalls: todayLlm._count,
      toolCalls: todayTools,
      tokens: tok(todayLlm),
      inputTokens: todayLlm._sum.inputTokens || 0,
      outputTokens: todayLlm._sum.outputTokens || 0,
    },
    week: {
      llmCalls: weekLlm._count,
      toolCalls: weekTools,
      tokens: tok(weekLlm),
      sessions: weekSessions,
      avgLatencyMs: Math.round(weekLlm._avg.durationMs || 0),
    },
    topTools: topTools.map((t) => ({
      tool: t.tool as string,
      calls: t._count,
      avgMs: Math.round(t._avg.durationMs || 0),
    })),
  });
}
