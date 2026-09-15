import { describe, expect, it } from "vitest";
import { PendingDesktopLogin, LOGIN_TTL, challengeFor } from "./desktop-pkce";
describe("desktop login binding", () => {
  it("implements the RFC 7636 S256 example", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("rejects unsolicited, wrong, expired and replayed callbacks", () => {
    const login = new PendingDesktopLogin();
    expect(login.consume("unknown", 0)).toBeNull();
    const first = login.start(0);
    expect(login.consume("wrong", 1)).toBeNull();
    const verifier = login.consume(first.state, 1)!;
    expect(challengeFor(verifier)).toBe(first.challenge);
    expect(login.consume(first.state, 2)).toBeNull();
    const expired = login.start(0);
    expect(login.consume(expired.state, LOGIN_TTL)).toBeNull();
    const replaced = login.start(0); login.start(1);
    expect(login.consume(replaced.state, 2)).toBeNull();
  });
});
