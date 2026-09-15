import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { auth } from "@/lib/auth";
import { verifySessionOwnership } from "@/lib/session-db";
import { getSessionWorkspace, safeResolvePath } from "@/lib/workspace";

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get("path");
  const sessionId = request.nextUrl.searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json({ error: "Session ID required" }, { status: 400 });
  }

  const session = await auth();
  const userId = session?.user?.id || null;
  if (!(await verifySessionOwnership(sessionId, userId, { allowMissing: false }))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  if (!filePath) {
    return NextResponse.json({ error: "Path required" }, { status: 400 });
  }

  const workspace = getSessionWorkspace(sessionId);
  const resolvedPath = safeResolvePath(filePath, workspace);
  if (!resolvedPath) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    if (!existsSync(resolvedPath)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    const content = readFileSync(resolvedPath, "utf-8");

    let contentType = "text/plain";
    if (resolvedPath.endsWith(".json")) contentType = "application/json";
    else if (resolvedPath.endsWith(".csv")) contentType = "text/csv";
    else if (resolvedPath.endsWith(".pdb") || resolvedPath.endsWith(".cif"))
      contentType = "chemical/x-pdb";

    return new NextResponse(content, {
      headers: { "Content-Type": contentType },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Failed to read file: ${err.message}` },
      { status: 500 }
    );
  }
}
