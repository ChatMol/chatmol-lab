---
name: sequence-analysis
description: General DNA/RNA/protein sequence analysis including ORF finding, translation, alignment, restriction mapping, and phylogenetics.
license: MIT
category: bioinformatics
tags:
  - sequence-analysis
  - orf-finding
  - translation
  - alignment
  - restriction-sites
  - phylogenetics
  - biopython
  - emboss
  - muscle
  - mafft
---

# Sequence Analysis

Comprehensive toolkit for DNA, RNA, and protein sequence analysis including ORF detection, translation, reverse complement, GC content calculation, restriction site mapping, pairwise and multiple sequence alignment, and basic phylogenetic inference.

## When to Use

- Finding open reading frames (ORFs) in a DNA sequence
- Translating DNA/RNA to protein in all six reading frames
- Computing reverse complement of a nucleotide sequence
- Calculating GC content and nucleotide composition
- Mapping restriction enzyme recognition sites for cloning or Southern blots
- Performing pairwise sequence alignment (Needleman-Wunsch or Smith-Waterman)
- Running multiple sequence alignment with MUSCLE or MAFFT
- Building basic phylogenetic trees from aligned sequences

## How to Run

### Prerequisites

Refer to [shared compute setup](../_shared/SKILL.md) for base environment configuration.

```bash
pip install biopython numpy matplotlib
# For MUSCLE/MAFFT alignment:
# conda install -c bioconda muscle mafft
# For EMBOSS tools:
# conda install -c bioconda emboss
```

## Key Parameters

| Function | Parameter | Description | Default |
|----------|-----------|-------------|---------|
| ORF finding | `min_length` | Minimum ORF length (codons) | 100 |
| ORF finding | `start_codons` | Start codon(s) to use | `["ATG"]` |
| Translation | `table` | NCBI translation table number | 1 (standard) |
| GC content | `window_size` | Sliding window size for GC plot | 100 |
| Restriction | `enzymes` | Enzyme list or `CommOnly` for common | `CommOnly` |
| Alignment | `matrix` | Substitution matrix | BLOSUM62 |
| Alignment | `gap_open` | Gap opening penalty | -10 |
| Alignment | `gap_extend` | Gap extension penalty | -0.5 |
| Phylogenetics | `method` | Tree building method | `neighbor_joining` |

## Input/Output

**Input:** DNA/RNA/protein sequences in FASTA format (string or file).

**Output:** Analysis results as structured data, sequence objects, alignment files (FASTA/Clustal), or Newick trees.

## Examples

### Reverse Complement and Basic Properties

```python
from Bio.Seq import Seq
from Bio.SeqUtils import gc_fraction

seq = Seq("ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG")

print(f"Sequence:    {seq}")
print(f"Complement:  {seq.complement()}")
print(f"Rev Comp:    {seq.reverse_complement()}")
print(f"RNA:         {seq.transcribe()}")
print(f"Length:      {len(seq)} bp")
print(f"GC content:  {gc_fraction(seq) * 100:.1f}%")
```

### Translation in All Six Frames

```python
from Bio.Seq import Seq

def translate_six_frames(dna_seq):
    """Translate a DNA sequence in all six reading frames."""
    seq = Seq(dna_seq.upper())
    rc = seq.reverse_complement()
    frames = {}
    for i in range(3):
        frames[f'+{i+1}'] = str(seq[i:].translate())
        frames[f'-{i+1}'] = str(rc[i:].translate())
    return frames

dna = "ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG"
for frame, protein in translate_six_frames(dna).items():
    print(f"Frame {frame}: {protein}")
```

### ORF Finding

```python
from Bio.Seq import Seq

def find_orfs(sequence, min_codons=100, start_codons=None, table=1):
    """Find all ORFs in a DNA sequence across all six reading frames."""
    if start_codons is None:
        start_codons = ["ATG"]
    seq = Seq(sequence.upper())
    orfs = []

    for strand, nuc in [("+", seq), ("-", seq.reverse_complement())]:
        for frame in range(3):
            trans = str(nuc[frame:].translate(table=table))
            aa_start = 0
            while aa_start < len(trans):
                # Find next methionine
                start_pos = -1
                for sc in start_codons:
                    sc_aa = str(Seq(sc).translate())
                    pos = trans.find(sc_aa, aa_start)
                    if pos != -1 and (start_pos == -1 or pos < start_pos):
                        start_pos = pos
                if start_pos == -1:
                    break
                # Find next stop codon
                stop_pos = trans.find("*", start_pos)
                if stop_pos == -1:
                    break
                orf_len = stop_pos - start_pos
                if orf_len >= min_codons:
                    nt_start = start_pos * 3 + frame
                    nt_end = stop_pos * 3 + frame + 3
                    orfs.append({
                        'strand': strand,
                        'frame': frame + 1,
                        'aa_start': start_pos,
                        'aa_length': orf_len,
                        'nt_start': nt_start,
                        'nt_end': nt_end,
                        'protein': trans[start_pos:stop_pos],
                    })
                aa_start = stop_pos + 1

    return sorted(orfs, key=lambda x: x['aa_length'], reverse=True)
```

### GC Content Sliding Window

```python
import numpy as np

def gc_sliding_window(sequence, window_size=100, step=10):
    """Compute GC content across a sequence with a sliding window."""
    seq = sequence.upper()
    positions = []
    gc_values = []
    for i in range(0, len(seq) - window_size + 1, step):
        window = seq[i:i + window_size]
        gc = (window.count('G') + window.count('C')) / window_size * 100
        positions.append(i + window_size // 2)
        gc_values.append(gc)
    return positions, gc_values

def plot_gc_content(sequence, window_size=100, step=10):
    """Plot GC content along a sequence."""
    import matplotlib.pyplot as plt
    positions, gc_values = gc_sliding_window(sequence, window_size, step)
    fig, ax = plt.subplots(figsize=(12, 4))
    ax.plot(positions, gc_values, color='steelblue', linewidth=1)
    ax.axhline(y=50, color='gray', linestyle='--', alpha=0.5)
    ax.set_xlabel('Position (bp)')
    ax.set_ylabel('GC Content (%)')
    ax.set_title(f'GC Content (window={window_size}bp)')
    ax.set_ylim(0, 100)
    return fig
```

### Restriction Site Mapping

```python
from Bio.Restriction import RestrictionBatch, CommOnly, Analysis
from Bio.Seq import Seq

def map_restriction_sites(sequence, enzymes=None):
    """Map restriction enzyme recognition sites in a DNA sequence."""
    seq = Seq(sequence.upper())

    if enzymes is None:
        batch = CommOnly  # ~600 commercially available enzymes
    else:
        batch = RestrictionBatch(enzymes)

    analysis = Analysis(batch, seq, linear=True)
    results = analysis.full()

    # Filter to only enzymes that cut
    cutting = {str(enz): sites for enz, sites in results.items() if sites}
    return cutting

# Find unique cutters for cloning
def find_unique_cutters(sequence, enzymes=None):
    """Find enzymes that cut the sequence exactly once."""
    sites = map_restriction_sites(sequence, enzymes)
    return {enz: pos for enz, pos in sites.items() if len(pos) == 1}

# Example
seq = "ATGAATTCGATCGATCGATATCGATCGATCGAATTCATG"
sites = map_restriction_sites(seq, ["EcoRI", "EcoRV", "BamHI"])
for enzyme, positions in sites.items():
    print(f"{enzyme}: cuts at {positions} ({len(positions)} site(s))")
```

### Pairwise Sequence Alignment

```python
from Bio import pairwise2
from Bio.Align import substitution_matrices

def pairwise_align(seq1, seq2, mode="global", matrix_name="BLOSUM62",
                    gap_open=-10, gap_extend=-0.5):
    """Perform pairwise sequence alignment."""
    if mode == "global":
        align_func = pairwise2.align.globalds
    else:
        align_func = pairwise2.align.localds

    matrix = substitution_matrices.load(matrix_name)
    alignments = align_func(seq1, seq2, matrix, gap_open, gap_extend)

    if alignments:
        best = alignments[0]
        return {
            'seq1_aligned': best.seqA,
            'seq2_aligned': best.seqB,
            'score': best.score,
            'start': best.start,
            'end': best.end,
        }
    return None

# For nucleotide alignment (simple match/mismatch)
from Bio import Align

def nucleotide_align(seq1, seq2, mode="global"):
    """Pairwise nucleotide alignment with simple scoring."""
    aligner = Align.PairwiseAligner()
    aligner.mode = mode
    aligner.match_score = 2
    aligner.mismatch_score = -1
    aligner.open_gap_score = -5
    aligner.extend_gap_score = -0.5
    alignments = aligner.align(seq1, seq2)
    best = alignments[0]
    return {'alignment': str(best), 'score': best.score}
```

### Multiple Sequence Alignment (MUSCLE/MAFFT)

```python
import subprocess
import tempfile
from Bio import SeqIO, AlignIO

def run_muscle(input_fasta, output_path=None):
    """Run MUSCLE multiple sequence alignment."""
    if output_path is None:
        output_path = tempfile.mktemp(suffix=".afa")
    cmd = ["muscle", "-align", input_fasta, "-output", output_path]
    subprocess.run(cmd, check=True, capture_output=True)
    alignment = AlignIO.read(output_path, "fasta")
    return alignment

def run_mafft(input_fasta, output_path=None, strategy="auto"):
    """Run MAFFT multiple sequence alignment."""
    if output_path is None:
        output_path = tempfile.mktemp(suffix=".afa")
    cmd = ["mafft", "--auto", input_fasta]
    with open(output_path, 'w') as f:
        subprocess.run(cmd, check=True, stdout=f, stderr=subprocess.PIPE)
    alignment = AlignIO.read(output_path, "fasta")
    return alignment

def alignment_summary(alignment):
    """Summarize a multiple sequence alignment."""
    n_seqs = len(alignment)
    length = alignment.get_alignment_length()
    conserved = sum(
        1 for i in range(length)
        if len(set(alignment[:, i])) == 1
    )
    return {
        'num_sequences': n_seqs,
        'alignment_length': length,
        'conserved_columns': conserved,
        'percent_identity': round(conserved / length * 100, 1),
    }
```

### Basic Phylogenetics

```python
from Bio.Phylo.TreeConstruction import DistanceCalculator, DistanceTreeConstructor
from Bio import Phylo

def build_tree(alignment, method="nj"):
    """Build a phylogenetic tree from a multiple sequence alignment."""
    calculator = DistanceCalculator('identity')
    dm = calculator.get_distance(alignment)

    constructor = DistanceTreeConstructor()
    if method == "nj":
        tree = constructor.nj(dm)
    elif method == "upgma":
        tree = constructor.upgma(dm)
    else:
        raise ValueError(f"Unknown method: {method}. Use 'nj' or 'upgma'.")

    return tree

def save_tree(tree, output_path, fmt="newick"):
    """Save a phylogenetic tree to file."""
    Phylo.write(tree, output_path, fmt)

def draw_tree(tree):
    """Draw an ASCII representation of the tree."""
    Phylo.draw_ascii(tree)
```

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `Bio.Restriction` not finding enzyme | Enzyme name misspelled or not in database | Check exact name in REBASE; use `from Bio.Restriction import AllEnzymes` to search |
| Translation returns unexpected `*` | Stop codons in sequence | Check reading frame; use `to_stop=True` parameter for partial translations |
| MUSCLE/MAFFT command not found | Tool not installed or not in PATH | Install via conda: `conda install -c bioconda muscle mafft` |
| Alignment score is 0 | Wrong matrix for sequence type | Use BLOSUM62 for proteins, simple match/mismatch for nucleotides |
| ORF finder misses known gene | ORF shorter than min_codons cutoff | Lower `min_codons` threshold; check for alternative start codons |
| Phylogenetic tree looks wrong | Poor alignment quality | Trim poorly aligned regions; use `trimAl` or `Gblocks` before tree building |
| Memory error on large FASTA | Too many or too long sequences | Use MAFFT with `--memsave` flag; split analysis into batches |
