import { createHash, randomBytes } from "crypto";
export const DESKTOP_REDIRECT = "chatmol://auth/callback";
export const LOGIN_TTL = 5 * 60 * 1000;
export const validChallenge = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
export const validVerifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(v);
export const challengeFor = (v: string): string => createHash("sha256").update(v).digest("base64url");
export class PendingDesktopLogin {
  private pending: { state: string; verifier: string; expires: number } | null = null;
  start(now = Date.now()) {
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    this.pending = { state, verifier, expires: now + LOGIN_TTL };
    return { state, challenge: challengeFor(verifier) };
  }
  consume(state: string, now = Date.now()): string | null {
    const p = this.pending;
    if (!p || p.expires <= now || p.state !== state) return null;
    this.pending = null;
    return p.verifier;
  }
}
