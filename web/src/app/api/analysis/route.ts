import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { isElectronServer } from "@/lib/electron";
import {
  ANALYSIS_REQUIREMENTS,
  getAnalysisStatus,
  installAnalysisDependencies,
} from "@/lib/structure-analysis";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function allowed(): Promise<boolean> {
  if (isElectronServer()) return true;
  const session = await auth();
  return Boolean(session?.user?.id);
}

/** GET /api/analysis — is the structure-analysis backend ready in the runtime? */
export async function GET(request: NextRequest) {
  if (!(await allowed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const force = request.nextUrl.searchParams.get("refresh") === "1";
  const status = await getAnalysisStatus(force);
  return NextResponse.json({ ...status, requirements: ANALYSIS_REQUIREMENTS }, { headers: { "Cache-Control": "no-store" } });
}

/** POST /api/analysis { action: "install", dssp?: boolean } */
export async function POST(request: NextRequest) {
  if (!(await allowed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (body.action !== "install") return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const install = await installAnalysisDependencies({ includeDssp: body.dssp === true });
  const status = await getAnalysisStatus(true);
  return NextResponse.json({ ...status, requirements: ANALYSIS_REQUIREMENTS, install });
}
