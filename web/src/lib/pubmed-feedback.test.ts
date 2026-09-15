import { describe, expect, it } from "vitest";
import { formatPubmedFeedback, parseMedlineAbstracts } from "./pubmed-feedback";
describe("PubMed record budgeting", () => {
  it("associates multiline abstracts with their PMID without swallowing other fields", () => {
    const parsed = parseMedlineAbstracts("PMID- 101\nTI  - Paper\nAB  - First sentence.\n      Second sentence.\nCI  - Copyright.\n\nPMID- 202\nTI  - No abstract\n\nPMID- 303\nAB  - Last abstract.");
    expect(parsed.get("101")).toBe("First sentence. Second sentence.");
    expect(parsed.get("202")).toBe("");
    expect(parsed.get("303")).toBe("Last abstract.");
  });
  it("preserves all ten identifiers and excerpt labels within the model budget", () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(100 + i));
    const output = formatPubmedFeedback(ids, ids.map(() => "Metadata ".repeat(500)), new Map(ids.map(id => [id, "Abstract ".repeat(2000)])), 7800);
    expect(output.length).toBeLessThanOrEqual(7800);
    for (const id of ids) expect(output).toContain(`PMID ${id}\n`);
    expect(output.match(/abstract shortened/g)).toHaveLength(10);
    expect(output).toContain("excerpts, not complete evidence");
  });
  it("labels missing abstracts and keeps complete short abstracts", () => {
    const output = formatPubmedFeedback(["1", "2"], ["One", "Two"], new Map([["2", "Complete abstract."]]), 7800);
    expect(output).toContain("[not returned by PubMed]");
    expect(output).toContain("Complete abstract.");
    expect(output).not.toContain("[abstract shortened]");
  });
});
