import { NextResponse } from "next/server";

import { getDeploymentMode } from "@/lib/deployment";
import { isElectronServer } from "@/lib/electron";
import { getDesktopSyncToken } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * GET /api/deployment — public, unauthenticated.
 * Tells the client how this server runs so the UI can hide account concepts
 * in local mode and offer ChatMol Cloud as an optional connection.
 */
export async function GET() {
  const electron = isElectronServer();
  return NextResponse.json({
    mode: getDeploymentMode(),
    electron,
    cloud: {
      remoteUrl: process.env.CHATMOL_REMOTE_URL || "https://lab.cloudmol.org",
      connected: electron ? Boolean(getDesktopSyncToken()) : false,
    },
  });
}
