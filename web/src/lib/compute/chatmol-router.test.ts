import { afterEach, describe, expect, it } from "vitest";

import { isRouterOrigin } from "./chatmol-router";

afterEach(() => { delete process.env.CHATMOL_ROUTER_URL; });

describe("router origin guard", () => {
  it("accepts only the Router's own HTTPS origin", () => {
    const base = "https://api.chatmol.org";
    expect(isRouterOrigin("https://api.chatmol.org/v1/artifacts/a1/download", base)).toBe(true);
    expect(isRouterOrigin("https://api.chatmol.org:443/v1/x", base)).toBe(true);
  });

  it("rejects third-party pre-signed storage and look-alike hosts", () => {
    const base = "https://api.chatmol.org";
    for (const url of [
      "https://evil.example/steal",
      "https://s3.amazonaws.com/bucket/artifact.tar.gz",
      "https://api.chatmol.org.evil.example/v1/x",
      "http://api.chatmol.org/v1/x",
      "not a url",
    ]) {
      expect(isRouterOrigin(url, base)).toBe(false);
    }
  });

  it("allows a plain-HTTP loopback Router for local development", () => {
    expect(isRouterOrigin("http://localhost:8080/v1/x", "http://localhost:8080")).toBe(true);
    expect(isRouterOrigin("http://127.0.0.1:8080/v1/x", "http://127.0.0.1:8080")).toBe(true);
  });
});
