import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveAnalysisScript, runStructureAnalysis } from "./structure-analysis";
import { executeAnalyzeStructure, formatAnalysisResult, ANALYZE_STRUCTURE_TOOL } from "./structure-analysis-tool";
import { resolvePresetPython } from "./mcp-presets";

describe("analysis backend discovery", () => {
  it("prefers the packaged analysis directory, then the repo layout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-analysis-"));
    try {
      const script = path.join(dir, "structure_analysis.py");
      fs.writeFileSync(script, "# stub");
      expect(resolveAnalysisScript({ CHATMOL_ANALYSIS_DIR: dir }, "/nowhere")).toBe(script);
      expect(resolveAnalysisScript({}, "/nowhere")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds the script from the web workspace root", () => {
    expect(resolveAnalysisScript({}, process.cwd())).toMatch(/analysis[\\/]structure_analysis\.py$/);
  });
});

describe("analyze_structure tool definition", () => {
  it("offers the six operations and requires one", () => {
    const schema = ANALYZE_STRUCTURE_TOOL.input_schema as {
      properties: { operation: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.operation.enum).toEqual([
      "secondary_structure", "superpose", "interface", "sasa", "confidence", "sequence_properties",
    ]);
    expect(schema.required).toEqual(["operation"]);
  });
});

describe("result formatting", () => {
  it("lines the secondary structure string up under its sequence", () => {
    const text = formatAnalysisResult("secondary_structure", {
      method: "DSSP (mkdssp, 8-state)",
      names: { H: "alpha helix", E: "beta strand" },
      chains: [{
        chain: "A", residues: 6, first: 10, last: 15,
        sequence: "AMKWVT", string: "HHHEEE",
        counts: { H: 3, E: 3 },
        fractions: { helix: 50, sheet: 50, turn: 0, coil: 0 },
        segments: [{ ss: "H", start: 10, end: 12, length: 3 }, { ss: "E", start: 13, end: 15, length: 3 }],
      }],
    }, 25);
    expect(text).toContain("DSSP (mkdssp, 8-state)");
    expect(text).toContain("helix 50%, sheet 50%");
    expect(text).toContain("AMKWVT");
    expect(text).toContain("HHHEEE");
    expect(text).toContain("H 10-12, E 13-15");
    expect(text).toContain("H=alpha helix");
  });

  it("warns about steric clashes before reporting interface contacts", () => {
    const text = formatAnalysisResult("interface", {
      label_a: "A", label_b: "B", cutoff: 4.5, buried_area: 1289.6,
      clash_cutoff: 2.2, clash_count: 2,
      clashes: [{ chain_a: "A", res_seq_a: 13, chain_b: "B", res_seq_b: 52, min_distance: 0.67 }],
      contacts: [{ chain_a: "A", res_seq_a: 13, res_name_a: "LYS", chain_b: "B", res_seq_b: 52, res_name_b: "GLU", min_distance: 0.67, atom_contacts: 23 }],
      residues_a: [{ chain: "A", res_seq: 13, res_name: "LYS" }],
      residues_b: [{ chain: "B", res_seq: 52, res_name: "GLU" }],
    }, 25);
    expect(text).toContain("buried surface area 1289.6");
    expect(text).toContain("WARNING: 2 residue pair(s)");
    expect(text).toContain("steric clashes");
    expect(text.indexOf("WARNING")).toBeLessThan(text.indexOf("Closest contacts"));
  });

  it("reports per-chain pairing and the worst deviations for a superposition", () => {
    const text = formatAnalysisResult("superpose", {
      rmsd: 9.159, atoms: 75, residues: 75, identity: 85.3, atom_selection: "CA",
      method: "sequence-anchored superposition",
      chain_pairs: [
        { reference_chain: "B", mobile_chain: "B", residues: 57, rmsd: 0, identity: 100 },
        { reference_chain: "A", mobile_chain: "A", residues: 18, rmsd: 12.355, identity: 38.9 },
      ],
      deviations: [
        { chain: "A", res_seq: 33, res_name: "GLY", deviation: 34.4 },
        { chain: "B", res_seq: 40, res_name: "SER", deviation: 0.1 },
      ],
      output_path: "/ws/fit.pdb",
    }, 25);
    expect(text).toContain("RMSD: 9.159 A over 75 residues");
    expect(text).toContain("B -> B: 57 residues, RMSD 0.000 A");
    expect(text).toContain("A33 GLY 34.40 A");
    expect(text).toContain("/ws/fit.pdb");
  });

  it("says plainly when B-factors are not pLDDT", () => {
    const text = formatAnalysisResult("confidence", {
      interpreted_as: "B-factor", mean: 31.2, min: 8.1, max: 88.4, residues: 120,
      bands: null, chains: [{ chain: "A", residues: 120, mean: 31.2, min: 8.1, max: 88.4 }], weakest: [],
    }, 25);
    expect(text).toContain("B-factor over 120 residues");
    expect(text).toContain("do not read them as model confidence");
  });

  it("renders sequence properties with units", () => {
    const text = formatAnalysisResult("sequence_properties", {
      source: "given sequence", length: 30, molecular_weight: 3580.1, isoelectric_point: 10.27,
      charge_at_pH7: 2.59, gravy: 0.073, instability_index: 48.71, aromaticity: 0.2,
      extinction_coefficient: { reduced: 6990, disulfide_bonds: 6990 },
      charged: { negative: 2, positive: 5, cysteines: 0 },
      composition_percent: { S: 16.7, F: 13.3 },
    }, 25);
    expect(text).toContain("3580.1 Da");
    expect(text).toContain("Isoelectric point: 10.27");
    expect(text).toContain("6990 M-1 cm-1");
  });
});

describe("input validation", () => {
  const workspace = path.join(os.tmpdir(), "cm-analysis-guard");

  it("rejects paths outside the session workspace", async () => {
    const result = await executeAnalyzeStructure({ operation: "confidence", path: "../../etc/passwd" }, workspace);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Access denied");
  });

  it("names the missing argument for each operation", async () => {
    expect((await executeAnalyzeStructure({ operation: "superpose", reference: "a.pdb" }, workspace)).output)
      .toContain("needs both `reference` and `mobile`");
    expect((await executeAnalyzeStructure({ operation: "sequence_properties" }, workspace)).output)
      .toContain("needs either `path` or `sequence`");
    expect((await executeAnalyzeStructure({ operation: "sasa" }, workspace)).output)
      .toContain("needs a structure file");
  });
});

// --- integration: only where the runtime already has biotite/Biopython ---

function backendReady(): boolean {
  if (!process.env.CHATMOL_CONDA_PREFIX) {
    const bundled = path.join(os.homedir(), ".chatmol-lab", "runtime", "mambaforge");
    if (fs.existsSync(bundled)) process.env.CHATMOL_CONDA_PREFIX = bundled;
  }
  const python = resolvePresetPython();
  const script = resolveAnalysisScript();
  if (!python || !script) return false;
  try {
    const out = execFileSync(python, [script], { input: JSON.stringify({ operation: "__version__" }), encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "ignore"] });
    return JSON.parse(out.trim().split("\n").pop() || "{}").ok === true;
  } catch {
    return false;
  }
}

/** Two short chains of CA-only residues, 3 A apart along x. */
function twoChainFixture(): string {
  const lines: string[] = [];
  let serial = 1;
  const emit = (chain: string, index: number, x: number) => {
    lines.push(
      "ATOM  " + String(serial++).padStart(5) + "  CA  ALA " + chain +
      String(index).padStart(4) + "    " +
      x.toFixed(3).padStart(8) + (index * 3.8).toFixed(3).padStart(8) + (0).toFixed(3).padStart(8) +
      "  1.00 50.00           C",
    );
  };
  for (let i = 1; i <= 6; i += 1) emit("A", i, 0);
  for (let i = 1; i <= 6; i += 1) emit("B", i, 3.0);
  lines.push("END");
  return lines.join("\n") + "\n";
}

describe.skipIf(!backendReady())("structure analysis backend", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cm-analysis-run-"));
    fs.writeFileSync(path.join(workspace, "two_chains.pdb"), twoChainFixture());
  });

  afterAll(() => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("computes sequence properties from a raw sequence", async () => {
    const result = await executeAnalyzeStructure(
      { operation: "sequence_properties", sequence: "MKWVTFISLLFLFSSAYSRGVFRRDAHKSE" },
      workspace,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("30 aa");
    expect(result.output).toMatch(/Molecular weight: 3\d{3}\.\d Da/);
  });

  it("finds the contacts between two chains placed 3 A apart", async () => {
    const result = await executeAnalyzeStructure(
      { operation: "interface", path: "two_chains.pdb", chains_a: ["A"], chains_b: ["B"] },
      workspace,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("residue-residue contacts");
    // 3 A between CA atoms is below the 2.2 A clash cutoff only for overlaps,
    // so the pose is reported as contacts without a clash warning.
    expect(result.output).not.toContain("WARNING");
  });

  it("superposes a structure onto itself with zero RMSD", async () => {
    const result = await executeAnalyzeStructure(
      { operation: "superpose", reference: "two_chains.pdb", mobile: "two_chains.pdb", output_path: "fit.pdb" },
      workspace,
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/RMSD: 0\.000 A/);
    expect(fs.existsSync(path.join(workspace, "fit.pdb"))).toBe(true);
  });

  it("reports a clear error for an unreadable file instead of throwing", async () => {
    fs.writeFileSync(path.join(workspace, "broken.pdb"), "not a structure\n");
    const response = await runStructureAnalysis(
      { operation: "confidence", path: path.join(workspace, "broken.pdb") },
      { autoInstall: false },
    );
    expect(response.ok).toBe(false);
    expect(String(response.error)).toBeTruthy();
  });
});
