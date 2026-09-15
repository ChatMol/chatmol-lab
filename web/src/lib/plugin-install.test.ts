import { describe, expect, it } from "vitest";

import { isGitSource } from "./plugin-install";

describe("plugin install sources", () => {
  it("tells git URLs from local folders", () => {
    expect(isGitSource("https://github.com/ChatMol/ChatMol-Skills")).toBe(true);
    expect(isGitSource("git@github.com:ChatMol/ChatMol-Skills.git")).toBe(true);
    expect(isGitSource("ssh://git@example.com/x/y")).toBe(true);
    expect(isGitSource("/Users/me/plugins/mine.git")).toBe(true);
    expect(isGitSource("/Users/me/plugins/mine")).toBe(false);
    expect(isGitSource("C:\\plugins\\mine")).toBe(false);
  });
});
