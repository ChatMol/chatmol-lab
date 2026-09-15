import { expect, it } from "vitest";
import { buildSystemPrompt } from "./tools";
it("anchors relative date queries to the supplied current date and server zone", () => {
  const prompt = buildSystemPrompt("/nonexistent-date-test", new Date(2026, 8, 14, 12));
  expect(prompt).toContain("Today is 2026-09-14");
  expect(prompt).toContain(`server time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
});
