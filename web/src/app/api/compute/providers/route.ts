import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { listComputeProviders } from "@/lib/compute/registry";
import { loadSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** GET /api/compute/providers — providers, their capabilities and availability for the current user. */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id || null;
  const providers = await Promise.all(
    listComputeProviders().map(async (provider) => ({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      capabilities: [...provider.capabilities()],
      availability: await provider.availability({ userId }).catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) })),
    })),
  );
  return NextResponse.json({ backend: loadSettings().computeBackend, providers });
}
