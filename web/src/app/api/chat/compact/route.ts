import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  appendCompactionRecord,
  buildContextProjection,
  createModelSummarizer,
  getContextCompactionConfig,
} from "@/lib/context-compaction";
import { getModelContextWindow } from "@/lib/llm-providers";
import { getChatSession, updateChatSession, verifySessionOwnership } from "@/lib/session-db";
import { getEffectiveApiConfig, getFastApiConfig, loadSettings } from "@/lib/settings";
import { getWorkspaceFiles, type TurnMessage } from "@/lib/tools";
import { getSessionWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * POST /api/chat/compact { sessionId }
 * On-demand condensation (like dsh's /compact): summarizes the older part of
 * the session now, persists the record, and reports the savings. The next chat
 * request reuses the record automatically.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });

  const authSession = await auth();
  const userId = authSession?.user?.id || null;
  if (!(await verifySessionOwnership(sessionId, userId))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const chatSession = await getChatSession(sessionId).catch(() => null);
  const messages = (Array.isArray(chatSession?.messages) ? chatSession!.messages : []) as TurnMessage[];
  if (messages.length < 2) {
    return NextResponse.json({ ok: true, compacted: false, reason: "Nothing to compact yet." });
  }

  const settings = loadSettings();
  const apiConfig = getEffectiveApiConfig(settings);
  const workspace = getSessionWorkspace(sessionId);
  const projection = await buildContextProjection({
    messages,
    systemPrompt: "",
    tools: [],
    plan: Array.isArray(chatSession?.plan) ? chatSession!.plan : [],
    artifacts: Array.isArray(chatSession?.artifacts) ? chatSession!.artifacts : [],
    workspaceFiles: getWorkspaceFiles(workspace, workspace),
    compactions: Array.isArray(chatSession?.compactions) ? chatSession!.compactions : [],
    config: { contextWindow: getModelContextWindow(apiConfig.provider, apiConfig.model), keepTurns: 2 },
    force: true,
    summarize: createModelSummarizer(getFastApiConfig(settings)),
  });

  if (!projection.record) {
    return NextResponse.json({
      ok: true,
      compacted: projection.compacted,
      reason: projection.compacted ? "Already compacted; the recent turns are kept verbatim." : "Not enough history to compact.",
      approxTokens: projection.compactedSize.approxTokens,
    });
  }

  const records = appendCompactionRecord(chatSession?.compactions, projection.record);
  await updateChatSession(sessionId, { compactions: records }, { userId });

  return NextResponse.json({
    ok: true,
    compacted: true,
    summarizedMessages: projection.record.summarizedMessages,
    originalApproxTokens: projection.originalSize.approxTokens,
    compactedApproxTokens: projection.compactedSize.approxTokens,
    summaryMode: projection.record.summaryMode,
    summaryPreview: projection.record.summary.slice(0, 1200),
  });
}
