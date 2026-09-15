import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { toTrackedStatus } from "@/lib/compute/provider";
import { getComputeProvider } from "@/lib/compute/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/compute/jobs/status { provider, jobId } — one status check for the desktop poller. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const providerId = typeof body.provider === "string" ? body.provider : "";
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!providerId || !jobId) return NextResponse.json({ error: "provider and jobId required" }, { status: 400 });

  const session = await auth();
  const provider = getComputeProvider(providerId);
  if (!provider) return NextResponse.json({ error: `Unknown provider ${providerId}` }, { status: 400 });
  const availability = await provider.availability({ userId: session?.user?.id || null }).catch(() => ({ ok: false, reason: "unavailable" }));
  if (!availability.ok) return NextResponse.json({ status: "unknown", message: availability.reason || "provider unavailable" });

  const job = await provider.getJob(jobId);
  if (!job) return NextResponse.json({ status: "unknown", message: "job not found" });
  return NextResponse.json({
    status: toTrackedStatus(job.status),
    message: job.output.slice(0, 500),
    progressPercent: job.progressPercent ?? null,
    progress: typeof job.progressPercent === "number" ? `${job.progressPercent}%` : undefined,
  });
}
