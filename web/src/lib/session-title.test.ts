import { describe, expect, it } from "vitest";
import { TITLE_MAX_CHARS, buildTitleUserPrompt, fallbackTitle, sanitizeGeneratedTitle, titleMatchesMessageScript } from "./session-title";

describe("sanitizeGeneratedTitle", () => {
  it("rejects reasoning / instruction echoes observed in real sessions", () => {
    expect(sanitizeGeneratedTitle("We need answer only title max 6 words. Need understand messa")).toBeNull();
    expect(sanitizeGeneratedTitle("We need answer o")).toBeNull();
    expect(sanitizeGeneratedTitle("The user wants a short title for fetching ubiquitin")).toBeNull();
    expect(sanitizeGeneratedTitle("Okay, let me think about the title.")).toBeNull();
    expect(sanitizeGeneratedTitle("用户想要下载泛素蛋白的结构，我需要给出一个标题")).toBeNull();
  });

  it("rejects multi-line or overlong output", () => {
    expect(sanitizeGeneratedTitle("Ubiquitin Structure\nThis title captures the request")).toBeNull();
    expect(sanitizeGeneratedTitle("one two three four five six seven eight nine ten eleven twelve")).toBeNull();
    expect(sanitizeGeneratedTitle("")).toBeNull();
    expect(sanitizeGeneratedTitle("   ")).toBeNull();
  });

  it("keeps real titles and strips decoration", () => {
    expect(sanitizeGeneratedTitle("Ubiquitin 1UBQ Secondary Structure")).toBe("Ubiquitin 1UBQ Secondary Structure");
    expect(sanitizeGeneratedTitle("\"Ubiquitin Structure Analysis.\"")).toBe("Ubiquitin Structure Analysis");
    expect(sanitizeGeneratedTitle("Title: **Ubiquitin Structure**")).toBe("Ubiquitin Structure");
    expect(sanitizeGeneratedTitle("「泛素蛋白1UBQ结构分析」")).toBe("泛素蛋白1UBQ结构分析");
    expect(sanitizeGeneratedTitle("标题：泛素二级结构。")).toBe("泛素二级结构");
  });

  it("caps length", () => {
    const title = sanitizeGeneratedTitle("泛".repeat(70));
    expect(title === null || title.length <= TITLE_MAX_CHARS).toBe(true);
  });
});

describe("fallbackTitle / buildTitleUserPrompt", () => {
  it("truncates the first message", () => {
    expect(fallbackTitle("short")).toBe("short");
    // No ellipsis: the fallback is a title, not a truncated sentence.
    expect(fallbackTitle("x".repeat(80))).toBe("x".repeat(TITLE_MAX_CHARS));
  });

  it("keeps instructions out of the user turn", () => {
    const prompt = buildTitleUserPrompt("用 fetch_pdb 下载泛素蛋白 1UBQ 的结构");
    expect(prompt).toContain("1UBQ");
    expect(prompt).not.toMatch(/max 6 words|Return ONLY/i);
  });
});

describe("title language", () => {
  it("rejects a Chinese title for an English message", () => {
    expect(titleMatchesMessageScript("下载并分析 1UBQ", "Download 1UBQ and describe its fold")).toBe(false);
    expect(sanitizeGeneratedTitle("下载并分析 1UBQ", "Download 1UBQ and describe its fold")).toBeNull();
  });

  it("keeps an English title for an English message", () => {
    expect(sanitizeGeneratedTitle("Download and analyze 1UBQ", "Download 1UBQ and describe its fold"))
      .toBe("Download and analyze 1UBQ");
  });

  it("leaves Chinese messages alone in either direction", () => {
    expect(sanitizeGeneratedTitle("下载并分析 1UBQ", "下载 1UBQ 并介绍二级结构")).toBe("下载并分析 1UBQ");
    // A Chinese request naming an English tool may legitimately get a Latin title.
    expect(sanitizeGeneratedTitle("RFdiffusion binder design", "用 RFdiffusion 设计 binder")).toBe("RFdiffusion binder design");
  });

  it("ignores the check when there is no source message", () => {
    expect(titleMatchesMessageScript("下载 1UBQ", "")).toBe(true);
  });
});

describe("accepting and falling back", () => {
  it("keeps taking a single clean line, including a labelled one", () => {
    expect(sanitizeGeneratedTitle("Title: Fetch 1PGA structure", "Fetch 1PGA")).toBe("Fetch 1PGA structure");
  });

  it("still rejects output that is only reasoning", () => {
    expect(sanitizeGeneratedTitle("We need answer only title max 6 words no quotes", "Download 1UBQ")).toBeNull();
  });

  it("falls back to a title, not a truncated sentence", () => {
    const long = "Search PubMed for recent small-molecule PD-1/PD-L1 inhibitors and summarize them in a table.";
    const title = fallbackTitle(long);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("...")).toBe(false);
    expect(title.endsWith(".")).toBe(false);
    expect(title).toBe("Search PubMed for recent small-molecule PD-1/PD-L1");
  });

  it("keeps a short message whole and drops its trailing punctuation", () => {
    expect(fallbackTitle("Download 1UBQ and describe its fold.")).toBe("Download 1UBQ and describe its fold");
    expect(fallbackTitle("下载 1UBQ 并介绍二级结构。")).toBe("下载 1UBQ 并介绍二级结构");
  });

  it("uses the first non-empty line of a multi-line message", () => {
    expect(fallbackTitle("\n\nFetch 1PGA\nthen fold it")).toBe("Fetch 1PGA");
  });
});
