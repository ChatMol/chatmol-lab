import { NextRequest, NextResponse } from "next/server";
import { getRuntimeStatus } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (process.env.IS_ELECTRON !== "true") {
    return NextResponse.json({ ok: false, desktop: false }, { status: 404 });
  }

  const expected = process.env.CHATMOL_DAEMON_TOKEN;
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";

  if (!expected || token !== expected) {
    return NextResponse.json({ ok: false, desktop: true }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    desktop: true,
    pid: process.pid,
    version: process.env.npm_package_version || null,
    workspaceDir: process.env.WORKSPACE_DIR || null,
    runtime: getRuntimeStatus(),
  });
}
