import { NextRequest, NextResponse } from "next/server";

import { listFixedSubagents } from "@/lib/subagents";
import { getSessionWorkspace } from "@/lib/workspace";

/**
 * Discovered subagents (agents/<id>.md files). Pass `?sessionId=` to include
 * agents defined inside that session's workspace.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId")?.trim();
  const cwd = sessionId ? getSessionWorkspace(sessionId) : undefined;
  return NextResponse.json(
    listFixedSubagents(cwd ? { cwd } : {}).map(({ id, name, description, source, toolNames, model, skills }) => ({
      id,
      name,
      description,
      source,
      tools: toolNames,
      model,
      skills,
    })),
  );
}
