import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/llm-client", () => ({ completeText: vi.fn() }));
vi.mock("@/lib/settings", () => ({ loadSettings: () => ({}), getFastApiConfig: () => ({ key: "test-key", url: "https://example.test" }) }));
import { completeText } from "@/lib/llm-client";
import { POST } from "./route";
afterEach(() => vi.resetAllMocks());
const request = () => new NextRequest("http://localhost/api/sessions/title", { method: "POST", body: JSON.stringify({ message: "Fetch ubiquitin structure" }) });
it("retries rejected text once and uses a valid second title", async () => {
  vi.mocked(completeText).mockResolvedValueOnce({ text: "We need a title", model: "test" }).mockResolvedValueOnce({ text: "Ubiquitin Structure", model: "test" });
  expect((await (await POST(request())).json()).title).toBe("Ubiquitin Structure");
  expect(completeText).toHaveBeenCalledTimes(2);
});
it("keeps strict multiline rejection and falls back after two attempts", async () => {
  vi.mocked(completeText).mockResolvedValue({ text: "Ubiquitin\nThis explains it", model: "test" });
  expect((await (await POST(request())).json()).title).toBe("Fetch ubiquitin structure");
  expect(completeText).toHaveBeenCalledTimes(2);
});
