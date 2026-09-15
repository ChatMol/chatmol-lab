---
name: Protein Quality Control
description: Comprehensive quality metrics, filtering, and scoring for computationally designed proteins
license: MIT
category: analysis
tags:
  - quality-control
  - metrics
  - filtering
  - plddt
  - ptm
  - iptm
  - pae
  - protein-design
  - validation
---

# Protein Quality Control

This skill provides standardized quality control metrics, filtering criteria,
and composite scoring functions for evaluating computationally designed proteins.
It covers structural confidence metrics from AlphaFold2/ESMFold, binding
interface metrics, expression and solubility predictions, and composite ranking
scores for design campaigns.

## Overview

Computational protein design generates hundreds to thousands of candidate
sequences. Robust quality control filtering is essential to identify the most
promising designs for experimental validation. This skill defines standard
and stringent thresholds for all commonly used metrics, provides composite
scoring formulas, and outlines decision logic for prioritizing designs.

## Metric Categories

### 1. Structural Confidence Metrics

These metrics come from structure prediction (AlphaFold2, ESMFold, or
ColabFold) and evaluate whether the designed sequence is likely to fold into
the intended structure.

| Metric | Source | Range | Description |
|--------|--------|-------|-------------|
| pLDDT | AF2/ESMFold | 0-100 | Per-residue confidence in local structure |
| pTM | AF2 | 0-1 | Predicted TM-score of the full structure |
| PAE | AF2 | 0-31.75 | Predicted aligned error between residue pairs |
| RMSD to design | AF2 vs input | 0-inf (A) | Backbone RMSD between prediction and design |
| GDT-TS | AF2 vs input | 0-1 | Global distance test |

#### pLDDT Interpretation

| Range | Confidence | Interpretation |
|-------|------------|----------------|
| 90-100 | Very high | Well-defined structure, highly confident |
| 70-89 | High | Confident, minor uncertainty in loops |
| 50-69 | Low | Significant uncertainty, possibly disordered |
| 0-49 | Very low | Likely disordered or misfolded |

#### pTM Interpretation

| Range | Confidence | Interpretation |
|-------|------------|----------------|
| > 0.8 | Very high | Confident global fold prediction |
| 0.6-0.8 | High | Good overall fold, some domain uncertainty |
| 0.4-0.6 | Moderate | Uncertain, possibly multi-domain |
| < 0.4 | Low | Unreliable prediction |

### 2. Binding and Interface Metrics

These metrics evaluate protein-protein or protein-ligand binding for designed
complexes (binders, antibodies, etc.).

| Metric | Source | Range | Description |
|--------|--------|-------|-------------|
| ipTM | AF2 multimer | 0-1 | Interface predicted TM-score |
| PAE (interface) | AF2 multimer | 0-31.75 | Inter-chain predicted aligned error |
| pLDDT (interface) | AF2 multimer | 0-100 | Interface residue confidence |
| BSA | FreeSASA | 0-inf (A^2) | Buried surface area upon binding |
| Shape complementarity | sc | 0-1 | Geometric fit at interface |
| Hotspot contacts | analysis | 0-N | Number of designed contacts to target hotspots |
| Unsatisfied H-bonds | analysis | 0-N | Buried unsatisfied hydrogen bond donors/acceptors |
| Interface RMSD | AF2 vs design | 0-inf (A) | RMSD of interface residues only |

#### ipTM Interpretation

| Range | Confidence | Interpretation |
|-------|------------|----------------|
| > 0.85 | Very high | Strong predicted binding |
| 0.75-0.85 | High | Good predicted interaction |
| 0.60-0.75 | Moderate | Possible interaction, validate carefully |
| < 0.60 | Low | Unlikely to bind as designed |

### 3. Expression and Stability Metrics

These metrics predict whether a designed protein will express and remain
stable in experimental systems.

| Metric | Source | Range | Description |
|--------|--------|-------|-------------|
| Solubility score | SOLpro/Protein-Sol | 0-1 | Predicted solubility |
| Aggregation score | Aggrescan/TANGO | 0-1 | Aggregation propensity |
| Instability index | ProtParam | 0-inf | Sequence-based stability prediction |
| GRAVY | ProtParam | -4.5-4.5 | Grand average of hydropathy |
| Net charge | sequence | -inf-inf | Net charge at pH 7.4 |
| Predicted Tm | ThermoMPNN | 0-inf (C) | Predicted melting temperature |
| Isoelectric point | ProtParam | 0-14 | Predicted pI |

### 4. Sequence Quality Metrics

| Metric | Source | Range | Description |
|--------|--------|-------|-------------|
| MPNN score | ProteinMPNN | 0-inf | Negative log-likelihood (lower is better) |
| Sequence identity | alignment | 0-1 | Identity to native/template |
| Sequence diversity | clustering | 0-1 | Diversity within design set |
| Rare codon fraction | analysis | 0-1 | Fraction of codons rare in E. coli |
| Repeat content | analysis | 0-1 | Low complexity / repeat fraction |

## Standard Filtering Thresholds

### Monomer Design (single-chain proteins)

```python
STANDARD_MONOMER_FILTERS = {
    "plddt_mean": {"min": 80.0, "description": "Mean pLDDT of designed chain"},
    "ptm": {"min": 0.70, "description": "Predicted TM-score"},
    "rmsd_to_design": {"max": 2.0, "description": "CA RMSD to input backbone (A)"},
    "mpnn_score": {"max": 1.8, "description": "ProteinMPNN score"},
}

STRINGENT_MONOMER_FILTERS = {
    "plddt_mean": {"min": 88.0},
    "ptm": {"min": 0.80},
    "rmsd_to_design": {"max": 1.0},
    "mpnn_score": {"max": 1.2},
    "plddt_min": {"min": 60.0, "description": "Minimum per-residue pLDDT"},
}
```

### Binder Design (protein-protein complexes)

```python
STANDARD_BINDER_FILTERS = {
    "iptm": {"min": 0.80, "description": "Interface pTM score"},
    "plddt_binder": {"min": 80.0, "description": "Mean binder pLDDT"},
    "pae_interaction": {"max": 10.0, "description": "Mean interface PAE"},
    "rmsd_to_design": {"max": 2.5, "description": "Binder CA RMSD (A)"},
    "hotspot_contacts": {"min": 3, "description": "Contacts to target hotspots"},
}

STRINGENT_BINDER_FILTERS = {
    "iptm": {"min": 0.85},
    "plddt_binder": {"min": 85.0},
    "pae_interaction": {"max": 8.0},
    "rmsd_to_design": {"max": 1.5},
    "hotspot_contacts": {"min": 5},
    "bsa": {"min": 1200.0, "description": "Minimum buried surface area (A^2)"},
    "shape_complementarity": {"min": 0.60},
    "unsatisfied_hbonds": {"max": 3},
}
```

### Antibody/Nanobody Design

```python
STANDARD_ANTIBODY_FILTERS = {
    "iptm": {"min": 0.75},
    "plddt_cdr": {"min": 70.0, "description": "Mean CDR pLDDT"},
    "plddt_framework": {"min": 85.0, "description": "Mean framework pLDDT"},
    "pae_interaction": {"max": 12.0},
    "cdr3_rmsd": {"max": 3.0, "description": "CDR3 loop RMSD (A)"},
}

STRINGENT_ANTIBODY_FILTERS = {
    "iptm": {"min": 0.80},
    "plddt_cdr": {"min": 75.0},
    "plddt_framework": {"min": 90.0},
    "pae_interaction": {"max": 8.0},
    "cdr3_rmsd": {"max": 2.0},
    "humanness_score": {"min": 0.80, "description": "OASis humanness score"},
}
```

## Composite Scoring Functions

### Monomer Composite Score

```python
def monomer_composite_score(metrics):
    """Composite score for monomer designs. Range 0-1, higher is better."""
    score = (
        0.35 * min(metrics["plddt_mean"] / 100.0, 1.0)
        + 0.30 * min(metrics["ptm"], 1.0)
        + 0.20 * max(1.0 - metrics["rmsd_to_design"] / 5.0, 0.0)
        + 0.15 * max(1.0 - metrics["mpnn_score"] / 3.0, 0.0)
    )
    return round(score, 4)
```

### Binder Composite Score

```python
def binder_composite_score(metrics):
    """Composite score for binder designs. Range 0-1, higher is better."""
    score = (
        0.30 * min(metrics["iptm"], 1.0)
        + 0.20 * min(metrics["plddt_binder"] / 100.0, 1.0)
        + 0.20 * max(1.0 - metrics["pae_interaction"] / 31.0, 0.0)
        + 0.15 * max(1.0 - metrics["rmsd_to_design"] / 5.0, 0.0)
        + 0.10 * min(metrics.get("shape_complementarity", 0.5), 1.0)
        + 0.05 * min(metrics.get("hotspot_contacts", 0) / 10.0, 1.0)
    )
    return round(score, 4)
```

### Antibody Composite Score

```python
def antibody_composite_score(metrics):
    """Composite score for antibody/nanobody designs. Range 0-1, higher is better."""
    score = (
        0.25 * min(metrics["iptm"], 1.0)
        + 0.20 * min(metrics["plddt_cdr"] / 100.0, 1.0)
        + 0.15 * min(metrics["plddt_framework"] / 100.0, 1.0)
        + 0.20 * max(1.0 - metrics["pae_interaction"] / 31.0, 0.0)
        + 0.10 * max(1.0 - metrics["cdr3_rmsd"] / 5.0, 0.0)
        + 0.10 * min(metrics.get("humanness_score", 0.5), 1.0)
    )
    return round(score, 4)
```

## Usage Examples

### Apply standard binder filters

```python
import pandas as pd

def apply_binder_filters(designs_df, stringent=False):
    """Filter binder designs by quality thresholds."""
    filters = STRINGENT_BINDER_FILTERS if stringent else STANDARD_BINDER_FILTERS
    mask = pd.Series(True, index=designs_df.index)
    for metric, criteria in filters.items():
        if metric not in designs_df.columns:
            continue
        if "min" in criteria:
            mask &= designs_df[metric] >= criteria["min"]
        if "max" in criteria:
            mask &= designs_df[metric] <= criteria["max"]
    return designs_df[mask].copy()

# Load design metrics
df = pd.read_csv("bindcraft_results/summary.csv")
print(f"Total designs: {len(df)}")

# Apply standard filters
filtered = apply_binder_filters(df, stringent=False)
print(f"After standard filtering: {len(filtered)}")

# Apply stringent filters
stringent = apply_binder_filters(df, stringent=True)
print(f"After stringent filtering: {len(stringent)}")
```

### Rank designs by composite score

```python
def rank_designs(designs_df, score_fn, top_n=20):
    """Rank designs by composite score and return top N."""
    designs_df = designs_df.copy()
    designs_df["composite_score"] = designs_df.apply(
        lambda row: score_fn(row.to_dict()), axis=1
    )
    ranked = designs_df.sort_values("composite_score", ascending=False)
    return ranked.head(top_n)

top_binders = rank_designs(filtered, binder_composite_score, top_n=10)
print(top_binders[["design_id", "iptm", "plddt_binder", "pae_interaction", "composite_score"]])
```

### Multi-stage filtering pipeline

```python
def full_qc_pipeline(designs_df, design_type="binder"):
    """Full QC pipeline: filter, score, cluster, select."""
    # Stage 1: Hard filters
    if design_type == "binder":
        passed = apply_binder_filters(designs_df, stringent=False)
        score_fn = binder_composite_score
    elif design_type == "monomer":
        passed = apply_monomer_filters(designs_df, stringent=False)
        score_fn = monomer_composite_score
    elif design_type == "antibody":
        passed = apply_antibody_filters(designs_df, stringent=False)
        score_fn = antibody_composite_score

    # Stage 2: Composite scoring
    passed["composite_score"] = passed.apply(
        lambda row: score_fn(row.to_dict()), axis=1
    )

    # Stage 3: Cluster by sequence identity (70%) to ensure diversity
    # (requires external clustering step via MMseqs2)
    clusters = cluster_by_sequence(passed, identity=0.7)

    # Stage 4: Pick best from each cluster
    representatives = []
    for cluster_id, members in clusters.items():
        best = members.sort_values("composite_score", ascending=False).iloc[0]
        representatives.append(best)

    result = pd.DataFrame(representatives)
    return result.sort_values("composite_score", ascending=False)
```

### Generate QC report

```python
def generate_qc_report(designs_df, output_path="qc_report.txt"):
    """Generate a summary QC report for a design campaign."""
    report = []
    report.append(f"=== Protein Design QC Report ===")
    report.append(f"Total designs: {len(designs_df)}")
    report.append("")
    report.append("Metric distributions:")
    for col in ["plddt_mean", "ptm", "iptm", "pae_interaction", "rmsd_to_design"]:
        if col in designs_df.columns:
            vals = designs_df[col]
            report.append(f"  {col}: mean={vals.mean():.2f}, "
                         f"median={vals.median():.2f}, "
                         f"min={vals.min():.2f}, max={vals.max():.2f}")
    report.append("")
    report.append("Pass rates:")
    for name, filters in [("Standard", STANDARD_BINDER_FILTERS),
                           ("Stringent", STRINGENT_BINDER_FILTERS)]:
        n_pass = len(apply_binder_filters(designs_df,
                      stringent=(name == "Stringent")))
        report.append(f"  {name}: {n_pass}/{len(designs_df)} "
                     f"({100*n_pass/len(designs_df):.1f}%)")

    text = "\n".join(report)
    with open(output_path, "w") as f:
        f.write(text)
    return text
```

## Red Flags and Common Issues

| Issue | Symptom | Likely Cause | Solution |
|-------|---------|--------------|----------|
| Low pLDDT everywhere | pLDDT < 50 | Sequence does not fold | Redesign with lower temperature |
| High RMSD | > 3 A RMSD | Wrong fold predicted | Check backbone quality, redesign |
| Low ipTM, high pLDDT | pLDDT > 80, ipTM < 0.5 | Binder folds but does not bind | Change hotspots, redesign interface |
| PAE hot spots | Localized high PAE | Flexible loop or domain | Fix loop residues or truncate |
| Low pLDDT termini | Terminal pLDDT < 40 | Disordered termini | Trim disordered regions |

## Best Practices

1. Always apply at least standard filters before experimental testing
2. Use composite scores for ranking, not individual metrics alone
3. Cluster designs by sequence (70% identity) and pick representatives
4. Verify top designs with independent AF2 runs (different seeds, more recycles)
5. Check for known problematic sequence features (aggregation, low complexity)
6. Report all metrics transparently; do not cherry-pick favorable metrics
7. For binders, verify ipTM is driven by interface contacts, not spurious alignments
8. Set aside 10-20% of designs as negative controls for experimental validation

## References

- Jumper et al. "Highly accurate protein structure prediction with AlphaFold." Nature (2021).
- Evans et al. "Protein complex prediction with AlphaFold-Multimer." bioRxiv (2022).
- Lin et al. "Evolutionary-scale prediction of atomic-level protein structure with a language model." Science (2023).
