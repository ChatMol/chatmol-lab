import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { isElectronServer } from "@/lib/electron";
import { deleteMemory, isMemoryScope, listMemories, saveMemory, type MemoryOptions } from "@/lib/memory";
import { loadSettings } from "@/lib/settings";
import { verifySessionOwnership } from "@/lib/session-db";
import { getSessionWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

async function resolveOptions(request: NextRequest, sessionIdInput?: string | null): Promise<{ options: MemoryOptions } | { error: NextResponse }> {
  const session = await auth();
  const userId = session?.user?.id || null;
  if (!isElectronServer() && !userId) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const sessionId = (sessionIdInput ?? request.nextUrl.searchParams.get("sessionId") ?? "").trim();
  const options: MemoryOptions = { userId };
  if (sessionId) {
    if (!(await verifySessionOwnership(sessionId, userId))) return { error: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
    options.cwd = getSessionWorkspace(sessionId);
  }
  return { options };
}

function snapshot(options: MemoryOptions) {
  return {
    enabled: loadSettings().memoryEnabled,
    entries: listMemories(options).map((entry) => ({
      name: entry.name,
      description: entry.description,
      type: entry.type,
      scope: entry.scope,
      path: entry.path,
      content: entry.content,
      updatedAt: entry.updatedAt ?? null,
    })),
  };
}

export async function GET(request: NextRequest) {
  const resolved = await resolveOptions(request);
  if ("error" in resolved) return resolved.error;
  return NextResponse.json(snapshot(resolved.options), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const resolved = await resolveOptions(request, typeof body.sessionId === "string" ? body.sessionId : null);
  if ("error" in resolved) return resolved.error;
  try {
    saveMemory({
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" ? body.description : "",
      type: body.type,
      scope: isMemoryScope(body.scope) ? body.scope : "global",
      content: typeof body.content === "string" ? body.content : "",
    }, resolved.options);
    return NextResponse.json(snapshot(resolved.options));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const resolved = await resolveOptions(request);
  if ("error" in resolved) return resolved.error;
  const name = request.nextUrl.searchParams.get("name")?.trim() || "";
  const scope = request.nextUrl.searchParams.get("scope");
  if (!name || !isMemoryScope(scope)) return NextResponse.json({ error: "name and scope are required" }, { status: 400 });
  deleteMemory(name, scope, resolved.options);
  return NextResponse.json(snapshot(resolved.options));
}
