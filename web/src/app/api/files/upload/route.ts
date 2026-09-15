import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { basename } from "path";
import { auth } from "@/lib/auth";
import { verifySessionOwnership } from "@/lib/session-db";
import { getSessionWorkspace, safeResolvePath } from "@/lib/workspace";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "svg", "webp"];
const TEXT_EXTS = [
  "pdb", "cif", "mmcif", "fasta", "fa", "faa", "fna",
  "csv", "tsv", "json", "py", "r", "md", "txt", "log", "html",
];

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const sessionId = formData.get("sessionId") as string | null;

    if (!sessionId) {
      return NextResponse.json({ error: "Session ID required" }, { status: 400 });
    }

    const session = await auth();
    const userId = session?.user?.id || null;
    if (!(await verifySessionOwnership(sessionId, userId, { allowMissing: false }))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const workspace = getSessionWorkspace(sessionId);
    if (!existsSync(workspace)) {
      mkdirSync(workspace, { recursive: true });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    // Sanitize filename: strip directory components and disallow special characters
    const safeName = basename(file.name).replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!safeName) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }
    const filePath = safeResolvePath(safeName, workspace);
    if (!filePath) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    writeFileSync(filePath, buffer);

    const ext = safeName.split(".").pop()?.toLowerCase() || "";
    const typeMap: Record<string, string> = {
      pdb: "pdb",
      cif: "cif",
      mmcif: "mmcif",
      fasta: "fasta",
      fa: "fasta",
      faa: "fasta",
      fna: "fasta",
      csv: "csv",
      tsv: "tsv",
      json: "json",
      py: "python",
      r: "r",
      ipynb: "notebook",
      png: "image",
      jpg: "image",
      jpeg: "image",
      gif: "image",
      svg: "image",
      webp: "image",
      md: "markdown",
      txt: "text",
      log: "text",
      html: "html",
      pdf: "pdf",
    };

    const isImage = IMAGE_EXTS.includes(ext);
    const isText = TEXT_EXTS.includes(ext);

    return NextResponse.json({
      id: `upload-${Date.now()}`,
      name: safeName,
      path: safeName,
      type: typeMap[ext] || "unknown",
      size: file.size,
      ...(isImage
        ? { previewUrl: `/api/files/serve?path=${encodeURIComponent(safeName)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}` }
        : {}),
      ...(isText
        ? { content: buffer.toString("utf-8") }
        : {}),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Upload failed: ${err.message}` },
      { status: 500 }
    );
  }
}
