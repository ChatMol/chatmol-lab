#!/usr/bin/env python3
"""ChatMol Lab structure analysis backend.

Runs inside the bundled scientific runtime and is driven by the
`analyze_structure` tool: one JSON request on stdin, one JSON response on
stdout. The science comes from established libraries rather than hand-written
numerics — biotite for structure geometry (secondary structure, superposition,
contacts, solvent accessibility) and Biopython for sequence properties — so the
agent never has to write throwaway BioPython scripts for routine questions.

Usage:
    echo '{"operation": "secondary_structure", "path": "model.pdb"}' \
        | python structure_analysis.py
"""
from __future__ import annotations

import json
import os
import sys
import traceback
import warnings

# biotite warns about guessed elements on minimal PDB files; the request/response
# contract keeps stderr for real failures.
warnings.simplefilter("ignore")

MISSING_DEPENDENCY_EXIT = 3


def _fail(message: str, *, code: str = "error", **extra) -> None:
    json.dump({"ok": False, "code": code, "error": message, **extra}, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()


try:
    import numpy as np
    import biotite
    import biotite.structure as struc
    import biotite.structure.io as strucio
    from biotite.sequence import ProteinSequence
except ImportError as exc:  # pragma: no cover - exercised by the install flow
    _fail(str(exc), code="missing_dependency", module=getattr(exc, "name", None))
    sys.exit(MISSING_DEPENDENCY_EXIT)


# --- loading ---------------------------------------------------------------

def load(path: str) -> "struc.AtomArray":
    if not os.path.isfile(path):
        raise FileNotFoundError(f"File not found: {path}")
    array = strucio.load_structure(path, model=1, extra_fields=["b_factor", "occupancy"])
    if array.array_length() == 0:
        raise ValueError(f"No atoms in {os.path.basename(path)}")
    return array


def polymer(array: "struc.AtomArray") -> "struc.AtomArray":
    return array[struc.filter_amino_acids(array)]


def chain_filter(array: "struc.AtomArray", chains) -> "struc.AtomArray":
    if not chains:
        return array
    wanted = [c for c in chains if c]
    if not wanted:
        return array
    mask = np.isin(array.chain_id, wanted)
    return array[mask]


def residue_table(array: "struc.AtomArray"):
    """Per-residue chain / number / insertion code / name, in file order."""
    starts = struc.get_residue_starts(array)
    icodes = array.ins_code[starts] if "ins_code" in array.get_annotation_categories() else [""] * len(starts)
    return [
        {
            "chain": str(array.chain_id[i]),
            "res_seq": int(array.res_id[i]),
            "icode": str(icodes[n]).strip(),
            "res_name": str(array.res_name[i]),
            "code": one_letter(str(array.res_name[i])),
        }
        for n, i in enumerate(starts)
    ]


def one_letter(res_name: str) -> str:
    try:
        return ProteinSequence.convert_letter_3to1(res_name)
    except Exception:
        return "X"


# --- secondary structure ---------------------------------------------------

SSE_THREE_STATE = {"a": "H", "b": "E", "c": "-"}

SS_NAMES = {
    "H": "alpha helix", "G": "3-10 helix", "I": "pi helix", "P": "polyproline II helix",
    "E": "beta strand", "B": "isolated beta bridge", "T": "turn", "S": "bend", "-": "coil",
}


def dssp_codes(array: "struc.AtomArray"):
    """Full 8-state DSSP codes when the mkdssp binary is installed."""
    try:
        from biotite.application.dssp import DsspApp
    except ImportError:
        return None
    try:
        codes = DsspApp.annotate_sse(array)
    except Exception:
        return None
    return ["-" if str(c) in ("", "C") else str(c) for c in codes]


def secondary_structure(request: dict) -> dict:
    array = polymer(chain_filter(load(request["path"]), request.get("chains")))
    if array.array_length() == 0:
        raise ValueError("No amino-acid residues in the requested chains.")

    residues = residue_table(array)
    codes = None
    method = ""
    if request.get("method", "auto") != "p-sea":
        codes = dssp_codes(array)
        if codes is not None:
            method = "DSSP (mkdssp, 8-state)"
    if codes is None:
        raw = struc.annotate_sse(array)
        codes = [SSE_THREE_STATE.get(str(c), "-") for c in raw]
        method = "P-SEA (biotite, 3-state: helix / strand / coil)"

    count = min(len(codes), len(residues))
    for index in range(count):
        residues[index]["ss"] = codes[index]
    for residue in residues[count:]:
        residue["ss"] = "-"

    chains = []
    for chain in dict.fromkeys(r["chain"] for r in residues):
        items = [r for r in residues if r["chain"] == chain]
        counts = {}
        for item in items:
            counts[item["ss"]] = counts.get(item["ss"], 0) + 1
        total = len(items) or 1
        helix = sum(counts.get(c, 0) for c in "HGIP")
        sheet = sum(counts.get(c, 0) for c in "EB")
        turn = sum(counts.get(c, 0) for c in "TS")
        chains.append({
            "chain": chain,
            "residues": len(items),
            "sequence": "".join(r["code"] for r in items),
            "string": "".join(r["ss"] for r in items),
            "first": items[0]["res_seq"],
            "last": items[-1]["res_seq"],
            "counts": counts,
            "fractions": {
                "helix": round(100 * helix / total, 1),
                "sheet": round(100 * sheet / total, 1),
                "turn": round(100 * turn / total, 1),
                "coil": round(100 * counts.get("-", 0) / total, 1),
            },
            "segments": segments_of(items),
        })

    return {"method": method, "chains": chains, "residues": residues, "names": SS_NAMES}


def segments_of(items):
    out = []
    index = 0
    while index < len(items):
        code = items[index]["ss"]
        end = index
        while end + 1 < len(items) and items[end + 1]["ss"] == code:
            end += 1
        if code not in ("-", "S"):
            out.append({
                "ss": code,
                "start": items[index]["res_seq"],
                "end": items[end]["res_seq"],
                "length": end - index + 1,
            })
        index = end + 1
    return out


# --- superposition ---------------------------------------------------------

def _chain_ca(array, chains):
    """CA atoms per chain, with the indices they came from."""
    out = []
    for chain in dict.fromkeys(str(c) for c in array.chain_id):
        if chains and chain not in chains:
            continue
        mask = (array.chain_id == chain) & (array.atom_name == "CA")
        indices = np.where(mask)[0]
        if indices.size >= 3:
            out.append((chain, array[indices], indices))
    return out


def _pair_chains(reference, mobile, explicit_reference, explicit_mobile):
    """Match reference chains to mobile chains by sequence-anchored fit quality.

    biotite's superimpose_homologs pairs chains positionally and fails outright
    when the two structures have different chain counts, which is the normal
    case when a designed binder is compared with its native complex. Scoring
    every chain pair and taking the best assignment keeps that case working.
    """
    reference_chains = _chain_ca(reference, explicit_reference)
    mobile_chains = _chain_ca(mobile, explicit_mobile)
    if not reference_chains or not mobile_chains:
        raise ValueError("No chain with at least 3 CA atoms in the requested selection.")

    if explicit_reference and explicit_mobile and len(explicit_reference) == len(explicit_mobile):
        requested = list(zip(explicit_reference, explicit_mobile))
    else:
        requested = None

    scored = []
    for reference_chain, reference_ca, reference_indices in reference_chains:
        for mobile_chain, mobile_ca, mobile_indices in mobile_chains:
            if requested and (reference_chain, mobile_chain) not in requested:
                continue
            try:
                fitted, _transform, anchor_reference, anchor_mobile = struc.superimpose_homologs(reference_ca, mobile_ca)
            except Exception:
                continue
            if len(anchor_reference) < 3:
                continue
            rmsd = float(struc.rmsd(reference_ca[anchor_reference], fitted[anchor_mobile]))
            identical = int(np.sum(reference_ca.res_name[anchor_reference] == mobile_ca.res_name[anchor_mobile]))
            scored.append({
                "reference_chain": reference_chain,
                "mobile_chain": mobile_chain,
                "anchors": len(anchor_reference),
                "rmsd": rmsd,
                "identity": round(100 * identical / len(anchor_reference), 1),
                "reference_atoms": reference_indices[anchor_reference],
                "mobile_atoms": mobile_indices[anchor_mobile],
            })

    if not scored:
        raise ValueError(
            "No chain pair could be aligned. Check that both files contain the same protein, "
            "or name the chains explicitly with reference_chains / mobile_chains."
        )

    # Greedy assignment: best pair first, each chain used once.
    scored.sort(key=lambda entry: (entry["rmsd"], -entry["anchors"]))
    used_reference, used_mobile, chosen = set(), set(), []
    for entry in scored:
        if entry["reference_chain"] in used_reference or entry["mobile_chain"] in used_mobile:
            continue
        used_reference.add(entry["reference_chain"])
        used_mobile.add(entry["mobile_chain"])
        chosen.append(entry)
    return chosen


BACKBONE_ATOMS = ("N", "CA", "C", "O")


def _expand_to_backbone(array, ca_indices):
    """Backbone atom indices for the residues the CA anchors belong to."""
    keys = [(str(array.chain_id[i]), int(array.res_id[i])) for i in ca_indices]
    per_residue = []
    for chain, res_id in keys:
        mask = (array.chain_id == chain) & (array.res_id == res_id) & np.isin(array.atom_name, BACKBONE_ATOMS)
        indices = {str(array.atom_name[i]): int(i) for i in np.where(mask)[0]}
        per_residue.append(indices)
    return per_residue


def superpose(request: dict) -> dict:
    reference_all = load(request["reference"])
    mobile_all = load(request["mobile"])
    reference = polymer(reference_all)
    mobile = polymer(mobile_all)
    if reference.array_length() == 0 or mobile.array_length() == 0:
        raise ValueError("One of the structures has no amino-acid residues.")

    pairs = _pair_chains(reference, mobile, request.get("reference_chains"), request.get("mobile_chains"))
    reference_indices = np.concatenate([pair["reference_atoms"] for pair in pairs])
    mobile_indices = np.concatenate([pair["mobile_atoms"] for pair in pairs])

    selection = request.get("atoms", "CA")
    if selection == "backbone":
        reference_backbone = _expand_to_backbone(reference, reference_indices)
        mobile_backbone = _expand_to_backbone(mobile, mobile_indices)
        reference_fit, mobile_fit = [], []
        for left, right in zip(reference_backbone, mobile_backbone):
            for name in BACKBONE_ATOMS:
                if name in left and name in right:
                    reference_fit.append(left[name])
                    mobile_fit.append(right[name])
        reference_atoms = reference[np.array(reference_fit, dtype=int)]
        mobile_atoms = mobile[np.array(mobile_fit, dtype=int)]
    else:
        selection = "CA"
        reference_atoms = reference[reference_indices]
        mobile_atoms = mobile[mobile_indices]

    fitted, transform = struc.superimpose(reference_atoms, mobile_atoms)
    rmsd = float(struc.rmsd(reference_atoms, fitted))

    reference_ca = reference[reference_indices]
    mobile_ca_fitted = transform.apply(mobile[mobile_indices])
    deviations = [
        {
            "chain": str(reference_ca.chain_id[i]),
            "res_seq": int(reference_ca.res_id[i]),
            "res_name": str(reference_ca.res_name[i]),
            "mobile_chain": str(mobile_ca_fitted.chain_id[i]),
            "mobile_res_seq": int(mobile_ca_fitted.res_id[i]),
            "deviation": round(float(np.linalg.norm(reference_ca.coord[i] - mobile_ca_fitted.coord[i])), 2),
        }
        for i in range(reference_ca.array_length())
    ]
    identical = int(np.sum(reference_ca.res_name == mobile_ca_fitted.res_name))

    written = None
    output_path = request.get("output_path")
    if output_path:
        strucio.save_structure(output_path, transform.apply(mobile_all))
        written = output_path

    return {
        "rmsd": round(rmsd, 3),
        "atoms": int(reference_atoms.array_length()),
        "residues": int(reference_ca.array_length()),
        "identity": round(100 * identical / max(1, reference_ca.array_length()), 1),
        "method": "sequence-anchored superposition (biotite superimpose_homologs per chain pair)",
        "atom_selection": selection,
        "chain_pairs": [
            {
                "reference_chain": pair["reference_chain"],
                "mobile_chain": pair["mobile_chain"],
                "residues": pair["anchors"],
                "rmsd": round(pair["rmsd"], 3),
                "identity": pair["identity"],
            }
            for pair in pairs
        ],
        "deviations": deviations,
        "output_path": written,
    }


# --- contacts / interface --------------------------------------------------

def solvent_free(array: "struc.AtomArray") -> "struc.AtomArray":
    """Drop waters and ions.

    Crystal waters sit in every interface at 2.8 A, so leaving them in made
    half of a reported antibody-antigen interface HOH-HOH contacts and the
    residue lists unusable. Buried surface area is conventionally computed
    without solvent too.
    """
    try:
        mask = ~struc.filter_solvent(array)
    except Exception:
        mask = ~np.isin(array.res_name, ["HOH", "WAT", "DOD", "H2O", "SOL"])
    try:
        mask &= ~struc.filter_monoatomic_ions(array)
    except Exception:
        pass
    return array[mask]


def interface(request: dict) -> dict:
    array = load(request["path"])
    cutoff = float(request.get("cutoff", 4.5))
    heavy = array[array.element != "H"]
    include_water = bool(request.get("include_water", False))
    waters_removed = 0
    if not include_water:
        before = heavy.array_length()
        heavy = solvent_free(heavy)
        waters_removed = before - heavy.array_length()

    group_a = chain_filter(heavy, request.get("chains_a"))
    ligand = request.get("ligand")
    if ligand:
        group_b = heavy[heavy.res_name == str(ligand).upper()]
        label_b = f"ligand {ligand}"
    else:
        group_b = chain_filter(heavy, request.get("chains_b"))
        label_b = ",".join(request.get("chains_b") or []) or "rest"
    if request.get("chains_a") and not ligand and not request.get("chains_b"):
        group_b = heavy[~np.isin(heavy.chain_id, request["chains_a"])]
    label_a = ",".join(request.get("chains_a") or []) or "all"

    if group_a.array_length() == 0 or group_b.array_length() == 0:
        raise ValueError(f"Empty selection: side A has {group_a.array_length()} atoms, side B has {group_b.array_length()}.")

    cell_list = struc.CellList(group_b, cell_size=cutoff)
    neighbours = cell_list.get_atoms(group_a.coord, radius=cutoff)

    pairs = {}
    for index_a in range(group_a.array_length()):
        for index_b in neighbours[index_a]:
            if index_b == -1:
                continue
            distance = float(np.linalg.norm(group_a.coord[index_a] - group_b.coord[index_b]))
            if distance > cutoff:
                continue
            key = (
                str(group_a.chain_id[index_a]), int(group_a.res_id[index_a]), str(group_a.res_name[index_a]),
                str(group_b.chain_id[index_b]), int(group_b.res_id[index_b]), str(group_b.res_name[index_b]),
            )
            entry = pairs.get(key)
            if entry is None:
                pairs[key] = {"min_distance": distance, "atom_contacts": 1}
            else:
                entry["atom_contacts"] += 1
                entry["min_distance"] = min(entry["min_distance"], distance)

    contacts = [
        {
            "chain_a": key[0], "res_seq_a": key[1], "res_name_a": key[2],
            "chain_b": key[3], "res_seq_b": key[4], "res_name_b": key[5],
            "min_distance": round(value["min_distance"], 2),
            "atom_contacts": value["atom_contacts"],
        }
        for key, value in pairs.items()
    ]
    contacts.sort(key=lambda c: c["min_distance"])

    # Heavy atoms closer than this overlap; designed or docked complexes that
    # were never relaxed show up here immediately.
    clash_cutoff = float(request.get("clash_cutoff", 2.2))
    clashes = [c for c in contacts if c["min_distance"] < clash_cutoff]

    buried = None
    if request.get("buried_area", True) and not ligand:
        try:
            both = heavy[np.isin(heavy.chain_id, np.concatenate([np.unique(group_a.chain_id), np.unique(group_b.chain_id)]))]
            total_complex = float(np.nansum(struc.sasa(both, point_number=100)))
            total_a = float(np.nansum(struc.sasa(group_a, point_number=100)))
            total_b = float(np.nansum(struc.sasa(group_b, point_number=100)))
            buried = round(total_a + total_b - total_complex, 1)
        except Exception:
            buried = None

    residues_a = sorted({(c["chain_a"], c["res_seq_a"], c["res_name_a"]) for c in contacts}, key=lambda r: (r[0], r[1]))
    residues_b = sorted({(c["chain_b"], c["res_seq_b"], c["res_name_b"]) for c in contacts}, key=lambda r: (r[0], r[1]))

    return {
        "label_a": label_a,
        "label_b": label_b,
        "cutoff": cutoff,
        "contacts": contacts,
        "residues_a": [{"chain": r[0], "res_seq": r[1], "res_name": r[2]} for r in residues_a],
        "residues_b": [{"chain": r[0], "res_seq": r[1], "res_name": r[2]} for r in residues_b],
        "buried_area": buried,
        "clash_cutoff": clash_cutoff,
        "clashes": clashes[:25],
        "clash_count": len(clashes),
        "solvent_excluded": not include_water,
        "solvent_atoms_removed": waters_removed,
    }


# --- solvent accessibility -------------------------------------------------

# Tien et al. (2013) theoretical maximum accessible surface area, A^2.
MAX_ASA = {
    "ALA": 129, "ARG": 274, "ASN": 195, "ASP": 193, "CYS": 167, "GLN": 225, "GLU": 223,
    "GLY": 104, "HIS": 224, "ILE": 197, "LEU": 201, "LYS": 236, "MET": 224, "PHE": 240,
    "PRO": 159, "SER": 155, "THR": 172, "TRP": 285, "TYR": 263, "VAL": 174,
}


def sasa(request: dict) -> dict:
    array = chain_filter(load(request["path"]), request.get("chains"))
    heavy = array[array.element != "H"]
    if not bool(request.get("include_water", False)):
        heavy = solvent_free(heavy)
    per_atom = struc.sasa(heavy, point_number=int(request.get("point_number", 100)))
    per_residue = struc.apply_residue_wise(heavy, per_atom, np.nansum)
    residues = residue_table(heavy)

    out = []
    for index, residue in enumerate(residues[: len(per_residue)]):
        area = float(per_residue[index])
        maximum = MAX_ASA.get(residue["res_name"])
        relative = round(100 * area / maximum, 1) if maximum else None
        out.append({
            **residue,
            "sasa": round(area, 1),
            "relative": relative,
            "exposure": None if relative is None else ("exposed" if relative >= 25 else "buried"),
        })

    by_chain = {}
    for item in out:
        by_chain.setdefault(item["chain"], []).append(item)
    chains = [
        {
            "chain": chain,
            "residues": len(items),
            "total_sasa": round(sum(i["sasa"] for i in items), 1),
            "exposed": sum(1 for i in items if i["exposure"] == "exposed"),
            "buried": sum(1 for i in items if i["exposure"] == "buried"),
        }
        for chain, items in by_chain.items()
    ]
    return {"chains": chains, "residues": out, "total_sasa": round(sum(i["sasa"] for i in out), 1)}


# --- model confidence ------------------------------------------------------

def confidence(request: dict) -> dict:
    array = chain_filter(load(request["path"]), request.get("chains"))
    protein = polymer(array)
    ca = protein[protein.atom_name == "CA"]
    if ca.array_length() == 0:
        raise ValueError("No CA atoms found; the file has no protein model to score.")

    values = ca.b_factor.astype(float)
    looks_plddt = bool(values.min() >= 0 and values.max() <= 100 and values.mean() > 20)
    bands = {
        "very_high (>90)": int(np.sum(values > 90)),
        "confident (70-90)": int(np.sum((values > 70) & (values <= 90))),
        "low (50-70)": int(np.sum((values > 50) & (values <= 70))),
        "very_low (<=50)": int(np.sum(values <= 50)),
    }
    chains = []
    for chain in dict.fromkeys(str(c) for c in ca.chain_id):
        mask = ca.chain_id == chain
        subset = values[mask]
        chains.append({
            "chain": chain,
            "residues": int(subset.size),
            "mean": round(float(subset.mean()), 2),
            "min": round(float(subset.min()), 2),
            "max": round(float(subset.max()), 2),
        })

    weak = [
        {"chain": str(ca.chain_id[i]), "res_seq": int(ca.res_id[i]), "res_name": str(ca.res_name[i]), "value": round(float(values[i]), 2)}
        for i in np.argsort(values)[: int(request.get("worst", 15))]
    ] if looks_plddt else []

    return {
        "interpreted_as": "pLDDT" if looks_plddt else "B-factor",
        "mean": round(float(values.mean()), 2),
        "min": round(float(values.min()), 2),
        "max": round(float(values.max()), 2),
        "residues": int(values.size),
        "bands": bands if looks_plddt else None,
        "chains": chains,
        "weakest": weak,
    }


# --- sequence properties (Biopython) --------------------------------------

def sequence_properties(request: dict) -> dict:
    from Bio.SeqUtils.ProtParam import ProteinAnalysis

    sequence = request.get("sequence")
    source = "given sequence"
    if not sequence:
        array = polymer(chain_filter(load(request["path"]), request.get("chains")))
        starts = struc.get_residue_starts(array)
        sequence = "".join(one_letter(str(array.res_name[i])) for i in starts)
        source = os.path.basename(request["path"])
    clean = "".join(c for c in sequence.upper() if c.isalpha() and c != "X")
    if len(clean) < 3:
        raise ValueError("Sequence too short after removing non-standard residues.")

    analysis = ProteinAnalysis(clean)
    reduced, disulfide = analysis.molar_extinction_coefficient()
    # Computed from counts: the units of ProteinAnalysis.amino_acids_percent
    # have changed between Biopython releases.
    counts = analysis.count_amino_acids()
    return {
        "source": source,
        "length": len(clean),
        "sequence": clean,
        "molecular_weight": round(analysis.molecular_weight(), 1),
        "isoelectric_point": round(analysis.isoelectric_point(), 2),
        "gravy": round(analysis.gravy(), 3),
        "charge_at_pH7": round(analysis.charge_at_pH(7.0), 2),
        "instability_index": round(analysis.instability_index(), 2),
        "aromaticity": round(analysis.aromaticity(), 3),
        "extinction_coefficient": {"reduced": int(reduced), "disulfide_bonds": int(disulfide)},
        "secondary_structure_fraction": [round(v, 3) for v in analysis.secondary_structure_fraction()],
        "composition_percent": {
            k: round(100 * v / len(clean), 1)
            for k, v in sorted(counts.items(), key=lambda kv: -kv[1]) if v > 0
        },
        "charged": {
            "negative": sum(clean.count(aa) for aa in "DE"),
            "positive": sum(clean.count(aa) for aa in "KR"),
            "cysteines": clean.count("C"),
        },
    }


OPERATIONS = {
    "secondary_structure": secondary_structure,
    "superpose": superpose,
    "interface": interface,
    "sasa": sasa,
    "confidence": confidence,
    "sequence_properties": sequence_properties,
}


def main() -> int:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        _fail(f"Invalid request JSON: {exc}")
        return 1

    if request.get("operation") == "__version__":
        json.dump({
            "ok": True,
            "result": {
                "biotite": biotite.__version__,
                "python": sys.version.split()[0],
                "dssp": dssp_codes.__doc__ is not None,
            },
        }, sys.stdout)
        sys.stdout.write("\n")
        return 0

    handler = OPERATIONS.get(request.get("operation", ""))
    if handler is None:
        _fail(f"Unknown operation: {request.get('operation')!r}. Known: {', '.join(sorted(OPERATIONS))}")
        return 1

    try:
        result = handler(request)
    except FileNotFoundError as exc:
        _fail(str(exc), code="not_found")
        return 1
    except Exception as exc:  # surfaced to the model as a tool error
        _fail(f"{type(exc).__name__}: {exc}", code="failed", traceback=traceback.format_exc()[-1500:])
        return 1

    json.dump({"ok": True, "result": result}, sys.stdout, allow_nan=False, default=str)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
