---
name: Structure Analysis
description: Analyze protein structures — secondary structure, RMSD and superposition, interface contacts and buried area, solvent accessibility, model confidence, sequence properties. Use when a question is about the geometry or quality of a PDB/mmCIF file rather than about running a prediction.
license: MIT
category: structural-biology
tags: [structure, dssp, rmsd, interface, sasa, plddt, biotite, biopython]
user-invocable: true
---

# Structure Analysis

Every analysis below runs through the `analyze_structure` tool, which drives
biotite and Biopython inside the bundled runtime. Do not write BioPython or
`mkdssp` scripts in bash for these questions: the tool is faster, needs no
setup, and returns the same numbers every time.

## Choosing the operation

| Question | Operation |
|---|---|
| What is the fold / how much helix and sheet? | `secondary_structure` |
| How close is this model to the reference? | `superpose` |
| Does the binder actually touch the target, and how well? | `interface` |
| Which residues are exposed for mutagenesis or conjugation? | `sasa` |
| Do I trust this predicted model? | `confidence` |
| What is the MW, pI or extinction coefficient? | `sequence_properties` |

## Before you start

Call `inspect_structure` first whenever residue numbers matter. It is instant
and tells you the real chain IDs and author numbering; design and prediction
backends renumber residues, so numbering from one file is rarely valid in
another.

## Workflows

### Describe a structure

```
inspect_structure(path)                        → chains, numbering, sequence
analyze_structure(operation="secondary_structure", path=...)
```

Report composition as percentages and name the segments by their residue
ranges. The method line says whether the assignment is full 8-state DSSP or
3-state P-SEA; quote the codes you actually used.

### Judge a designed binder or a docking pose

```
analyze_structure(operation="interface", path=complex, chains_a=["A"], chains_b=["B"])
```

Read three things in order:

1. **Clash warning.** Heavy atoms closer than 2.2 A mean the complex was never
   relaxed. Say so before discussing affinity — contact counts from a clashing
   pose are not evidence of binding.
2. **Buried surface area.** Roughly: below 400 A^2 is a weak or incidental
   contact, 600-1000 A^2 is a normal protein-protein interface, above 1500 A^2
   is large. Interpret, do not just print the number.
3. **Interface residues.** These are the positions worth mutating, and the
   hotspots to keep fixed in a redesign.

For a ligand, pass `ligand="ATP"` instead of `chains_b`.

### Compare a model with a reference

```
analyze_structure(operation="superpose", reference=native, mobile=model,
                  output_path="model_superposed.pdb")
```

Chains are paired by sequence, so a renumbered design still aligns; the result
lists which chain matched which. When a complex is compared with a complex,
the per-chain RMSD table matters more than the combined value — a rigid target
with a mobile binder gives a large combined RMSD that says nothing about the
target. Save the superposed copy with `save_artifact` so the user can see both
in the viewer.

### Check a predicted model

```
analyze_structure(operation="confidence", path=model)
```

The tool reports whether the B-factor column holds pLDDT or crystallographic
B-factors. For pLDDT: above 90 is very high, 70-90 confident, 50-70 low, below
50 is disordered or wrong. Name the weak regions by residue range and say what
they mean for the next step — low-confidence loops are not evidence of a
flexible loop unless the rest of the model is strong.

### Surface and sequence properties

```
analyze_structure(operation="sasa", path=..., chains=["A"])
analyze_structure(operation="sequence_properties", path=...)     # or sequence="..."
```

Relative accessibility at or above 25% counts as exposed. `sequence_properties`
gives molecular weight, pI, net charge, the 280 nm extinction coefficient,
GRAVY and the instability index — the numbers needed to order a construct or
plan an expression experiment.

## Reporting

Give the interpretation, not a table dump. A good answer names the fold, the
numbers that matter with their units, and what the user should do next. Save
any structure you generated with `save_artifact` so it opens in the viewer.
