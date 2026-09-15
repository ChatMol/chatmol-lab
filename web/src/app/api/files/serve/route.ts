import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { basename } from "path";
import { auth } from "@/lib/auth";
import { verifySessionOwnership } from "@/lib/session-db";
import { getSessionWorkspace, safeResolvePath } from "@/lib/workspace";

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  py: "text/x-python",
  r: "text/x-r",
  pdb: "chemical/x-pdb",
  cif: "chemical/x-cif",
  mmcif: "chemical/x-cif",
  fasta: "text/x-fasta",
  fa: "text/x-fasta",
  sdf: "chemical/x-mdl-sdfile",
  a3m: "text/plain",
  faa: "text/x-fasta",
  html: "text/html",
  ipynb: "application/json",
  log: "text/plain",
};

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
    const buffer = readFileSync(resolvedPath);
    const ext = basename(resolvedPath).split(".").pop()?.toLowerCase() || "";
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": buffer.length.toString(),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Failed to serve file: ${err.message}` },
      { status: 500 }
    );
  }
}
