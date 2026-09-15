/**
 * The `analyze_structure` tool: one entry point over the six analysis
 * operations, with the backend's JSON rendered into compact text for the model.
 */
import * as path from "path";

import { runStructureAnalysis, type AnalysisOperation } from "./structure-analysis";
import type { ToolDefinition, ToolResult } from "./tools";
import { safeResolvePath } from "./workspace";

export const ANALYZE_STRUCTURE_TOOL_NAME = "analyze_structure";
/** Generous: the first call may install biotite/Biopython into the runtime. */
export const ANALYZE_STRUCTURE_TIMEOUT_SEC = 420;

export const ANALYZE_STRUCTURE_TOOL: ToolDefinition = {
  name: ANALYZE_STRUCTURE_TOOL_NAME,
  description:
    "Analyze a protein structure with the bundled scientific runtime (biotite + Biopython). " +
    "Prefer this over writing BioPython or DSSP scripts in bash — it is faster, needs no setup, and returns consistent numbers. Operations:\n" +
    "- secondary_structure: per-residue DSSP-style assignment, helix/sheet/turn/coil composition and segment ranges.\n" +
    "- superpose: align two structures and report RMSD, matched chain pairs, sequence identity and per-residue deviation. Chains are matched by sequence, so renumbered designs still align. Optionally writes the superposed copy.\n" +
    "- interface: residue-residue contacts between two chain groups (or a ligand), plus buried surface area and a steric-clash warning — use it to judge a binder or docking pose. Waters and ions are excluded, so the residue list is the real interface; do not recompute it in a script.\n" +
    "- sasa: solvent accessible surface area per residue, with exposed/buried classification.\n" +
    "- confidence: pLDDT or B-factor statistics per chain, confidence bands and the weakest residues of a predicted model.\n" +
    "- sequence_properties: molecular weight, pI, charge, extinction coefficient, GRAVY, instability index and composition (from a file or a raw sequence).",
  input_schema: {
    type: "object" as const,
    properties: {
      operation: {
        type: "string",
        description: "Which analysis to run.",
        enum: ["secondary_structure", "superpose", "interface", "sasa", "confidence", "sequence_properties"],
      },
      path: { type: "string", description: "Structure file in the workspace (.pdb/.cif). Required for every operation except superpose." },
      reference: { type: "string", description: "superpose: the structure to align onto." },
      mobile: { type: "string", description: "superpose: the structure that is moved." },
      chains: { type: "array", items: { type: "string" }, description: "Restrict the analysis to these chain IDs." },
      reference_chains: { type: "array", items: { type: "string" }, description: "superpose: chains of the reference to use." },
      mobile_chains: { type: "array", items: { type: "string" }, description: "superpose: chains of the mobile structure to use." },
      atoms: { type: "string", enum: ["CA", "backbone"], description: "superpose: atoms to fit on (default CA)." },
      chains_a: { type: "array", items: { type: "string" }, description: "interface: chains on one side, e.g. the binder." },
      chains_b: { type: "array", items: { type: "string" }, description: "interface: chains on the other side; defaults to every other chain." },
      ligand: { type: "string", description: "interface: residue name of a ligand to use as side B instead of chains." },
      cutoff: { type: "number", description: "interface: heavy-atom contact distance in A (default 4.5)." },
      include_water: { type: "boolean", description: "interface/sasa: keep crystal waters and ions, which are excluded by default." },
      sequence: { type: "string", description: "sequence_properties: analyze this sequence instead of a file." },
      output_path: { type: "string", description: "superpose: workspace path to write the superposed mobile structure to." },
      max_rows: { type: "number", description: "Cap on listed rows (default 25)." },
    },
    required: ["operation"],
  },
};

type Json = Record<string, unknown>;

function asArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.map((item) => String(item).trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function fixed(value: unknown, digits = 2): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : String(value ?? "?");
}

/** Wrap the SS string under its sequence so the two line up when read. */
function alignedBlock(sequence: string, codes: string, first: number, width = 60): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < codes.length; offset += width) {
    const start = first + offset;
    lines.push(`  ${String(start).padStart(6)} ${sequence.slice(offset, offset + width)}`);
    lines.push(`         ${codes.slice(offset, offset + width)}`);
  }
  return lines;
}

function formatSecondaryStructure(result: Json, maxRows: number): string {
  const chains = (result.chains as Json[]) || [];
  const lines = [`Secondary structure — method: ${result.method}`];
  for (const chain of chains) {
    const fractions = chain.fractions as Json;
    lines.push(
      `\nChain ${chain.chain}: ${chain.residues} residues (${chain.first}-${chain.last}) — ` +
      `helix ${fractions.helix}%, sheet ${fractions.sheet}%, turn/bend ${fractions.turn}%, coil ${fractions.coil}%`,
    );
    lines.push(...alignedBlock(String(chain.sequence), String(chain.string), Number(chain.first)));
    const segments = (chain.segments as Json[]) || [];
    if (segments.length > 0) {
      const names = result.names as Record<string, string>;
      const shown = segments.slice(0, maxRows);
      lines.push(`  Segments: ${shown.map((s) => `${s.ss} ${s.start}-${s.end}`).join(", ")}${segments.length > shown.length ? `, +${segments.length - shown.length} more` : ""}`);
      const kinds = [...new Set(shown.map((s) => String(s.ss)))];
      lines.push(`  Codes: ${kinds.map((code) => `${code}=${names[code] || code}`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function formatSuperpose(result: Json, maxRows: number): string {
  const pairs = (result.chain_pairs as Json[]) || [];
  const deviations = ((result.deviations as Json[]) || []).slice();
  const lines = [
    `Superposition RMSD: ${fixed(result.rmsd, 3)} A over ${result.residues} residues (${result.atoms} ${result.atom_selection} atoms), sequence identity ${result.identity}%`,
    `Method: ${result.method}`,
  ];
  if (pairs.length > 0) {
    lines.push("Chain pairs (reference -> mobile):");
    for (const pair of pairs) {
      lines.push(`  ${pair.reference_chain} -> ${pair.mobile_chain}: ${pair.residues} residues, RMSD ${fixed(pair.rmsd, 3)} A, identity ${pair.identity}%`);
    }
  }
  deviations.sort((a, b) => Number(b.deviation) - Number(a.deviation));
  const worst = deviations.slice(0, Math.min(maxRows, 10));
  if (worst.length > 0) {
    lines.push(`Largest deviations: ${worst.map((d) => `${d.chain}${d.res_seq} ${d.res_name} ${fixed(d.deviation)} A`).join(", ")}`);
  }
  if (result.output_path) lines.push(`Superposed structure written to ${result.output_path}`);
  return lines.join("\n");
}

function formatInterface(result: Json, maxRows: number): string {
  const contacts = (result.contacts as Json[]) || [];
  const residuesA = (result.residues_a as Json[]) || [];
  const residuesB = (result.residues_b as Json[]) || [];
  const lines = [
    `Interface ${result.label_a} | ${result.label_b} at ${result.cutoff} A: ` +
    `${contacts.length} residue-residue contacts, ${residuesA.length} + ${residuesB.length} interface residues` +
    (result.buried_area != null ? `, buried surface area ${result.buried_area} A^2` : "") +
    (result.solvent_excluded && Number(result.solvent_atoms_removed) > 0
      ? `. Waters and ions were excluded (${result.solvent_atoms_removed} atoms); pass include_water: true to keep them.`
      : ""),
  ];
  const clashCount = Number(result.clash_count) || 0;
  if (clashCount > 0) {
    const clashes = (result.clashes as Json[]) || [];
    lines.push(
      `WARNING: ${clashCount} residue pair(s) have heavy atoms closer than ${result.clash_cutoff} A — these are steric clashes, ` +
      `so the complex has not been relaxed or the pose is wrong: ` +
      clashes.slice(0, 6).map((c) => `${c.chain_a}${c.res_seq_a}-${c.chain_b}${c.res_seq_b} ${fixed(c.min_distance)} A`).join(", "),
    );
  }
  if (contacts.length === 0) {
    lines.push("No contacts at this cutoff — the two selections do not touch.");
    return lines.join("\n");
  }
  const list = (items: Json[]) => items.map((r) => `${r.chain}${r.res_seq} ${r.res_name}`).join(", ");
  lines.push(`Side A residues: ${list(residuesA)}`);
  lines.push(`Side B residues: ${list(residuesB)}`);
  const shown = contacts.slice(0, maxRows);
  lines.push(`Closest contacts (min heavy-atom distance):`);
  for (const contact of shown) {
    lines.push(`  ${contact.chain_a}${contact.res_seq_a} ${contact.res_name_a} — ${contact.chain_b}${contact.res_seq_b} ${contact.res_name_b}: ${fixed(contact.min_distance)} A (${contact.atom_contacts} atom pairs)`);
  }
  if (contacts.length > shown.length) lines.push(`  ... ${contacts.length - shown.length} more contacts`);
  return lines.join("\n");
}

function formatSasa(result: Json, maxRows: number): string {
  const chains = (result.chains as Json[]) || [];
  const residues = (result.residues as Json[]) || [];
  const lines = [`Solvent accessible surface area: ${result.total_sasa} A^2 total`];
  for (const chain of chains) {
    lines.push(`  Chain ${chain.chain}: ${chain.total_sasa} A^2 over ${chain.residues} residues — ${chain.exposed} exposed, ${chain.buried} buried (25% relative cutoff)`);
  }
  const exposed = residues
    .filter((r) => typeof r.relative === "number")
    .sort((a, b) => Number(b.relative) - Number(a.relative))
    .slice(0, Math.min(maxRows, 15));
  if (exposed.length > 0) {
    lines.push(`Most exposed: ${exposed.map((r) => `${r.chain}${r.res_seq} ${r.res_name} ${r.relative}%`).join(", ")}`);
  }
  return lines.join("\n");
}

function formatConfidence(result: Json, maxRows: number): string {
  const chains = (result.chains as Json[]) || [];
  const bands = result.bands as Json | null;
  const weakest = ((result.weakest as Json[]) || []).slice(0, Math.min(maxRows, 15));
  const lines = [
    `${result.interpreted_as} over ${result.residues} residues: mean ${result.mean}, range ${result.min}-${result.max}`,
  ];
  if (bands) {
    lines.push(`Bands: ${Object.entries(bands).map(([name, count]) => `${name} ${count}`).join(", ")}`);
  }
  for (const chain of chains) {
    lines.push(`  Chain ${chain.chain}: mean ${chain.mean} over ${chain.residues} residues (min ${chain.min}, max ${chain.max})`);
  }
  if (weakest.length > 0) {
    lines.push(`Weakest residues: ${weakest.map((r) => `${r.chain}${r.res_seq} ${r.res_name} ${r.value}`).join(", ")}`);
  }
  if (result.interpreted_as === "B-factor") {
    lines.push("Values look like crystallographic B-factors, not pLDDT — do not read them as model confidence.");
  }
  return lines.join("\n");
}

function formatSequenceProperties(result: Json): string {
  const extinction = result.extinction_coefficient as Json;
  const charged = result.charged as Json;
  const composition = Object.entries((result.composition_percent as Record<string, number>) || {}).slice(0, 8);
  return [
    `Sequence properties (${result.source}, ${result.length} aa)`,
    `  Molecular weight: ${result.molecular_weight} Da`,
    `  Isoelectric point: ${result.isoelectric_point}; net charge at pH 7: ${result.charge_at_pH7}`,
    `  Extinction coefficient (280 nm): ${extinction.reduced} M-1 cm-1 reduced, ${extinction.disulfide_bonds} with disulfides`,
    `  GRAVY: ${result.gravy}; instability index: ${result.instability_index}; aromaticity: ${result.aromaticity}`,
    `  Charged residues: ${charged.negative} negative (D/E), ${charged.positive} positive (K/R), ${charged.cysteines} cysteines`,
    `  Most frequent: ${composition.map(([aa, percent]) => `${aa} ${percent}%`).join(", ")}`,
  ].join("\n");
}

export function formatAnalysisResult(operation: AnalysisOperation, result: Json, maxRows: number): string {
  switch (operation) {
    case "secondary_structure": return formatSecondaryStructure(result, maxRows);
    case "superpose": return formatSuperpose(result, maxRows);
    case "interface": return formatInterface(result, maxRows);
    case "sasa": return formatSasa(result, maxRows);
    case "confidence": return formatConfidence(result, maxRows);
    case "sequence_properties": return formatSequenceProperties(result);
    default: return JSON.stringify(result).slice(0, 4000);
  }
}

const PATH_FIELDS: Array<[string, string]> = [
  ["path", "path"],
  ["reference", "reference"],
  ["mobile", "mobile"],
];

export async function executeAnalyzeStructure(input: Record<string, unknown>, sessionWorkspace: string): Promise<ToolResult> {
  const operation = String(input.operation || "") as AnalysisOperation;
  const request: Record<string, unknown> = { operation };
  if (operation === "superpose" && (![input.reference, input.mobile].every((v) => typeof v === "string" && v.trim()))) {
    return { output: "superpose needs both `reference` and `mobile` file paths.", success: false };
  }

  for (const [field] of PATH_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || !value.trim()) continue;
    const resolved = safeResolvePath(value, sessionWorkspace);
    if (!resolved) return { output: `Access denied: ${field} is outside the workspace`, success: false };
    request[field] = resolved;
  }
  if (typeof input.output_path === "string" && input.output_path.trim()) {
    const resolved = safeResolvePath(input.output_path, sessionWorkspace);
    if (!resolved) return { output: "Access denied: output_path is outside the workspace", success: false };
    request.output_path = resolved;
  }

  if (operation === "superpose") {
    if (!request.reference || !request.mobile) return { output: "superpose needs both `reference` and `mobile` file paths.", success: false };
  } else if (operation === "sequence_properties") {
    if (typeof input.sequence === "string" && input.sequence.trim()) request.sequence = input.sequence.trim();
    else if (!request.path) return { output: "sequence_properties needs either `path` or `sequence`.", success: false };
  } else if (!request.path) {
    return { output: `${operation} needs a structure file in \`path\`.`, success: false };
  }

  for (const field of ["chains", "reference_chains", "mobile_chains", "chains_a", "chains_b"]) {
    const list = asArray(input[field]);
    if (list) request[field] = list;
  }
  if (typeof input.ligand === "string" && input.ligand.trim()) request.ligand = input.ligand.trim();
  if (typeof input.atoms === "string") request.atoms = input.atoms;
  if (input.include_water !== undefined) request.include_water = Boolean(input.include_water);
  if (Number.isFinite(Number(input.cutoff))) request.cutoff = Number(input.cutoff);

  const response = await runStructureAnalysis(request, { cwd: sessionWorkspace });
  if (!response.ok || !response.result) {
    return { output: `analyze_structure (${operation}) failed: ${response.error || "unknown error"}`, success: false };
  }

  const maxRows = Math.max(1, Math.min(Number(input.max_rows) || 25, 200));
  let output = formatAnalysisResult(operation, response.result, maxRows);
  if (response.installed) {
    output = `[installed biotite + Biopython into the bundled runtime on first use]\n${output}`;
  }
  if (typeof request.output_path === "string") {
    output += `\n(Path is inside the session workspace: ${path.basename(request.output_path)})`;
  }
  return { output, success: true };
}
