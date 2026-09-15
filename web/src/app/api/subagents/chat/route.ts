import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { verifySessionOwnership } from "@/lib/session-db";
import { getEffectiveApiConfig, getFastApiConfig, loadSettings } from "@/lib/settings";
import { getSessionWorkspace } from "@/lib/workspace";
import { executeFixedSubagentTool, type SSESender } from "@/lib/tools";
import { getFixedSubagent, normalizeFixedSubagentIds, type FixedSubagentId } from "@/lib/subagents";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const runId = typeof body.runId === "string" ? body.runId : undefined;
    const priorContext = typeof body.context === "string" ? body.context.slice(0, 24000) : "";

    if (!sessionId || !agentId || !message) {
      return NextResponse.json({ error: "sessionId, agentId, and message are required." }, { status: 400 });
    }

    const authSession = await auth();
    const userId = authSession?.user?.id || null;
    if (!(await verifySessionOwnership(sessionId, userId))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const settings = loadSettings();
    const apiConfig = getEffectiveApiConfig(settings);
    if (!apiConfig.key) {
      return NextResponse.json({ error: "No DeepSeek API key configured." }, { status: 500 });
    }

    const sessionWorkspace = getSessionWorkspace(sessionId);
    const [normalizedAgentId] = normalizeFixedSubagentIds([agentId], { cwd: sessionWorkspace });
    const agent = normalizedAgentId ? getFixedSubagent(normalizedAgentId, { cwd: sessionWorkspace }) : null;
    if (!agent) {
      return NextResponse.json({ error: "Unknown subagent." }, { status: 400 });
    }
    const events: Record<string, unknown>[] = [];
    const send: SSESender = (event) => {
      if (event.type === "run_event") events.push(event);
    };

    const result = await executeFixedSubagentTool(
      {
        agent_id: normalizedAgentId,
        task: message,
        context: priorContext,
      },
      sessionWorkspace,
      sessionId,
      [],
      request.signal,
      userId,
      {
        apiConfig,
        reviewerApiConfig: getFastApiConfig(settings),
        enabledSubagentIds: [normalizedAgentId as FixedSubagentId],
        send,
        toolReviewMode: "auto",
        ...(runId ? { subagentRunId: runId } : {}),
      },
    );

    return NextResponse.json({
      ok: result.success,
      output: result.output,
      events,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Subagent chat failed." }, { status: 500 });
  }
}
