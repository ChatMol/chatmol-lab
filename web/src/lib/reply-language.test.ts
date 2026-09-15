import { describe, expect, it } from "vitest";

import { buildReplyLanguageSection, detectReplyLanguage, languageSample, stripInjectedContext } from "./reply-language";

describe("detectReplyLanguage", () => {
  it("reads the IL-13 incident request as English", () => {
    expect(detectReplyLanguage("Design a binder for il-13 using RFDiffusion")).toBe("English");
  });

  it("keeps English requests English when they contain a Chinese term or file name", () => {
    expect(detectReplyLanguage("Analyze the interface in 抗体.pdb and list contact residues")).toBe("English");
  });

  it("reads Chinese requests as Chinese even with tool names and IDs", () => {
    expect(detectReplyLanguage("用 RFdiffusion 为 IL-13 设计一个 binder")).toBe("Chinese");
    expect(detectReplyLanguage("预测 1CRN 的二级结构")).toBe("Chinese");
  });

  it("recognizes Japanese and Korean", () => {
    expect(detectReplyLanguage("このタンパク質の構造を予測してください")).toBe("Japanese");
    expect(detectReplyLanguage("이 단백질의 구조를 예측해 주세요")).toBe("Korean");
  });

  it("treats short Latin-script input as English and gives up on other Latin languages", () => {
    expect(detectReplyLanguage("1CRN?")).toBe("English");
    expect(detectReplyLanguage("Concevez un liant contre cette protéine rapidement")).toBeNull();
    expect(detectReplyLanguage("")).toBeNull();
  });

  it("ignores the Mol* selection block the client appends", () => {
    const block = "<structure_selection>\nfile: 4HWB.pdb\nchains: A\nresidues: 12\nranges (auth numbering): A200-A211\nsequence: GPVPPSTALREL\nlist: GLY200/A PRO201/A\n</structure_selection>";
    expect(stripInjectedContext(`看看这些残基\n\n${block}`)).toBe("看看这些残基");
    expect(detectReplyLanguage(`看看这些残基\n\n${block}`)).toBe("Chinese");
  });
});

describe("languageSample", () => {
  it("uses the latest message the user wrote, not an internal follow-up", () => {
    const messages = [
      { role: "user", content: "帮我提交一个 WeMol 任务" },
      { role: "assistant", content: "Submitted." },
      { role: "user", content: "The WeMol job finished. Import the results.", hidden: true },
    ];
    expect(languageSample(messages, "fallback")).toBe("帮我提交一个 WeMol 任务");
    expect(languageSample([], "Design a binder")).toBe("Design a binder");
  });
});

describe("buildReplyLanguageSection", () => {
  it("names the language explicitly", () => {
    expect(buildReplyLanguageSection("English")).toBe(
      "\n\n## Response Language\nThe user's latest message is written in English. Write your reply in English.",
    );
  });

  it("falls back to a same-language rule when the language is unknown", () => {
    expect(buildReplyLanguageSection(null)).toContain("same language as the user's latest message");
  });
});

describe("what the detector is allowed to read", () => {
  // harness:verify lets the system prompt read the user's message only through
  // this helper, on the strength of this property: the answer follows the
  // script of the text, never what the text asks for.
  it("gives the same answer for different requests in one language", () => {
    for (const text of [
      "Design a binder for IL-13 using RFDiffusion",
      "Delete the old outputs and run a virtual screen",
      "What does UniProt say about P01308?",
    ]) {
      expect(detectReplyLanguage(text)).toBe("English");
    }
    for (const text of ["用 RFdiffusion 设计一个 binder", "把旧结果删掉再跑一次虚拟筛选", "介绍一下 P01308"]) {
      expect(detectReplyLanguage(text)).toBe("Chinese");
    }
  });

  it("does not treat tool names, PDB ids or paths as content", () => {
    expect(detectReplyLanguage("分析 /tmp/ws/4HHB.pdb 的 interface，用 analyze_structure")).toBe("Chinese");
    expect(detectReplyLanguage("analyze the interface of 4HHB.pdb with analyze_structure")).toBe("English");
  });
});
