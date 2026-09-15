import { NextRequest, NextResponse } from "next/server";
import { encode } from "next-auth/jwt";

import { prisma } from "@/lib/db";
import {
  LEGACY_LOCAL_PRINCIPAL_EMAIL,
  LOCAL_PRINCIPAL_EMAIL,
  LOCAL_PRINCIPAL_NAME,
  isLocalDeployment,
} from "@/lib/deployment";

/**
 * GET /api/auth/desktop-local[?format=json][&callbackUrl=/]
 *
 * Local mode only (desktop app and `npm run dev`). The workbench needs no
 * account: this mints a session for the single local principal so every
 * route that keys data by user id keeps working. It is a technical identity,
 * never an external account; ChatMol Cloud is an optional connection made
 * later from Settings.
 *
 * Returns 404 on hosted deployments, which the client uses to fall back to
 * the hosted entry flow.
 */
export async function GET(req: NextRequest) {
  if (!isLocalDeployment()) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "NEXTAUTH_SECRET is not set; the local session cannot be created." }, { status: 500 });
  }

  // Single-user machine: adopt the existing record that owns the chat
  // history (a WeMol login or a pre-0.9.1 local user) so sessions are not
  // orphaned; only create the local principal when there is none.
  const existing = await prisma.user.findFirst({
    where: { email: { notIn: [LOCAL_PRINCIPAL_EMAIL] } },
    orderBy: { chatSessions: { _count: "desc" } },
  });
  const dbUser = existing
    ? await prisma.user.update({
      where: { id: existing.id },
      data: {
        emailVerified: existing.emailVerified ?? new Date(),
        status: "approved",
        ...(existing.email === LEGACY_LOCAL_PRINCIPAL_EMAIL ? { email: LOCAL_PRINCIPAL_EMAIL, name: LOCAL_PRINCIPAL_NAME } : {}),
      },
    })
    : await prisma.user.upsert({
      where: { email: LOCAL_PRINCIPAL_EMAIL },
      update: { emailVerified: new Date(), status: "approved" },
      create: { email: LOCAL_PRINCIPAL_EMAIL, name: LOCAL_PRINCIPAL_NAME, emailVerified: new Date(), status: "approved" },
    });

  const now = Math.floor(Date.now() / 1000);
  const maxAge = 365 * 24 * 60 * 60;
  const cookieName = "authjs.session-token";
  const token = await encode({
    secret,
    salt: cookieName,
    token: {
      id: dbUser.id,
      sub: dbUser.id,
      name: dbUser.name || LOCAL_PRINCIPAL_NAME,
      email: dbUser.email || LOCAL_PRINCIPAL_EMAIL,
      iat: now,
      exp: now + maxAge,
    },
    maxAge,
  });

  const wantsJson = req.nextUrl.searchParams.get("format") === "json";
  const target = req.nextUrl.searchParams.get("callbackUrl") || "/";
  const response = wantsJson
    ? NextResponse.json({ ok: true, principal: { kind: "local", id: dbUser.id, name: dbUser.name || LOCAL_PRINCIPAL_NAME } })
    : NextResponse.redirect(new URL(target.startsWith("/") ? target : "/", req.url));
  response.cookies.set(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  return response;
}
