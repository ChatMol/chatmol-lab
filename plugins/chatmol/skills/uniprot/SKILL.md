---
name: UniProt Protein Database
description: Query UniProt for protein sequences, functions, structures, and annotations via REST API
license: MIT
category: databases
tags: [uniprot, protein, database, sequence, annotation]
---

# UniProt Protein Database

## REST API Endpoints

### Search Proteins
```python
import requests

def search_uniprot(query, limit=10, fields=None):
    default_fields = "accession,id,protein_name,gene_names,organism_name,length,sequence"
    url = "https://rest.uniprot.org/uniprotkb/search"
    params = {"query": query, "size": limit, "format": "json", "fields": fields or default_fields}
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()

results = search_uniprot("kinase AND organism_id:9606", limit=5)
results = search_uniprot("gene:BRCA1 AND reviewed:true")
```

### Fetch by Accession
```python
def fetch_uniprot(accession, format="json"):
    url = f"https://rest.uniprot.org/uniprotkb/{accession}"
    headers = {"Accept": f"application/{format}"}
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    return response.json() if format == "json" else response.text
```

### Fetch FASTA
```python
def fetch_fasta(accession):
    url = f"https://rest.uniprot.org/uniprotkb/{accession}.fasta"
    return requests.get(url).text
```

### ID Mapping
```python
def map_ids(from_db, to_db, ids):
    import time
    url = "https://rest.uniprot.org/idmapping/run"
    response = requests.post(url, data={"from": from_db, "to": to_db, "ids": ",".join(ids)})
    job_id = response.json()["jobId"]
    while True:
        result = requests.get(f"https://rest.uniprot.org/idmapping/status/{job_id}")
        data = result.json()
        if "results" in data: return data
        time.sleep(1)
```

## Query Syntax
- `organism_id:9606` - Human proteins
- `reviewed:true` - Swiss-Prot only
- `gene:TP53` - By gene name
- `ec:3.4.21.*` - By EC number
- `structure_3d:true` - Has 3D structure
- `length:[100 TO 500]` - Sequence length range
