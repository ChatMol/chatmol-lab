import { expect, it } from "vitest";
import { isolatedHtml, PREVIEW_CSP } from "./html-preview";
it("installs restrictive policy before untrusted scripts or policies", () => {
  const attack = '<script>fetch("https://evil.example")</script><meta http-equiv="Content-Security-Policy" content="default-src *">';
  const html = isolatedHtml(attack);
  expect(html.indexOf(PREVIEW_CSP)).toBeLessThan(html.indexOf(attack));
  expect(PREVIEW_CSP).toContain("connect-src 'none'");
  expect(PREVIEW_CSP).toContain("base-uri 'none'");
});
