import { describe, expect, it } from "vitest";

import {
  buildRanges,
  buildSelectionContext,
  describeSelection,
  formatSelectionForModel,
  parseSelectionContext,
} from "./structure-selection";

describe("structure selection", () => {
  const residues = [
    { chain: "A", seq: 47, comp: "GLY" },
    { chain: "A", seq: 45, comp: "ARG" },
    { chain: "A", seq: 46, comp: "LYS" },
    { chain: "A", seq: 46, comp: "LYS" },
    { chain: "B", seq: 10, comp: "MSE" },
    { chain: "A", seq: 60, comp: "TRP" },
  ];

  it("collapses residues into chain ranges", () => {
    expect(buildRanges(residues)).toEqual(["A:45-47", "A:60", "B:10"]);
  });

  it("builds a context with sequence and chains", () => {
    const ctx = buildSelectionContext("1ubq.pdb", residues, { path: "1ubq.pdb", now: 1 });
    expect(ctx).not.toBeNull();
    expect(ctx!.residueCount).toBe(5);
    expect(ctx!.chains).toEqual(["A", "B"]);
    expect(ctx!.sequence).toBe("RKGWM");
    expect(describeSelection(ctx!)).toBe("1ubq.pdb · 5 residues · A:45-47, A:60, B:10");
    const block = formatSelectionForModel(ctx!);
    expect(block).toContain("<structure_selection>");
    expect(block).toContain("ranges (auth numbering): A:45-47, A:60, B:10");
    expect(block).toContain("ARG45/A");
    expect(buildSelectionContext("x.pdb", [])).toBeNull();
  });

  it("parses client metadata defensively", () => {
    expect(parseSelectionContext(null)).toBeNull();
    expect(parseSelectionContext({ file: "a.pdb", residues: [] })).toBeNull();
    const ctx = parseSelectionContext({ file: "a.pdb", residues: [{ chain: "A", seq: 1, comp: "ALA" }, { bad: true }] });
    expect(ctx?.residueCount).toBe(1);
  });
});
