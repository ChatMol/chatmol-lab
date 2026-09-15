import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserWemolCredentials } from "@/lib/settings";
import { resolveWemolCli, getWemolCliEnv, runWemolCli } from "@/lib/wemol-cli";
import { getSessionWorkspace } from "@/lib/workspace";
import { parseWemolProgressPercent, parseWemolStatus } from "@/lib/wemol-jobs";
import type { WemolJobStatus } from "@/lib/types";

// wemol-cli login + status can be slow.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { jobId, sessionId } = await req
    .json()
    .catch(() => ({ jobId: "", sessionId: "" }));
  if (!jobId || typeof jobId !== "string") {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  const session = await auth();
  const userId = session?.user?.id || null;

  const creds = await getUserWemolCredentials(userId);
  if (!creds) {
    return NextResponse.json(
      { error: "WeMol credentials not configured." },
      { status: 400 }
    );
  }

  const cwd = sessionId ? getSessionWorkspace(sessionId) : process.cwd();
  const bin = resolveWemolCli();
  const env = getWemolCliEnv(bin);

  // Ensure logged in (wemol-cli caches the session locally, so this is fast).
  const login = await runWemolCli(
    ["login", "--username", creds.username, "--password", creds.password],
    { cwd, timeoutMs: 15000, env }
  );
  if (login.code !== 0 && !(login.stdout + login.stderr).includes("already")) {
    return NextResponse.json({ error: "WeMol login failed." }, { status: 502 });
  }

  const statusRes = await runWemolCli(["job", "status", jobId], {
    cwd,
    timeoutMs: 20000,
    env,
  });
  const statusOutput = (statusRes.stdout + (statusRes.stderr ? `\n${statusRes.stderr}` : "")).trim();

  if (statusRes.code !== 0) {
    return NextResponse.json({
      status: "unknown" as WemolJobStatus,
      message: statusOutput.slice(0, 300) || "status check failed",
    });
  }

  const progressRes = await runWemolCli(["job", "progress", jobId], {
    cwd,
    timeoutMs: 20000,
    env,
  });
  const progressOutput = (progressRes.stdout + (progressRes.stderr ? `\n${progressRes.stderr}` : "")).trim();
  const combinedOutput = [statusOutput, progressOutput].filter(Boolean).join("\n");
  const progressPercent = parseWemolProgressPercent(combinedOutput);
  const coarseStatus = parseWemolStatus(statusOutput);
  const status: WemolJobStatus = coarseStatus === "failed"
    ? "failed"
    : progressPercent === 100
      ? "done"
      : coarseStatus === "pending"
        ? "pending"
        : "running";
  const progress = typeof progressPercent === "number" ? `${progressPercent}%` : undefined;

  return NextResponse.json({
    status,
    progress,
    progressPercent,
    message: combinedOutput.slice(0, 500),
  });
}
