---
name: literature-search
description: Search and analyze scientific literature using PubMed, bioRxiv, Semantic Scholar, and OpenAlex APIs with structured queries and citation analysis.
license: MIT
category: literature
tags:
  - pubmed
  - biorxiv
  - medrxiv
  - semantic-scholar
  - openalex
  - citation-analysis
  - systematic-review
  - literature-mining
---

# Scientific Literature Search

Programmatic search, retrieval, and analysis of scientific literature across PubMed, bioRxiv/medRxiv, Semantic Scholar, and OpenAlex with support for structured queries, citation networks, and systematic review workflows.

## When to Use

- Searching PubMed for biomedical publications with MeSH term filtering
- Finding recent preprints on bioRxiv and medRxiv by topic or author
- Building citation networks and analyzing research impact
- Performing systematic literature reviews with reproducible search strategies
- Retrieving full metadata (abstracts, authors, references, citations) for papers
- Tracking citation counts and field-of-study classifications
- Exporting results in structured formats for downstream analysis

## How to Run

### Prerequisites

Refer to [shared compute setup](../_shared/SKILL.md) for base environment configuration.

```bash
pip install requests biopython pandas xmltodict
```

### API Keys (Optional but Recommended)

- **NCBI**: Register at https://www.ncbi.nlm.nih.gov/account/ for higher rate limits
- **Semantic Scholar**: Get key at https://www.semanticscholar.org/product/api for 100 req/sec
- **OpenAlex**: Free, polite pool with email in query params

## Key Parameters

| API | Parameter | Description | Default |
|-----|-----------|-------------|---------|
| PubMed | `retmax` | Max results to return | 20 |
| PubMed | `mindate/maxdate` | Date range (YYYY/MM/DD) | None |
| PubMed | `sort` | Sort order (relevance, pub_date) | relevance |
| bioRxiv | `server` | biorxiv or medrxiv | biorxiv |
| bioRxiv | `interval` | Date range (YYYY-MM-DD/YYYY-MM-DD) | last 30 days |
| Semantic Scholar | `fields` | Comma-separated field list | title,year |
| Semantic Scholar | `limit` | Results per page | 10 |
| OpenAlex | `filter` | Structured filter string | None |
| OpenAlex | `sort` | Sort field (cited_by_count, publication_date) | relevance |

## Start with the built-in tool

`search_database(database="pubmed", query=..., limit=...)` already covers a
PubMed term search, and `database="uniprot"` covers protein records. Use it
first: it needs no script, no network access from bash, and its failures are
reported like any other tool.

Write a script only for what the tool does not return — full abstracts and
MeSH terms, citation networks, date-windowed batches, or an archive the tool
does not know (ENA, GEO, bioRxiv).

## Input/Output

**Input:** Search queries (free text or structured), author names, DOIs, PMIDs, paper IDs.

**Output:** Structured paper metadata (title, authors, abstract, DOI, citations), citation networks, aggregated statistics.

## Examples

### PubMed Search with E-Utilities

```python
from Bio import Entrez, Medline
import time

# NCBI requires a real contact address and rate-limits anonymous traffic.
# Read it from the environment; never invent one, and never use example.com.
import os
Entrez.email = os.environ["NCBI_EMAIL"]          # set NCBI_EMAIL first
Entrez.api_key = os.environ.get("NCBI_API_KEY")  # optional, raises the rate limit

def pubmed_search(query, max_results=20, sort="relevance",
                  min_date=None, max_date=None):
    """Search PubMed and return structured results."""
    params = {
        "db": "pubmed",
        "term": query,
        "retmax": max_results,
        "sort": sort,
        "usehistory": "y",
    }
    if min_date:
        params["mindate"] = min_date
        params["datetype"] = "pdat"
    if max_date:
        params["maxdate"] = max_date

    handle = Entrez.esearch(**params)
    search_results = Entrez.read(handle)
    handle.close()

    count = int(search_results["Count"])
    id_list = search_results["IdList"]

    if not id_list:
        return {"count": count, "papers": []}

    # Fetch details
    handle = Entrez.efetch(db="pubmed", id=id_list,
                            rettype="medline", retmode="text")
    records = list(Medline.parse(handle))
    handle.close()

    papers = []
    for rec in records:
        papers.append({
            "pmid": rec.get("PMID", ""),
            "title": rec.get("TI", ""),
            "authors": rec.get("AU", []),
            "journal": rec.get("JT", ""),
            "year": rec.get("DP", "").split()[0] if rec.get("DP") else "",
            "abstract": rec.get("AB", ""),
            "doi": rec.get("AID", [""])[0] if rec.get("AID") else "",
            "mesh_terms": rec.get("MH", []),
        })

    return {"count": count, "papers": papers}

# Example: search for CRISPR therapy papers from 2023-2024
results = pubmed_search(
    "CRISPR[Title] AND therapy[Title/Abstract]",
    max_results=10,
    min_date="2023/01/01",
    max_date="2024/12/31"
)
for p in results["papers"]:
    print(f"[PMID:{p['pmid']}] {p['title'][:80]}... ({p['year']})")
```

### PubMed Advanced Query Building

```python
def build_pubmed_query(terms=None, authors=None, journal=None,
                        mesh_terms=None, date_range=None, pub_types=None):
    """Build a structured PubMed query string."""
    parts = []
    if terms:
        for field, value in terms.items():
            parts.append(f"{value}[{field}]")
    if authors:
        author_parts = [f"{a}[Author]" for a in authors]
        parts.append(f"({' OR '.join(author_parts)})")
    if journal:
        parts.append(f'"{journal}"[Journal]')
    if mesh_terms:
        mesh_parts = [f'"{m}"[MeSH Terms]' for m in mesh_terms]
        parts.append(f"({' AND '.join(mesh_parts)})")
    if date_range:
        parts.append(f"({date_range[0]}:{date_range[1]}[Date - Publication])")
    if pub_types:
        type_parts = [f'"{pt}"[Publication Type]' for pt in pub_types]
        parts.append(f"({' OR '.join(type_parts)})")
    return " AND ".join(parts)

# Build a systematic review query
query = build_pubmed_query(
    terms={"Title/Abstract": "single-cell RNA-seq"},
    mesh_terms=["Neoplasms", "Gene Expression Profiling"],
    date_range=("2022/01/01", "2024/12/31"),
    pub_types=["Review", "Systematic Review"]
)
print(f"Query: {query}")
```

### bioRxiv / medRxiv Search

```python
def biorxiv_search(query, server="biorxiv", start_date="2024-01-01",
                    end_date="2024-12-31", cursor=0, page_size=30):
    """Search bioRxiv or medRxiv preprints."""
    url = f"https://api.biorxiv.org/details/{server}/{start_date}/{end_date}/{cursor}"
    resp = requests.get(url)
    resp.raise_for_status()
    data = resp.json()

    # Filter by query (API returns date-range results, filter client-side)
    query_lower = query.lower()
    matching = []
    for paper in data.get("collection", []):
        title = paper.get("title", "").lower()
        abstract = paper.get("abstract", "").lower()
        if query_lower in title or query_lower in abstract:
            matching.append({
                "doi": paper.get("doi", ""),
                "title": paper.get("title", ""),
                "authors": paper.get("authors", ""),
                "date": paper.get("date", ""),
                "category": paper.get("category", ""),
                "abstract": paper.get("abstract", ""),
            })

    return {"total": data.get("messages", [{}])[0].get("total", 0),
            "matching": matching}

def biorxiv_content_detail(doi):
    """Fetch full details for a specific bioRxiv preprint."""
    url = f"https://api.biorxiv.org/details/biorxiv/{doi}"
    resp = requests.get(url)
    resp.raise_for_status()
    return resp.json().get("collection", [])
```

### Semantic Scholar Search and Citation Analysis

```python
import requests

S2_BASE = "https://api.semanticscholar.org/graph/v1"
# S2_API_KEY = "your_api_key"  # optional
S2_HEADERS = {}  # add {"x-api-key": S2_API_KEY} if you have one

def semantic_scholar_search(query, limit=10, year_range=None,
                             fields="title,year,abstract,citationCount,"
                                    "authors,externalIds,url"):
    """Search Semantic Scholar for papers."""
    params = {
        "query": query,
        "limit": limit,
        "fields": fields,
    }
    if year_range:
        params["year"] = f"{year_range[0]}-{year_range[1]}"
    resp = requests.get(f"{S2_BASE}/paper/search", params=params,
                        headers=S2_HEADERS)
    resp.raise_for_status()
    return resp.json()

def semantic_scholar_paper(paper_id, fields="title,year,abstract,"
                            "citationCount,referenceCount,authors,"
                            "citations,references,externalIds"):
    """Fetch detailed paper info by DOI, PMID, or S2 ID."""
    resp = requests.get(f"{S2_BASE}/paper/{paper_id}",
                        params={"fields": fields}, headers=S2_HEADERS)
    resp.raise_for_status()
    return resp.json()

def citation_network(paper_id, depth=1):
    """Build a citation network around a paper."""
    paper = semantic_scholar_paper(paper_id)
    network = {"root": paper["title"], "citations": [], "references": []}
    for cit in paper.get("citations", [])[:20]:
        if cit.get("title"):
            network["citations"].append({
                "title": cit["title"],
                "year": cit.get("year"),
                "citationCount": cit.get("citationCount", 0),
            })
    for ref in paper.get("references", [])[:20]:
        if ref.get("title"):
            network["references"].append({
                "title": ref["title"],
                "year": ref.get("year"),
                "citationCount": ref.get("citationCount", 0),
            })
    return network

# Example
results = semantic_scholar_search("attention is all you need transformer", limit=5)
for p in results.get("data", []):
    print(f"[{p['year']}] {p['title']} (cited: {p['citationCount']})")
```

### OpenAlex Search and Analysis

```python
OPENALEX_BASE = "https://api.openalex.org"
MAILTO = os.environ["NCBI_EMAIL"]  # Crossref polite pool; a real address, never a placeholder

def openalex_search(query, filters=None, sort="relevance_score",
                     per_page=25, page=1):
    """Search OpenAlex works (papers)."""
    params = {
        "search": query,
        "sort": sort,
        "per_page": per_page,
        "page": page,
        "mailto": MAILTO,
    }
    if filters:
        params["filter"] = filters
    resp = requests.get(f"{OPENALEX_BASE}/works", params=params)
    resp.raise_for_status()
    return resp.json()

def openalex_author_works(author_name, per_page=25):
    """Find works by a specific author."""
    params = {
        "filter": f"authorships.author.display_name.search:{author_name}",
        "sort": "cited_by_count:desc",
        "per_page": per_page,
        "mailto": MAILTO,
    }
    resp = requests.get(f"{OPENALEX_BASE}/works", params=params)
    resp.raise_for_status()
    return resp.json()

def openalex_concept_trend(concept_id, start_year=2015, end_year=2024):
    """Track publication trends for a concept over years."""
    params = {
        "filter": f"concepts.id:{concept_id}",
        "group_by": "publication_year",
        "mailto": MAILTO,
    }
    resp = requests.get(f"{OPENALEX_BASE}/works", params=params)
    resp.raise_for_status()
    groups = resp.json().get("group_by", [])
    return {int(g["key"]): g["count"] for g in groups
            if start_year <= int(g["key"]) <= end_year}
```

### Systematic Review Workflow

```python
import pandas as pd

def systematic_search(databases, query, date_range=None):
    """Run a systematic search across multiple databases."""
    all_results = []

    # PubMed
    if "pubmed" in databases:
        pm = pubmed_search(query, max_results=100,
                           min_date=date_range[0] if date_range else None,
                           max_date=date_range[1] if date_range else None)
        for p in pm["papers"]:
            p["source"] = "pubmed"
            all_results.append(p)

    # Semantic Scholar
    if "semantic_scholar" in databases:
        ss = semantic_scholar_search(query, limit=100,
                                      year_range=(int(date_range[0][:4]),
                                                  int(date_range[1][:4]))
                                      if date_range else None)
        for p in ss.get("data", []):
            all_results.append({
                "title": p["title"],
                "year": str(p.get("year", "")),
                "authors": [a["name"] for a in p.get("authors", [])],
                "doi": p.get("externalIds", {}).get("DOI", ""),
                "source": "semantic_scholar",
            })

    # Deduplicate by DOI
    df = pd.DataFrame(all_results)
    if "doi" in df.columns:
        df_dedup = df.drop_duplicates(subset="doi", keep="first")
    else:
        df_dedup = df

    return df_dedup

def export_for_screening(df, output_path):
    """Export search results for title/abstract screening."""
    cols = ["title", "authors", "year", "journal", "abstract", "doi", "source"]
    export_cols = [c for c in cols if c in df.columns]
    df[export_cols].to_csv(output_path, index=False)
    print(f"Exported {len(df)} records to {output_path}")
```

### Author H-Index Calculation

```python
def calculate_h_index(citation_counts):
    """Calculate H-index from a list of citation counts."""
    sorted_counts = sorted(citation_counts, reverse=True)
    h = 0
    for i, count in enumerate(sorted_counts):
        if count >= i + 1:
            h = i + 1
        else:
            break
    return h

def author_metrics(author_name):
    """Calculate publication metrics for an author."""
    works = openalex_author_works(author_name, per_page=200)
    results = works.get("results", [])
    citations = [w.get("cited_by_count", 0) for w in results]
    return {
        "name": author_name,
        "total_papers": len(results),
        "total_citations": sum(citations),
        "h_index": calculate_h_index(citations),
        "mean_citations": round(sum(citations) / max(len(citations), 1), 1),
    }
```

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| PubMed returns 0 results | Query syntax error | Test query on PubMed web first; escape special characters; check MeSH terms |
| NCBI rate limit (HTTP 429) | Too many requests without API key | Register for NCBI API key (10 req/sec vs 3 req/sec); add `time.sleep(0.35)` |
| Semantic Scholar timeout | Large result set or server load | Reduce `limit`; add retry logic with exponential backoff |
| bioRxiv API returns all papers | No server-side text search | Filter results client-side by matching query against title/abstract |
| OpenAlex missing papers | New papers not yet indexed | OpenAlex updates weekly; check PubMed or Semantic Scholar for very recent papers |
| Duplicate papers across sources | Same paper indexed differently | Deduplicate by DOI; fall back to fuzzy title matching if DOI is missing |
| Citation counts differ between APIs | Different indexing coverage | Semantic Scholar and OpenAlex have different corpora; note the source in reports |
| Special characters in query | URL encoding issues | Use `requests` library which handles encoding; avoid manual URL construction |
