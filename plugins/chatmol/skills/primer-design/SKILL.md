---
name: primer-design
description: Design PCR primers for standard PCR, qPCR, Gibson assembly, and Golden Gate cloning with thermodynamic validation and specificity checks.
license: MIT
category: molecular-biology
tags:
  - pcr
  - primers
  - qpcr
  - gibson-assembly
  - golden-gate
  - primer3
  - cloning
---

# Primer Design

Design and validate oligonucleotide primers for PCR amplification, quantitative PCR, Gibson assembly, and Golden Gate cloning workflows.

## When to Use

- Designing forward and reverse primers for standard PCR amplification
- Creating qPCR primer/probe sets with strict Tm and amplicon size constraints
- Generating Gibson assembly primers with overlap regions for seamless cloning
- Designing Golden Gate cloning primers with BsaI/BpiI recognition sites and custom overhangs
- Validating existing primers for Tm, GC content, hairpins, and dimers
- Checking primer specificity against a reference genome or transcriptome

## How to Run

This skill uses `primer3-py` for thermodynamic calculations and primer design, and optionally queries the NEB Tm Calculator API for experimental Tm validation.

### Prerequisites

Refer to [shared compute setup](../_shared/SKILL.md) for base environment configuration.

```bash
pip install primer3-py biopython requests
```

## Key Parameters

| Parameter | Description | Standard PCR | qPCR | Gibson | Golden Gate |
|-----------|-------------|-------------|------|--------|-------------|
| `PRIMER_OPT_TM` | Optimal melting temperature (C) | 60.0 | 60.0 | 62.0 | 60.0 |
| `PRIMER_MIN_TM` | Minimum Tm (C) | 57.0 | 58.0 | 59.0 | 57.0 |
| `PRIMER_MAX_TM` | Maximum Tm (C) | 63.0 | 62.0 | 65.0 | 63.0 |
| `PRIMER_MAX_DIFF_TM` | Max Tm difference between F/R | 3.0 | 1.5 | 3.0 | 2.0 |
| `PRIMER_OPT_GC_PERCENT` | Optimal GC content (%) | 50.0 | 50.0 | 50.0 | 50.0 |
| `PRIMER_MIN_GC` | Minimum GC (%) | 40.0 | 40.0 | 40.0 | 40.0 |
| `PRIMER_MAX_GC` | Maximum GC (%) | 60.0 | 60.0 | 60.0 | 60.0 |
| `PRIMER_PRODUCT_SIZE_RANGE` | Amplicon size range (bp) | 200-1000 | 70-200 | 150-500 | 100-2000 |
| `PRIMER_OPT_SIZE` | Optimal primer length (nt) | 20 | 20 | 20 | 20 |
| `PRIMER_MIN_SIZE` | Minimum primer length (nt) | 18 | 18 | 18 | 18 |
| `PRIMER_MAX_SIZE` | Maximum primer length (nt) | 27 | 25 | 30 | 27 |

## Input/Output

**Input:** Target DNA sequence (FASTA string or file), target region coordinates, application type.

**Output:** Ranked primer pairs with Tm, GC%, self-complementarity scores, hairpin dG, and amplicon details.

## Examples

### Standard PCR Primer Design

```python
import primer3

sequence = "ATGCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG" \
           "ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGA" \
           "TCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGAT"

results = primer3.design_primers(
    seq_args={
        'SEQUENCE_ID': 'my_target',
        'SEQUENCE_TEMPLATE': sequence,
        'SEQUENCE_INCLUDED_REGION': [10, len(sequence) - 20],
    },
    global_args={
        'PRIMER_TASK': 'generic',
        'PRIMER_PICK_LEFT_PRIMER': 1,
        'PRIMER_PICK_RIGHT_PRIMER': 1,
        'PRIMER_NUM_RETURN': 5,
        'PRIMER_OPT_SIZE': 20,
        'PRIMER_MIN_SIZE': 18,
        'PRIMER_MAX_SIZE': 27,
        'PRIMER_OPT_TM': 60.0,
        'PRIMER_MIN_TM': 57.0,
        'PRIMER_MAX_TM': 63.0,
        'PRIMER_MIN_GC': 40.0,
        'PRIMER_MAX_GC': 60.0,
        'PRIMER_PRODUCT_SIZE_RANGE': [[200, 1000]],
        'PRIMER_MAX_POLY_X': 4,
        'PRIMER_MAX_SELF_ANY_TH': 45.0,
        'PRIMER_MAX_SELF_END_TH': 35.0,
        'PRIMER_MAX_HAIRPIN_TH': 47.0,
    }
)

for i in range(results['PRIMER_PAIR_NUM_RETURNED']):
    fwd = results[f'PRIMER_LEFT_{i}_SEQUENCE']
    rev = results[f'PRIMER_RIGHT_{i}_SEQUENCE']
    tm_f = results[f'PRIMER_LEFT_{i}_TM']
    tm_r = results[f'PRIMER_RIGHT_{i}_TM']
    prod = results[f'PRIMER_PAIR_{i}_PRODUCT_SIZE']
    print(f"Pair {i}: F={fwd} (Tm={tm_f:.1f}) R={rev} (Tm={tm_r:.1f}) Product={prod}bp")
```

### qPCR Primer Design

```python
qpcr_results = primer3.design_primers(
    seq_args={
        'SEQUENCE_ID': 'qpcr_target',
        'SEQUENCE_TEMPLATE': sequence,
    },
    global_args={
        'PRIMER_TASK': 'generic',
        'PRIMER_NUM_RETURN': 3,
        'PRIMER_OPT_TM': 60.0,
        'PRIMER_MIN_TM': 58.0,
        'PRIMER_MAX_TM': 62.0,
        'PRIMER_MAX_DIFF_TM': 1.5,
        'PRIMER_PRODUCT_SIZE_RANGE': [[70, 200]],
        'PRIMER_MAX_POLY_X': 3,
        'PRIMER_GC_CLAMP': 1,  # require G/C at 3' end
    }
)
```

### Gibson Assembly Primers

```python
def design_gibson_primers(insert_seq, vector_seq, overlap=25):
    """Design Gibson assembly primers with overlap regions."""
    vector_3prime = vector_seq[-overlap:]  # end of linearized vector
    vector_5prime = vector_seq[:overlap]   # start of linearized vector

    insert_results = primer3.design_primers(
        seq_args={'SEQUENCE_TEMPLATE': insert_seq},
        global_args={
            'PRIMER_TASK': 'generic',
            'PRIMER_NUM_RETURN': 3,
            'PRIMER_OPT_TM': 62.0,
            'PRIMER_MIN_TM': 59.0,
            'PRIMER_MAX_TM': 65.0,
            'PRIMER_PRODUCT_SIZE_RANGE': [[len(insert_seq) - 10, len(insert_seq) + 10]],
        }
    )

    if insert_results['PRIMER_PAIR_NUM_RETURNED'] > 0:
        fwd_binding = insert_results['PRIMER_LEFT_0_SEQUENCE']
        rev_binding = insert_results['PRIMER_RIGHT_0_SEQUENCE']
        fwd_full = vector_3prime + fwd_binding
        rev_full = vector_5prime + rev_binding  # reverse complement of overlap
        return {
            'forward': fwd_full,
            'reverse': rev_full,
            'fwd_binding_tm': insert_results['PRIMER_LEFT_0_TM'],
            'rev_binding_tm': insert_results['PRIMER_RIGHT_0_TM'],
        }
    return None
```

### Golden Gate Primers

```python
def design_golden_gate_primers(insert_seq, overhang_fwd="AATG", overhang_rev="GCTT",
                                enzyme="BsaI"):
    """Design Golden Gate primers with Type IIS restriction sites."""
    enzyme_sites = {
        "BsaI": {"site": "GGTCTC", "spacer": "A"},
        "BpiI": {"site": "GAAGAC", "spacer": "AA"},
        "SapI": {"site": "GCTCTTC", "spacer": "A"},
    }
    enz = enzyme_sites[enzyme]

    results = primer3.design_primers(
        seq_args={'SEQUENCE_TEMPLATE': insert_seq},
        global_args={
            'PRIMER_TASK': 'generic',
            'PRIMER_NUM_RETURN': 3,
            'PRIMER_OPT_TM': 60.0,
            'PRIMER_MIN_TM': 57.0,
            'PRIMER_MAX_TM': 63.0,
        }
    )

    if results['PRIMER_PAIR_NUM_RETURNED'] > 0:
        fwd_bind = results['PRIMER_LEFT_0_SEQUENCE']
        rev_bind = results['PRIMER_RIGHT_0_SEQUENCE']
        fwd = f"{enz['site']}{enz['spacer']}{overhang_fwd}{fwd_bind}"
        rev = f"{enz['site']}{enz['spacer']}{overhang_rev}{rev_bind}"
        return {'forward': fwd, 'reverse': rev}
    return None
```

### NEB Tm Calculator Validation

```python
import requests

def neb_tm(primer_seq, conc_nm=250):
    """Query NEB Tm Calculator API for experimental Tm."""
    url = "https://tmapi.neb.com/tm"
    params = {
        "seq": primer_seq,
        "conc": conc_nm,
        "prodcode": "M0530",  # Q5 polymerase
    }
    resp = requests.get(url, params=params)
    if resp.status_code == 200:
        data = resp.json()
        return {
            'tm': data.get('tm'),
            'ta': data.get('ta'),  # annealing temperature
        }
    return None

# Validate a designed primer
result = neb_tm("ATCGATCGATCGATCGATCG")
if result:
    print(f"Tm = {result['tm']}C, Recommended Ta = {result['ta']}C")
```

### Primer Tm Calculation (Nearest-Neighbor)

```python
def calc_tm_nn(seq, dna_conc_nm=250, salt_mm=50):
    """Calculate Tm using primer3 nearest-neighbor thermodynamics."""
    tm = primer3.calc_tm(
        seq,
        mv_conc=salt_mm,
        dv_conc=1.5,
        dntp_conc=0.2,
        dna_conc=dna_conc_nm,
        tm_method='santalucia',
        salt_corrections_method='santalucia',
    )
    return round(tm, 1)

def check_primer_quality(seq):
    """Run comprehensive quality checks on a primer sequence."""
    hairpin = primer3.calc_hairpin(seq)
    homodimer = primer3.calc_homodimer(seq)
    gc = 100.0 * (seq.count('G') + seq.count('C')) / len(seq)
    return {
        'sequence': seq,
        'length': len(seq),
        'tm': calc_tm_nn(seq),
        'gc_percent': round(gc, 1),
        'hairpin_dg': round(hairpin.dg / 1000, 2),
        'homodimer_dg': round(homodimer.dg / 1000, 2),
        'poly_run': max(len(m) for c in 'ATGC' for m in seq.split(c)) if seq else 0,
    }
```

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| No primers returned | Constraints too strict for template | Relax Tm range or product size; check template for low-complexity regions |
| High self-complementarity | Primer forms stable secondary structures | Increase `PRIMER_MAX_SELF_ANY_TH` threshold or let Primer3 pick alternatives |
| Tm mismatch with NEB | Different salt/polymerase conditions | Specify matching `mv_conc`, `dv_conc` values; NEB uses polymerase-specific corrections |
| Gibson overlap too short | Fragments fail to assemble | Use 25-40 bp overlaps; check overlap Tm is above 48C |
| Golden Gate low efficiency | Incorrect overhang design | Verify 4-bp overhangs are non-palindromic; check NEB Ligase Fidelity Viewer |
| `primer3-py` import error | Package not installed or version mismatch | Run `pip install primer3-py>=2.0.0` |
| Off-target amplification | Primers bind non-specifically | BLAST primers against reference genome; add specificity checks |
