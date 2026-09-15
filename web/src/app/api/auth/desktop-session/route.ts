import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isLocalDeployment } from "@/lib/deployment";
import { saveDesktopSyncToken } from "@/lib/settings";
import { DESKTOP_REDIRECT, PendingDesktopLogin } from "@/lib/desktop-pkce";

const pending = new PendingDesktopLogin();
const remoteUrl = process.env.CHATMOL_REMOTE_URL || "https://lab.cloudmol.org";

// Initiation requires a same-origin request and the local workspace session.
export async function POST(req: NextRequest) {
  if (!isLocalDeployment()) return NextResponse.json({ error: "Not available" }, { status: 404 });
  if (req.headers.get("origin") !== req.nextUrl.origin || !(await auth())?.user?.id) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  const url = new URL("/auth/desktop-login", remoteUrl);
  if (url.protocol !== "https:") return NextResponse.json({ error: "Cloud requires HTTPS" }, { status: 400 });
  const { state, challenge } = pending.start();
  url.search = new URLSearchParams({ state, code_challenge: challenge, code_challenge_method: "S256", redirect_uri: DESKTOP_REDIRECT }).toString();
  return NextResponse.json({ url: url.href }, { headers: { "Cache-Control": "no-store" } });
}

// The verifier stays in daemon memory. Connecting never replaces local identity.
export async function GET(req: NextRequest) {
  if (!isLocalDeployment()) return NextResponse.json({ error: "Not available" }, { status: 404 });
  const code = req.nextUrl.searchParams.get("code") || "";
  const state = req.nextUrl.searchParams.get("state") || "";
  if (!/^[a-f0-9]{64}$/.test(code)) return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  const verifier = pending.consume(state);
  if (!verifier) return NextResponse.json({ error: "Login not initiated here or expired. Reconnect from Settings." }, { status: 401 });
  try {
    const url = new URL("/api/auth/desktop-token", remoteUrl);
    if (url.protocol !== "https:") throw new Error("Cloud requires HTTPS");
    const response = await fetch(url, {
      method: "POST", redirect: "error", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "exchange", code, code_verifier: verifier, redirect_uri: DESKTOP_REDIRECT }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Cloud rejected secure exchange");
    const data = await response.json();
    if (typeof data.syncToken !== "string" || !data.syncToken) throw new Error("Missing Cloud token");
    saveDesktopSyncToken(data.syncToken);
    const result = NextResponse.redirect(new URL("/", req.url));
    result.headers.set("Cache-Control", "no-store");
    result.headers.set("Referrer-Policy", "no-referrer");
    return result;
  } catch {
    return NextResponse.json({ error: "Secure Cloud connection failed. Ensure Cloud supports PKCE, then reconnect from Settings." }, { status: 502 });
  }
}
