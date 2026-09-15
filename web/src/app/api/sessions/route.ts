import { NextRequest, NextResponse } from "next/server";
import { rmSync } from "fs";
import { auth } from "@/lib/auth";
import {
  getChatSessions,
  getChatSession,
  createChatSession,
  deleteChatSession,
  updateChatSession,
  verifySessionOwnership,
} from "@/lib/session-db";
import { getSessionWorkspace, getSessionWorkspaceOverride, setSessionWorkspaceOverride } from "@/lib/workspace";
import { pullCloudSessions, pushSessionToCloud, deleteCloudSession } from "@/lib/cloud-sync";

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id || null;

    // If ?id= is provided, return full session data
    const singleId = request.nextUrl.searchParams.get("id");
    if (singleId) {
      const s = await getChatSession(singleId);
      if (!s) return NextResponse.json(null, { status: 404 });
      if (!(await verifySessionOwnership(singleId, userId, { allowMissing: false }))) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      return NextResponse.json({
        id: s.id,
        title: s.title,
        messages: s.messages,
        plan: s.plan,
        artifacts: s.artifacts,
        compactions: s.compactions,
        updatedAt: s.updatedAt,
      });
    }

    // Don't block the session list on the cloud pull — it can be slow or fail
    // (and is a no-op on the free local workbench). Let it run in the background.
    void pullCloudSessions(userId);
    const sessions = await getChatSessions(userId);

    return NextResponse.json(
      sessions.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
      }))
    );
  } catch (error) {
    console.error("Failed to fetch sessions:", error);
    return NextResponse.json([]);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { id } = await request.json();
    if (!id) {
      return NextResponse.json(
        { error: "Session ID required" },
        { status: 400 }
      );
    }

    const session = await auth();
    const userId = session?.user?.id || null;
    const chatSession = await createChatSession(id, userId);
    await pushSessionToCloud(id);

    return NextResponse.json(chatSession);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to create session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("id");
  if (!sessionId) {
    return NextResponse.json(
      { error: "Session ID required" },
      { status: 400 }
    );
  }

  try {
    const session = await auth();
    const userId = session?.user?.id || null;
    if (!(await verifySessionOwnership(sessionId, userId, { allowMissing: false }))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    await deleteChatSession(sessionId);
    await deleteCloudSession(sessionId);
    // Clean up the managed session workspace directory. A user-chosen
    // project folder is never deleted — only the mapping is removed.
    try {
      if (getSessionWorkspaceOverride(sessionId)) {
        setSessionWorkspaceOverride(sessionId, null);
      } else {
        const sessionDir = getSessionWorkspace(sessionId, { create: false });
        rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch {}
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to delete session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { id, messages, plan, artifacts, compactions } = await request.json();
    if (!id) {
      return NextResponse.json(
        { error: "Session ID required" },
        { status: 400 }
      );
    }

    const session = await auth();
    const userId = session?.user?.id || null;
    if (!(await verifySessionOwnership(id, userId))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const updates: Record<string, unknown> = {};
    if (messages !== undefined) updates.messages = messages;
    if (plan !== undefined) updates.plan = plan;
    if (artifacts !== undefined) updates.artifacts = artifacts;
    if (compactions !== undefined) updates.compactions = compactions;

    await updateChatSession(id, updates, { userId });
    await pushSessionToCloud(id);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to save session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { id, title } = await request.json();
    if (!id || !title) {
      return NextResponse.json(
        { error: "Session ID and title required" },
        { status: 400 }
      );
    }

    const session = await auth();
    const userId = session?.user?.id || null;
    if (!(await verifySessionOwnership(id, userId))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    await updateChatSession(id, { title }, { userId });
    await pushSessionToCloud(id);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to rename session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
