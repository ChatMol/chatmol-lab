import { NextRequest, NextResponse } from "next/server";
import { getDesktopSyncToken } from "@/lib/settings";

function headers(): HeadersInit {
  const token = getDesktopSyncToken();
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export async function GET() {
  const remoteUrl = process.env.CHATMOL_REMOTE_URL || "https://lab.cloudmol.org";
  const response = await fetch(`${remoteUrl}/api/share`, { headers: headers() });
  return NextResponse.json(await response.json(), { status: response.status });
}

export async function POST(request: NextRequest) {
  const remoteUrl = process.env.CHATMOL_REMOTE_URL || "https://lab.cloudmol.org";
  const response = await fetch(`${remoteUrl}/api/share`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(await request.json()),
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
