import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { basename } from "path";
import { auth } from "@/lib/auth";
import { verifySessionOwnership } from "@/lib/session-db";
import { getSessionWorkspace, safeResolvePath } from "@/lib/workspace";

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get("path");
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!filePath) {
    return NextResponse.json({ error: "Path required" }, { status: 400 });
  }

  if (!sessionId) {
    return NextResponse.json({ error: "Session ID required" }, { status: 400 });
  }

  const session = await auth();
  const userId = session?.user?.id || null;
  if (!(await verifySessionOwnership(sessionId, userId, { allowMissing: false }))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const workspace = getSessionWorkspace(sessionId);
  const resolvedPath = safeResolvePath(filePath, workspace);
  if (!resolvedPath) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  if (!existsSync(resolvedPath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const content = readFileSync(resolvedPath);
    return new NextResponse(content, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${basename(resolvedPath)}"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Download failed: ${err.message}` },
      { status: 500 }
    );
  }
}
