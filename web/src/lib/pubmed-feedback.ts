/** MEDLINE uses four-column tags followed by '- ', and six-space continuations. */
export function parseMedlineAbstracts(text: string): Map<string, string> {
  const records = new Map<string, string>();
  let id = "", abstract = "", field = "";
  const flush = () => { if (id) records.set(id, abstract.trim()); };
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9]{2,4})\s*-\s?(.*)$/.exec(line);
    if (match) {
      field = match[1];
      if (field === "PMID") { flush(); id = match[2].trim(); abstract = ""; }
      if (field === "AB") abstract += `${abstract ? "\n" : ""}${match[2]}`;
    } else if (field === "AB" && /^ {6}/.test(line)) abstract += ` ${line.trim()}`;
    else if (!line.trim()) field = "";
  }
  flush();
  return records;
}

/** Every requested PMID gets a labelled section, even when its abstract is missing. */
export function formatPubmedFeedback(ids: string[], summaries: string[], abstracts: Map<string, string>, limit: number): string {
  const note = "Shortened abstracts are excerpts, not complete evidence. Retrieve only the indicated PMID for more detail; do not repeat the whole search.";
  const budget = Math.floor((limit - note.length - 2) / Math.max(1, ids.length)) - 2;
  return ids.map((id, index) => {
    const label = `PMID ${id}\n`;
    const metadata = summaries[index] || "Metadata unavailable";
    const summaryBudget = Math.max(0, Math.floor(budget * 0.45) - label.length - 24);
    const summary = metadata.length > summaryBudget ? metadata.slice(0, summaryBudget) + " [metadata shortened]" : metadata;
    const prefix = label + summary + "\nAbstract: ";
    const abstract = abstracts.get(id);
    if (!abstract) return prefix + "[not returned by PubMed]";
    const marker = " … [abstract shortened]";
    const available = Math.max(0, budget - prefix.length);
    return prefix + (abstract.length <= available ? abstract : abstract.slice(0, Math.max(0, available - marker.length)) + marker);
  }).join("\n\n") + "\n\n" + note;
}
