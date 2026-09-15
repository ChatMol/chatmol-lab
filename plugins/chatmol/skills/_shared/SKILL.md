---
name: Shared Compute Setup
description: Common setup for Modal GPU computation, Python environment, and biomodals tools
license: MIT
category: infrastructure
tags: [modal, gpu, setup, biomodals, environment]
user-invocable: false
---

# Shared Compute Setup

## Modal Setup
```bash
pip install modal
modal setup  # Opens browser for authentication
```

## Biomodals
```bash
git clone --depth 1 https://github.com/hgbrian/biomodals.git ~/.chatmol/biomodals
```

### Available Scripts
| Script | Tool | GPU |
|--------|------|-----|
| `modal_alphafold.py` | AlphaFold2 via ColabFold | A10G |
| `modal_boltz.py` | Boltz-1 complex prediction | L40S |
| `modal_rfdiffusion.py` | RFDiffusion backbone design | A10G |
| `modal_proteinmpnn.py` | ProteinMPNN sequence design | T4 |
| `modal_ligandmpnn.py` | LigandMPNN | T4 |
| `modal_esmfold.py` | ESMFold structure prediction | A10G |
| `modal_bindcraft.py` | BindCraft binder design | A100 |
| `modal_boltzgen.py` | BoltzGen all-atom design | L40S |

## Python Core Dependencies
```bash
pip install numpy pandas scipy scikit-learn matplotlib seaborn
pip install biopython requests tqdm jupyter fair-esm biotite
```

## GPU Tier Guide
| GPU | VRAM | Use For |
|-----|------|---------|
| T4 | 16 GB | ProteinMPNN, ESM-2, small models |
| A10G | 24 GB | AlphaFold2, ESMFold, RFDiffusion |
| L40S | 48 GB | Boltz-1, BoltzGen, large complexes |
| A100 | 80 GB | Protenix, BindCraft, Chai-1 |

## Workspace Conventions
- Save structures as PDB or mmCIF files
- Save sequences as FASTA files
- Save data as CSV files
- Report all confidence metrics (pLDDT, pTM, ipTM, PAE)
