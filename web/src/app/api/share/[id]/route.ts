import { NextRequest, NextResponse } from "next/server";
import { getDesktopSyncToken } from "@/lib/settings";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const remoteUrl = process.env.CHATMOL_REMOTE_URL || "https://lab.cloudmol.org";
  const response = await fetch(`${remoteUrl}/api/share/${encodeURIComponent(id)}`);
  return NextResponse.json(await response.json(), { status: response.status });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const remoteUrl = process.env.CHATMOL_REMOTE_URL || "https://lab.cloudmol.org";
  const token = getDesktopSyncToken();
  const response = await fetch(`${remoteUrl}/api/share/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
