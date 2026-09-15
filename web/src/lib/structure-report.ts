/**
 * Structure inventory helpers.
 *
 * Agents kept hand-rolling BioPython in one-shot `python3 << EOF` blocks just to
 * answer "which chains are in this file and how are its residues numbered?".
 * When they guessed instead, the scripts crashed on `chain[resnum]` KeyErrors or
 * silently produced empty selections (99 A "contact" distances). Design and
 * prediction backends also renumber residues, so numbering from one file is
 * never valid for the next one.
 */

const AA3_TO_1: Record<string, string> = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q", GLU: "E", GLY: "G",
  HIS: "H", ILE: "I", LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P", SER: "S",
  THR: "T", TRP: "W", TYR: "Y", VAL: "V", SEC: "U", PYL: "O", MSE: "M",
  DA: "a", DC: "c", DG: "g", DT: "t", DU: "u", A: "a", C: "c", G: "g", U: "u",
};

export interface ChainSummary {
  chain: string;
  /** Number of distinct polymer residues. */
  residues: number;
  /** First and last author residue number. */
  first: number;
  last: number;
  /** Author numbers missing between `first` and `last` (disordered loops). */
  gaps: number[];
  /** One-letter sequence in file order. */
  sequence: string;
  /** Ordered author residue numbers, in file order. */
  numbers: number[];
  /** Distinct non-water HETATM residue names. */
  ligands: string[];
}

interface RawAtom {
  chain: string;
  resSeq: number;
  icode: string;
  resName: string;
  hetero: boolean;
}

function collect(atoms: RawAtom[]): ChainSummary[] {
  const order: string[] = [];
  const byChain = new Map<string, { seen: Set<string>; numbers: number[]; seq: string[]; ligands: Set<string> }>();

  for (const atom of atoms) {
    let entry = byChain.get(atom.chain);
    if (!entry) {
      entry = { seen: new Set(), numbers: [], seq: [], ligands: new Set() };
      byChain.set(atom.chain, entry);
      order.push(atom.chain);
    }
    if (atom.hetero) {
      if (atom.resName !== "HOH" && atom.resName !== "WAT" && atom.resName !== "DOD") {
        entry.ligands.add(atom.resName);
      }
      continue;
    }
    const key = `${atom.resSeq}${atom.icode}`;
    if (entry.seen.has(key)) continue;
    entry.seen.add(key);
    entry.numbers.push(atom.resSeq);
    entry.seq.push(AA3_TO_1[atom.resName] ?? "X");
  }

  const summaries: ChainSummary[] = [];
  for (const chain of order) {
    const entry = byChain.get(chain)!;
    if (entry.numbers.length === 0 && entry.ligands.size === 0) continue;
    const numbers = entry.numbers;
    const first = numbers.length ? numbers[0] : 0;
    const last = numbers.length ? numbers[numbers.length - 1] : 0;
    const present = new Set(numbers);
    const gaps: number[] = [];
    const lo = Math.min(first, last);
    const hi = Math.max(first, last);
    for (let n = lo; n <= hi; n += 1) if (!present.has(n)) gaps.push(n);
    summaries.push({
      chain,
      residues: numbers.length,
      first,
      last,
      gaps,
      sequence: entry.seq.join(""),
      numbers,
      ligands: [...entry.ligands].sort(),
    });
  }
  return summaries;
}

/** Parse chain/residue inventory out of PDB-format text. */
export function summarizePdbChains(pdbText: string): ChainSummary[] {
  const atoms: RawAtom[] = [];
  for (const line of pdbText.split("\n")) {
    const hetero = line.startsWith("HETATM");
    if (!hetero && !line.startsWith("ATOM")) continue;
    const chain = (line[21] || " ").trim() || "_";
    const resSeq = Number.parseInt(line.slice(22, 26).trim(), 10);
    if (!Number.isFinite(resSeq)) continue;
    atoms.push({
      chain,
      resSeq,
      icode: (line[26] || " ").trim(),
      resName: line.slice(17, 20).trim().toUpperCase(),
      hetero,
    });
  }
  return collect(atoms);
}

/** Parse chain/residue inventory out of mmCIF text (`_atom_site` loop). */
export function summarizeCifChains(cifText: string): ChainSummary[] {
  const lines = cifText.split("\n");
  const columns: string[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("_atom_site.")) {
      if (columns.length === 0) columns.length = 0;
      columns.push(trimmed.slice("_atom_site.".length).split(/\s+/)[0]);
      start = i + 1;
    } else if (columns.length > 0 && start === i) {
      break;
    }
  }
  if (columns.length === 0) return [];

  const idx = (...names: string[]): number => {
    for (const name of names) {
      const at = columns.indexOf(name);
      if (at >= 0) return at;
    }
    return -1;
  };
  const iGroup = idx("group_PDB");
  const iChain = idx("auth_asym_id", "label_asym_id");
  const iSeq = idx("auth_seq_id", "label_seq_id");
  const iComp = idx("auth_comp_id", "label_comp_id");
  const iIcode = idx("pdbx_PDB_ins_code");
  if (iChain < 0 || iSeq < 0 || iComp < 0) return [];

  const atoms: RawAtom[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("loop_") || trimmed.startsWith("_")) {
      if (atoms.length > 0) break;
      continue;
    }
    const fields = trimmed.split(/\s+/);
    if (fields.length < columns.length) continue;
    const resSeq = Number.parseInt(fields[iSeq], 10);
    if (!Number.isFinite(resSeq)) continue;
    const icode = iIcode >= 0 ? fields[iIcode] : ".";
    atoms.push({
      chain: fields[iChain] || "_",
      resSeq,
      icode: icode === "." || icode === "?" ? "" : icode,
      resName: (fields[iComp] || "").toUpperCase(),
      hetero: iGroup >= 0 ? fields[iGroup] === "HETATM" : false,
    });
  }
  return collect(atoms);
}

/** Dispatch on content: mmCIF if it carries an `_atom_site` loop, else PDB. */
export function summarizeStructureChains(text: string): ChainSummary[] {
  return text.includes("_atom_site.") ? summarizeCifChains(text) : summarizePdbChains(text);
}

function describeGaps(gaps: number[]): string {
  if (gaps.length === 0) return "no gaps";
  const shown = gaps.slice(0, 12).join(", ");
  const more = gaps.length > 12 ? `, +${gaps.length - 12} more` : "";
  return `${gaps.length} gap${gaps.length === 1 ? "" : "s"}: ${shown}${more}`;
}

/** One line per chain: counts, author numbering range, gaps, ligands. */
export function formatChainSummary(chains: ChainSummary[]): string {
  if (chains.length === 0) return "No ATOM/HETATM records found.";
  return chains
    .map((c) => {
      const parts = [`chain ${c.chain}: ${c.residues} residues, numbered ${c.first}-${c.last}`, describeGaps(c.gaps)];
      if (c.ligands.length > 0) parts.push(`ligands: ${c.ligands.join(", ")}`);
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
}

export interface RfdiffusionDescribeOptions {
  /** The structure that was sent as `input_pdb`, if any. */
  inputPdb?: string;
  /** The `hotspot_residues` that were requested, e.g. ["B34", "B36"]. */
  hotspots?: string[];
}

function parseResidueToken(token: string): { chain: string; number: number } | null {
  const match = /^([A-Za-z_]?)\s*(-?\d+)$/.exec(token.trim());
  if (!match) return null;
  return { chain: match[1] || "_", number: Number.parseInt(match[2], 10) };
}

/**
 * Describe an RFdiffusion output so the caller never has to guess its numbering.
 *
 * RFdiffusion returns the designed binder as chain A numbered from 1 and
 * renumbers every target chain sequentially after it, so the offset depends on
 * the binder length and differs between designs from the same input. A real
 * session hardcoded one offset for three outputs whose target chains were
 * numbered 91-196, 72-177 and 81-186, and crashed or measured nothing.
 */
export function describeRfdiffusionOutput(
  outputPdb: string,
  options: RfdiffusionDescribeOptions = {},
): string {
  const chains = summarizeStructureChains(outputPdb);
  const lines: string[] = [];
  lines.push("Output structure (the designed binder is chain A; the other chains are the target):");
  lines.push(formatChainSummary(chains));
  lines.push(
    "IMPORTANT: RFdiffusion renumbers all residues sequentially from 1, so the target's " +
      "original author numbering is NOT preserved and the offset differs per design. " +
      "Use the numbers above (or inspect_structure) rather than the input numbering.",
  );

  const hotspots = options.hotspots ?? [];
  if (hotspots.length === 0) return lines.join("\n");

  if (!options.inputPdb) {
    lines.push(`Requested hotspots (in input numbering): ${hotspots.join(", ")}.`);
    return lines.join("\n");
  }

  const inputChains = new Map(summarizeStructureChains(options.inputPdb).map((c) => [c.chain, c]));
  const outputChains = new Map(chains.map((c) => [c.chain, c]));
  const mapped: string[] = [];
  for (const token of hotspots) {
    const parsed = parseResidueToken(token);
    if (!parsed) {
      mapped.push(`${token} -> unparseable`);
      continue;
    }
    const inputChain = inputChains.get(parsed.chain);
    const outputChain = outputChains.get(parsed.chain);
    if (!inputChain || !outputChain) {
      mapped.push(`${token} -> chain ${parsed.chain} not in the input structure`);
      continue;
    }
    const at = inputChain.numbers.indexOf(parsed.number);
    if (at < 0) {
      mapped.push(`${token} -> not in the input structure`);
      continue;
    }
    const outputNumber = outputChain.numbers[at];
    mapped.push(
      outputNumber === undefined
        ? `${token} -> missing from the output`
        : `${token} -> ${parsed.chain}${outputNumber}`,
    );
  }
  lines.push(`Hotspot mapping (input -> output): ${mapped.join(", ")}.`);
  return lines.join("\n");
}
