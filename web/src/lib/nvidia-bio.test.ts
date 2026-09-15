import { describe, expect, it } from "vitest";

import { handleResponse } from "./nvidia-bio";

function jsonResponse(status: number, body: unknown, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string, statusText = ""): Response {
  return new Response(body, { status, statusText, headers: { "content-type": "text/plain" } });
}

describe("handleResponse", () => {
  it("returns parsed JSON for a successful response", async () => {
    await expect(handleResponse(jsonResponse(200, { output_pdb: "ATOM  x" }))).resolves.toEqual({
      output_pdb: "ATOM  x",
    });
  });

  it("returns raw PDB text as a structure", async () => {
    const pdb = "ATOM      1  CA  GLY A   1       0.000   0.000   0.000\nEND";
    await expect(handleResponse(textResponse(200, pdb))).resolves.toMatchObject({
      structure: pdb,
      format: "pdb",
    });
  });

  // Regression: session 1789232187860-ycq9wn3 reported
  // "ESMFold error: NVIDIA API error: endpoint returned 404" for every call.
  // That message was inferred by grepping the body for the substring "404";
  // the real HTTP status was never read, so the failure was unactionable.
  it("surfaces the real HTTP status for a failed response", async () => {
    await expect(handleResponse(textResponse(404, "Not Found", "Not Found"))).rejects.toThrow(
      /404/,
    );
  });

  it("distinguishes 403 from 404 instead of guessing", async () => {
    const err = await handleResponse(jsonResponse(403, { detail: "no access" })).catch((e) => e);
    expect(String(err)).toMatch(/403/);
  });

  it("includes a body snippet so the caller can tell why it failed", async () => {
    const err = await handleResponse(textResponse(429, "rate limit exceeded, retry later")).catch(
      (e) => e,
    );
    expect(String(err)).toMatch(/rate limit exceeded/);
    expect(String(err)).toMatch(/429/);
  });

  it("does not claim 404 just because the body mentions 404", async () => {
    const err = await handleResponse(
      jsonResponse(500, { detail: "upstream said 404 but this is a 500" }),
    ).catch((e) => e);
    expect(String(err)).toMatch(/500/);
  });

  it("still reports API-level errors on a 200 response", async () => {
    await expect(handleResponse(jsonResponse(200, { detail: "bad contigs" }))).rejects.toThrow(
      /bad contigs/,
    );
  });
});
