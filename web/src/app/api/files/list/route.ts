import { NextRequest, NextResponse } from "next/server";
import { existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { auth } from "@/lib/auth";
import { verifySessionOwnership } from "@/lib/session-db";
import { getSessionWorkspace } from "@/lib/workspace";

function walkDir(dir: string, base: string = dir): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(dir, entry);
      const relPath = relative(base, fullPath);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          if (entry !== "node_modules" && entry !== "__pycache__") {
            files.push(...walkDir(fullPath, base));
          }
        } else {
          // Normalize to forward slashes so paths work cross-platform in URLs
          files.push(relPath.replace(/\\/g, "/"));
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip inaccessible directories
  }

  return files;
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json({ error: "Session ID required" }, { status: 400 });
  }

  const session = await auth();
  const userId = session?.user?.id || null;
  if (!(await verifySessionOwnership(sessionId, userId, { allowMissing: false }))) {
    return NextResponse.json([], { status: 403 });
  }

  const workspace = getSessionWorkspace(sessionId);
  const files = walkDir(workspace);
  return NextResponse.json(files);
}
