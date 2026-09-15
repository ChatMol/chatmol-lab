import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";
import { NextResponse } from "next/server";
import { isLocalDeployment } from "@/lib/deployment";
import { SELF_AUTHENTICATED_API_PREFIXES } from "@/lib/route-auth";

// Edge-safe auth instance (no Prisma/bcrypt — only JWT verification)
const { auth } = NextAuth(authConfig);

// Routes that don't require authentication
const PUBLIC_PATHS = [
  "/auth/",
  "/api/auth/",
  "/api/daemon/",
  "/api/deployment",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Defence in depth against DNS rebinding, not the network boundary.
 *
 * The boundary is the listener: `npm run dev` and `npm run start` bind
 * 127.0.0.1 (CHATMOL_BIND_HOST overrides), and Electron starts the daemon on
 * 127.0.0.1. This check additionally rejects requests that reach the server
 * carrying someone else's Host header, which is how a page on the web reaches
 * a localhost service. A Host header is client-controlled and proves nothing
 * on its own.
 */
function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (isLocalDeployment() && process.env.CHATMOL_LOCAL_ALLOW_REMOTE !== "1" && !isLoopbackHost(req.headers.get("host"))) {
    return NextResponse.json(
      { error: "This ChatMol Lab server runs in local mode and only answers requests from this machine. Set CHATMOL_LOCAL_ALLOW_REMOTE=1 to expose it deliberately." },
      { status: 403 },
    );
  }

  // Rewrite /tmp/chatmol-workspace/... URLs to /api/files/serve
  if (pathname.startsWith("/tmp/chatmol-workspace/")) {
    const url = req.nextUrl.clone();
    url.pathname = "/api/files/serve";
    url.searchParams.set("path", pathname);
    return NextResponse.rewrite(url);
  }

  // Allow public paths
  for (const p of PUBLIC_PATHS) {
    if (pathname.startsWith(p)) return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // Allow route-level authenticated APIs that do their own token/session check.
  // The list is deployment-specific; see route-auth.ts.
  if (SELF_AUTHENTICATED_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  // Allow share viewer pages and GET-only share API (read-only public access)
  // POST/DELETE /api/share require auth — handled by their route handlers
  if (pathname.startsWith("/share/")) {
    return NextResponse.next();
  }
  // Only allow GET for /api/share/[id] (public read); POST /api/share and DELETE require auth via route handlers
  if (pathname.startsWith("/api/share/") && pathname !== "/api/share") {
    return NextResponse.next();
  }

  // The root page handles its own entry (local session or hosted landing)
  if (pathname === "/") {
    return NextResponse.next();
  }

  // Check auth for everything else
  if (!req.auth) {
    // Local mode has no accounts: mint the local session and come back.
    const entry = isLocalDeployment() ? new URL("/api/auth/desktop-local", req.url) : new URL("/auth/signin", req.url);
    entry.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(entry);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Match all routes except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
