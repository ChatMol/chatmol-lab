import { NextRequest, NextResponse } from "next/server";
import { existsSync, mkdirSync, statSync } from "fs";
import * as path from "path";

import { auth } from "@/lib/auth";
import { isElectronServer } from "@/lib/electron";
import { verifySessionOwnership } from "@/lib/session-db";
import {
  getSessionWorkspaceInfo,
  getWorkspaceRoot,
  setSessionWorkspaceOverride,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** GET /api/workspace?sessionId= — where this session's files live. */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  const authSession = await auth();
  const userId = authSession?.user?.id || null;
  if (sessionId && !(await verifySessionOwnership(sessionId, userId))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return NextResponse.json({
    ...getSessionWorkspaceInfo(sessionId),
    canChoose: isElectronServer(),
  });
}

/**
 * PUT /api/workspace { sessionId, path | null }
 * Point a session at a folder the user picked. Only the local desktop build
 * may choose arbitrary folders; the hosted server keeps sessions under the
 * managed workspace root.
 */
export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });

  const authSession = await auth();
  const userId = authSession?.user?.id || null;
  if (!(await verifySessionOwnership(sessionId, userId))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const requested = typeof body.path === "string" ? body.path.trim() : null;
  if (requested) {
    if (!isElectronServer()) {
      return NextResponse.json(
        { error: "Choosing a custom workspace folder is only available in the desktop app." },
        { status: 403 },
      );
    }
    const resolved = path.resolve(requested.replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || ""));
    const root = path.resolve(getWorkspaceRoot());
    if (resolved === root) {
      return NextResponse.json({ error: "The workspace root itself cannot be used; pick a sub-folder or another folder." }, { status: 400 });
    }
    if (body.create === true && !existsSync(resolved)) {
      try {
        mkdirSync(resolved, { recursive: true });
      } catch (err) {
        return NextResponse.json({ error: `Could not create folder: ${err instanceof Error ? err.message : String(err)}` }, { status: 400 });
      }
    }
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      return NextResponse.json({ error: "Folder does not exist." }, { status: 400 });
    }
    setSessionWorkspaceOverride(sessionId, resolved);
  } else {
    setSessionWorkspaceOverride(sessionId, null);
  }

  return NextResponse.json({ ...getSessionWorkspaceInfo(sessionId), canChoose: isElectronServer() });
}
