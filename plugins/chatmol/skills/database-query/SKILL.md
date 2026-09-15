---
name: database-query
description: Query 50+ biological databases spanning genomics, proteomics, cancer, drugs, pathways, single cell, and literature with REST API examples.
license: MIT
category: bioinformatics-databases
tags:
  - ensembl
  - ncbi
  - uniprot
  - pdb
  - kegg
  - reactome
  - cosmic
  - tcga
  - drugbank
  - pubmed
  - geo
  - gnomad
  - api
---

# Biological Database Queries

Programmatic access to 50+ biological databases organized by category, with REST API endpoints and Python examples for data retrieval.

## When to Use

- Retrieving gene, transcript, or protein annotations from reference databases
- Querying variant frequency data from population genomics resources
- Fetching protein structures, domains, and interaction data
- Accessing cancer genomics datasets and mutation catalogs
- Searching drug-target interaction databases
- Querying pathway and gene ontology databases
- Accessing single-cell expression atlases
- Searching scientific literature programmatically

## How to Run

### Prerequisites

Refer to [shared compute setup](../_shared/SKILL.md) for base environment configuration.

```bash
pip install requests biopython pandas xmltodict
```

## Database Catalog

### Genomics and Genetics

| Database | Description | API Base URL |
|----------|-------------|-------------|
| Ensembl | Gene/transcript/variant annotation | `https://rest.ensembl.org` |
| NCBI Gene | Gene summaries, orthologs, interactions | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/` |
| NCBI Nucleotide | GenBank/RefSeq sequences | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/` |
| GTEx | Tissue-specific gene expression | `https://gtexportal.org/api/v2/` |
| GEO | Gene expression omnibus datasets | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/` |
| gnomAD | Population variant frequencies | `https://gnomad.broadinstitute.org/api` |
| ClinVar | Clinical variant interpretations | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/` |
| dbSNP | SNP catalog | `https://api.ncbi.nlm.nih.gov/variation/v0/` |
| UCSC Genome | Genome browser and annotations | `https://api.genome.ucsc.edu/` |
| ENCODE | Functional genomics encyclopedia | `https://www.encodeproject.org/` |
| Roadmap | Epigenomics reference maps | `https://egg2.wustl.edu/roadmap/` |

### Proteins and Structures

| Database | Description | API Base URL |
|----------|-------------|-------------|
| UniProt | Protein sequences, function, variants | `https://rest.uniprot.org/` |
| RCSB PDB | Protein 3D structures | `https://data.rcsb.org/rest/v1/` |
| AlphaFold DB | AI-predicted protein structures | `https://alphafold.ebi.ac.uk/api/` |
| InterPro | Protein families, domains, sites | `https://www.ebi.ac.uk/interpro/api/` |
| STRING | Protein-protein interactions | `https://string-db.org/api/` |
| Pfam | Protein domain families | `https://www.ebi.ac.uk/interpro/api/entry/pfam/` |
| RCSB Search | Advanced structure search | `https://search.rcsb.org/rcsbsearch/v2/query` |
| PDBe | European PDB mirror + analysis | `https://www.ebi.ac.uk/pdbe/api/` |

### Cancer Genomics

| Database | Description | API Base URL |
|----------|-------------|-------------|
| COSMIC | Catalog of somatic mutations | `https://cancer.sanger.ac.uk/cosmic/` |
| TCGA (GDC) | Cancer genome atlas via GDC | `https://api.gdc.cancer.gov/` |
| cBioPortal | Cancer genomics portal | `https://www.cbioportal.org/api/` |
| DepMap | Cancer dependency map | `https://depmap.org/portal/api/` |
| ICGC | International cancer genome | `https://dcc.icgc.org/api/v1/` |
| CIVIC | Clinical interpretations of variants | `https://civicdb.org/api/graphql` |
| OncoKB | Precision oncology knowledge base | `https://www.oncokb.org/api/v1/` |
| Cancer Cell Line Encyclopedia | Cell line characterization | via DepMap |

### Drugs and Chemistry

| Database | Description | API Base URL |
|----------|-------------|-------------|
| ChEMBL | Bioactivity data for drug-like molecules | `https://www.ebi.ac.uk/chembl/api/data/` |
| PubChem | Chemical structures and bioassays | `https://pubchem.ncbi.nlm.nih.gov/rest/pug/` |
| DrugBank | Drug and drug target information | `https://go.drugbank.com/` |
| DGIdb | Drug-gene interactions | `https://dgidb.org/api/graphql` |
| TTD | Therapeutic target database | `https://db.idrblab.net/ttd/` |
| ChemicalProbes | Chemical probe quality | `https://www.chemicalprobes.org/` |
| Open Targets | Drug target evidence | `https://api.platform.opentargets.org/api/v4/graphql` |

### Pathways and Ontologies

| Database | Description | API Base URL |
|----------|-------------|-------------|
| KEGG | Pathway maps and orthologs | `https://rest.kegg.jp/` |
| Reactome | Curated biological pathways | `https://reactome.org/ContentService/` |
| Gene Ontology | Functional annotations | `https://api.geneontology.org/api/` |
| WikiPathways | Community-curated pathways | `https://www.wikipathways.org/json/` |
| MSigDB | Gene set collections | `https://www.gsea-msigdb.org/gsea/msigdb/` |
| Enrichr | Gene set enrichment analysis | `https://maayanlab.cloud/Enrichr/` |

### Single Cell

| Database | Description | API Base URL |
|----------|-------------|-------------|
| CellxGene | Single-cell expression atlas | `https://api.cellxgene.cziscience.com/` |
| Human Cell Atlas | Reference cell atlas | `https://data.humancellatlas.org/` |
| Tabula Sapiens | Human cell atlas reference | via CellxGene |
| PanglaoDB | Single-cell marker database | `https://panglaodb.se/` |
| CellMarker | Cell type marker database | `http://xteam.xbio.top/CellMarker/` |
| scREAD | Single-cell Alzheimer's | `https://bmbls.bmi.osumc.edu/api/scread/` |

### Literature

| Database | Description | API Base URL |
|----------|-------------|-------------|
| PubMed | Biomedical literature | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/` |
| bioRxiv | Biology preprints | `https://api.biorxiv.org/` |
| medRxiv | Medical preprints | `https://api.biorxiv.org/` |
| Semantic Scholar | AI-powered literature search | `https://api.semanticscholar.org/graph/v1/` |
| OpenAlex | Open scholarly metadata | `https://api.openalex.org/` |
| Europe PMC | European literature archive | `https://www.ebi.ac.uk/europepmc/webservices/rest/` |

## Examples

### Ensembl: Gene Information

```python
import requests

def ensembl_gene_info(gene_symbol, species="homo_sapiens"):
    """Fetch gene information from Ensembl REST API."""
    url = f"https://rest.ensembl.org/lookup/symbol/{species}/{gene_symbol}"
    resp = requests.get(url, headers={"Content-Type": "application/json"})
    resp.raise_for_status()
    data = resp.json()
    return {
        'id': data['id'],
        'display_name': data['display_name'],
        'description': data.get('description', ''),
        'biotype': data['biotype'],
        'chromosome': data['seq_region_name'],
        'start': data['start'],
        'end': data['end'],
        'strand': data['strand'],
    }

info = ensembl_gene_info("BRCA1")
print(f"{info['display_name']} ({info['id']}): chr{info['chromosome']}:{info['start']}-{info['end']}")
```

### NCBI: E-Utilities Search and Fetch

```python
from Bio import Entrez

Entrez.email = os.environ["NCBI_EMAIL"]  # real address required by NCBI; never invent one

def ncbi_search(database, query, max_results=10):
    """Search any NCBI database via E-Utilities."""
    handle = Entrez.esearch(db=database, term=query, retmax=max_results)
    results = Entrez.read(handle)
    handle.close()
    return results['IdList']

def ncbi_fetch(database, uid, rettype="gb", retmode="text"):
    """Fetch records from NCBI by UID."""
    handle = Entrez.efetch(db=database, id=uid, rettype=rettype, retmode=retmode)
    data = handle.read()
    handle.close()
    return data

# Search PubMed
ids = ncbi_search("pubmed", "CRISPR Cas9 therapy 2024", max_results=5)
for uid in ids:
    record = ncbi_fetch("pubmed", uid, rettype="abstract")
    print(record[:200])
```

### gnomAD: Variant Frequency (GraphQL)

```python
import requests

def gnomad_variant(chrom, pos, ref, alt, dataset="gnomad_r4"):
    """Query gnomAD for variant allele frequency."""
    query = """
    query ($variantId: String!, $dataset: DatasetId!) {
        variant(variantId: $variantId, dataset: $dataset) {
            variant_id
            genome { ac, an, af }
            exome { ac, an, af }
        }
    }
    """
    variant_id = f"{chrom}-{pos}-{ref}-{alt}"
    resp = requests.post(
        "https://gnomad.broadinstitute.org/api",
        json={"query": query, "variables": {"variantId": variant_id, "dataset": dataset}}
    )
    return resp.json()['data']['variant']
```

### GTEx: Tissue Expression

```python
def gtex_gene_expression(gene_symbol):
    """Fetch tissue-level gene expression from GTEx."""
    url = f"https://gtexportal.org/api/v2/expression/medianGeneExpression"
    params = {"geneSymbol": gene_symbol, "datasetId": "gtex_v8"}
    resp = requests.get(url, params=params)
    resp.raise_for_status()
    data = resp.json()['data']
    return sorted(data, key=lambda x: x['median'], reverse=True)
```

### cBioPortal: Cancer Mutations

```python
def cbioportal_mutations(gene_symbol, study_id="msk_impact_2017"):
    """Fetch mutations for a gene from cBioPortal."""
    url = f"https://www.cbioportal.org/api/molecular-profiles/{study_id}_mutations/mutations"
    params = {
        "entrezGeneId": get_entrez_id(gene_symbol),
        "projection": "DETAILED",
    }
    resp = requests.get(url, params=params)
    resp.raise_for_status()
    return resp.json()

def get_entrez_id(symbol):
    """Resolve gene symbol to Entrez ID via NCBI."""
    ids = ncbi_search("gene", f"{symbol}[sym] AND Homo sapiens[orgn]", max_results=1)
    return ids[0] if ids else None
```

### KEGG: Pathway Query

```python
def kegg_pathway_genes(pathway_id):
    """Fetch genes in a KEGG pathway."""
    url = f"https://rest.kegg.jp/link/hsa/{pathway_id}"
    resp = requests.get(url)
    genes = []
    for line in resp.text.strip().split('\n'):
        parts = line.split('\t')
        if len(parts) == 2:
            genes.append(parts[1])
    return genes

def kegg_find(database, query):
    """Search KEGG database."""
    url = f"https://rest.kegg.jp/find/{database}/{query}"
    resp = requests.get(url)
    results = []
    for line in resp.text.strip().split('\n'):
        parts = line.split('\t')
        if len(parts) >= 2:
            results.append({'id': parts[0], 'description': parts[1]})
    return results

# Find pathways for a gene
pathways = kegg_find("pathway", "BRCA1")
```

### Enrichr: Gene Set Enrichment

```python
def enrichr_submit(gene_list, description="my gene list"):
    """Submit a gene list to Enrichr."""
    url = "https://maayanlab.cloud/Enrichr/addList"
    payload = {"list": "\n".join(gene_list), "description": description}
    resp = requests.post(url, data=payload)
    return resp.json()

def enrichr_results(user_list_id, library="GO_Biological_Process_2023"):
    """Fetch enrichment results from Enrichr."""
    url = f"https://maayanlab.cloud/Enrichr/enrich"
    params = {"userListId": user_list_id, "backgroundType": library}
    resp = requests.get(url, params=params)
    return resp.json()

# Example
genes = ["BRCA1", "TP53", "ATM", "CHEK2", "RAD51", "PALB2"]
submission = enrichr_submit(genes)
results = enrichr_results(submission['userListId'])
```

### CellxGene: Single-Cell Datasets

```python
def cellxgene_collections():
    """List available collections in CellxGene."""
    url = "https://api.cellxgene.cziscience.com/collections"
    resp = requests.get(url)
    resp.raise_for_status()
    return resp.json()

def cellxgene_datasets(tissue=None, disease=None):
    """Search CellxGene datasets by tissue or disease."""
    url = "https://api.cellxgene.cziscience.com/datasets"
    params = {}
    if tissue:
        params['tissue'] = tissue
    if disease:
        params['disease'] = disease
    resp = requests.get(url, params=params)
    return resp.json()
```

### Open Targets: Drug-Target Evidence

```python
def opentargets_associations(gene_symbol):
    """Query Open Targets for disease associations."""
    query = """
    query ($ensemblId: String!) {
        target(ensemblId: $ensemblId) {
            id
            approvedSymbol
            associatedDiseases {
                rows { disease { id name } score }
            }
        }
    }
    """
    ensembl_id = ensembl_gene_info(gene_symbol)['id']
    resp = requests.post(
        "https://api.platform.opentargets.org/api/v4/graphql",
        json={"query": query, "variables": {"ensemblId": ensembl_id}}
    )
    return resp.json()['data']['target']['associatedDiseases']['rows']
```

## Input/Output

**Input:** Gene symbols, protein accessions, variant coordinates, search queries, or database-specific identifiers.

**Output:** Structured JSON/XML responses parsed into Python dictionaries or pandas DataFrames.

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| 429 Too Many Requests | Rate limit exceeded | Add `time.sleep(0.34)` between requests; use batch endpoints where available |
| 403 Forbidden | API key required or IP blocked | Register for API key (NCBI, Semantic Scholar); check terms of use |
| Empty results | Wrong identifier format | Verify gene symbol vs. Ensembl ID vs. Entrez ID; use ID mapping endpoints |
| Timeout on large queries | Requesting too much data | Use pagination parameters; limit result count; use FTP for bulk downloads |
| gnomAD GraphQL error | Malformed query or wrong dataset version | Validate query at gnomAD GraphQL explorer; check dataset version (r4 vs r3) |
| KEGG returns HTML | Endpoint changed or deprecated | Check KEGG REST API docs; some endpoints require specific format parameters |
| SSL certificate error | Outdated certificates | Update certifi: `pip install --upgrade certifi`; or use `verify=False` cautiously |
