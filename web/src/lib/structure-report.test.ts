import { describe, expect, it } from "vitest";

import {
  describeRfdiffusionOutput,
  formatChainSummary,
  summarizePdbChains,
} from "./structure-report";

function atom(serial: number, name: string, res: string, chain: string, resSeq: number): string {
  return [
    "ATOM  ",
    String(serial).padStart(5),
    " ",
    name.padEnd(4),
    " ",
    res.padEnd(3),
    " ",
    chain,
    String(resSeq).padStart(4),
    "    ",
    "   0.000   0.000   0.000  1.00 50.00           C  ",
  ].join("");
}

/** Chain B with residues 33, 34, 36 (a gap at 35). */
const INPUT_PDB = [
  atom(1, "CA", "ASN", "B", 33),
  atom(2, "CA", "GLY", "B", 34),
  atom(3, "CA", "TYR", "B", 36),
  "END",
].join("\n");

/** RFdiffusion-style output: binder chain A 1-2, then target chain B renumbered 3-5. */
const RF_OUTPUT_PDB = [
  atom(1, "CA", "GLY", "A", 1),
  atom(2, "CA", "GLY", "A", 2),
  atom(3, "CA", "ASN", "B", 3),
  atom(4, "CA", "GLY", "B", 4),
  atom(5, "CA", "TYR", "B", 5),
  "END",
].join("\n");

describe("summarizePdbChains", () => {
  it("reports residue counts, ranges and gaps per chain", () => {
    const chains = summarizePdbChains(INPUT_PDB);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ chain: "B", residues: 3, first: 33, last: 36 });
    expect(chains[0].gaps).toEqual([35]);
  });

  it("separates multiple chains in file order", () => {
    const chains = summarizePdbChains(RF_OUTPUT_PDB);
    expect(chains.map((c) => c.chain)).toEqual(["A", "B"]);
    expect(chains[0]).toMatchObject({ residues: 2, first: 1, last: 2 });
    expect(chains[1]).toMatchObject({ residues: 3, first: 3, last: 5 });
  });

  it("returns an empty list for text with no atoms", () => {
    expect(summarizePdbChains("HEADER something\nEND")).toEqual([]);
  });

  it("formats a one-line-per-chain summary", () => {
    const text = formatChainSummary(summarizePdbChains(INPUT_PDB));
    expect(text).toMatch(/chain B/);
    expect(text).toMatch(/33-36/);
    expect(text).toMatch(/gap/i);
  });
});

describe("describeRfdiffusionOutput", () => {
  it("states that residues are renumbered and gives the real ranges", () => {
    const text = describeRfdiffusionOutput(RF_OUTPUT_PDB);
    expect(text).toMatch(/renumber/i);
    expect(text).toMatch(/chain A/);
    expect(text).toMatch(/3-5/);
  });

  it("maps requested input hotspots onto the renumbered output residues", () => {
    const text = describeRfdiffusionOutput(RF_OUTPUT_PDB, {
      inputPdb: INPUT_PDB,
      hotspots: ["B34", "B36"],
    });
    // Input B34 is the 2nd target residue -> output B4; B36 is the 3rd -> B5.
    expect(text).toMatch(/B34\s*->\s*B4/);
    expect(text).toMatch(/B36\s*->\s*B5/);
  });

  it("flags hotspots that are absent from the input structure", () => {
    const text = describeRfdiffusionOutput(RF_OUTPUT_PDB, {
      inputPdb: INPUT_PDB,
      hotspots: ["B35"],
    });
    expect(text).toMatch(/B35/);
    expect(text).toMatch(/not in the input/i);
  });

  it("works without an input structure", () => {
    const text = describeRfdiffusionOutput(RF_OUTPUT_PDB, { hotspots: ["B34"] });
    expect(text).toMatch(/chain A/);
  });
});
