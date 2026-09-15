/**
 * Structure selection context: what the user selected in the Mol* viewer,
 * summarized into a compact, model-readable block (Lévin-style "bring the
 * selection into the conversation").
 */

export interface SelectedResidue {
  chain: string;
  seq: number;
  comp: string;
  insCode?: string;
}

export interface StructureSelectionContext {
  /** File name of the structure the selection belongs to. */
  file: string;
  /** Workspace path of the structure (when known). */
  path?: string;
  residues: SelectedResidue[];
  /** Compact ranges such as "A:45-52" / "B:10". */
  ranges: string[];
  /** One-letter sequence of the selected residues in selection order. */
  sequence: string;
  chains: string[];
  residueCount: number;
  atomCount?: number;
  updatedAt: number;
}

const THREE_TO_ONE: Record<string, string> = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q", GLU: "E", GLY: "G", HIS: "H", ILE: "I",
  LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P", SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V",
  SEC: "U", PYL: "O", MSE: "M", HSD: "H", HSE: "H", HSP: "H",
  DA: "A", DT: "T", DG: "G", DC: "C", A: "A", U: "U", G: "G", C: "C",
};

export function threeToOne(comp: string): string {
  return THREE_TO_ONE[(comp || "").toUpperCase()] || "X";
}

function residueKey(r: SelectedResidue): string {
  return `${r.chain}|${r.seq}|${r.insCode || ""}`;
}

/** Deduplicate residues and sort by chain, then sequence number. */
export function normalizeResidues(residues: SelectedResidue[]): SelectedResidue[] {
  const seen = new Set<string>();
  const out: SelectedResidue[] = [];
  for (const r of residues) {
    if (!r || typeof r.seq !== "number" || !Number.isFinite(r.seq)) continue;
    const key = residueKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chain: r.chain || "?", seq: r.seq, comp: (r.comp || "UNK").toUpperCase(), ...(r.insCode ? { insCode: r.insCode } : {}) });
  }
  out.sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : a.seq - b.seq));
  return out;
}

/** Collapse sorted residues into "A:45-52" style ranges. */
export function buildRanges(residues: SelectedResidue[]): string[] {
  const sorted = normalizeResidues(residues);
  const ranges: string[] = [];
  let start: SelectedResidue | null = null;
  let prev: SelectedResidue | null = null;
  const flush = () => {
    if (!start || !prev) return;
    ranges.push(start.seq === prev.seq ? `${start.chain}:${start.seq}` : `${start.chain}:${start.seq}-${prev.seq}`);
  };
  for (const r of sorted) {
    if (start && prev && r.chain === prev.chain && r.seq === prev.seq + 1) {
      prev = r;
      continue;
    }
    flush();
    start = r;
    prev = r;
  }
  flush();
  return ranges;
}

export function buildSelectionContext(
  file: string,
  residues: SelectedResidue[],
  extra: { path?: string; atomCount?: number; now?: number } = {},
): StructureSelectionContext | null {
  const normalized = normalizeResidues(residues);
  if (normalized.length === 0) return null;
  const chains = Array.from(new Set(normalized.map((r) => r.chain)));
  return {
    file,
    ...(extra.path ? { path: extra.path } : {}),
    residues: normalized,
    ranges: buildRanges(normalized),
    sequence: normalized.map((r) => threeToOne(r.comp)).join(""),
    chains,
    residueCount: normalized.length,
    ...(typeof extra.atomCount === "number" ? { atomCount: extra.atomCount } : {}),
    updatedAt: extra.now ?? Date.now(),
  };
}

/** Short label for the chip above the chat input. */
export function describeSelection(ctx: StructureSelectionContext): string {
  const rangeText = ctx.ranges.slice(0, 4).join(", ") + (ctx.ranges.length > 4 ? ", …" : "");
  const noun = ctx.residueCount === 1 ? "residue" : "residues";
  return `${ctx.file} · ${ctx.residueCount} ${noun} · ${rangeText}`;
}

const MAX_LISTED_RESIDUES = 60;

/** Model-facing block appended to the user's message. */
export function formatSelectionForModel(ctx: StructureSelectionContext): string {
  const lines: string[] = [];
  lines.push("<structure_selection>");
  lines.push(`file: ${ctx.file}${ctx.path ? ` (workspace path: ${ctx.path})` : ""}`);
  lines.push(`chains: ${ctx.chains.join(", ")}`);
  lines.push(`residues: ${ctx.residueCount}${typeof ctx.atomCount === "number" ? ` (${ctx.atomCount} atoms)` : ""}`);
  lines.push(`ranges (auth numbering): ${ctx.ranges.join(", ")}`);
  lines.push(`sequence: ${ctx.sequence}`);
  const listed = ctx.residues.slice(0, MAX_LISTED_RESIDUES).map((r) => `${r.comp}${r.seq}${r.insCode || ""}/${r.chain}`);
  lines.push(`list: ${listed.join(" ")}${ctx.residues.length > MAX_LISTED_RESIDUES ? ` … (+${ctx.residues.length - MAX_LISTED_RESIDUES} more)` : ""}`);
  lines.push("</structure_selection>");
  return lines.join("\n");
}

/** Parse a metadata payload from the client into a context (null if invalid). */
export function parseSelectionContext(value: unknown): StructureSelectionContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const file = typeof record.file === "string" ? record.file.trim() : "";
  const residues = Array.isArray(record.residues)
    ? record.residues.filter((r): r is SelectedResidue => Boolean(r) && typeof r === "object" && typeof (r as SelectedResidue).seq === "number")
    : [];
  if (!file || residues.length === 0) return null;
  return buildSelectionContext(file, residues, {
    path: typeof record.path === "string" ? record.path : undefined,
    atomCount: typeof record.atomCount === "number" ? record.atomCount : undefined,
  });
}
