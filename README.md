# Open Scholar Search

Open-API-first literature search, open-access resolution, evidence layering, and reference export. The skill works without institutional access and degrades source by source instead of aborting the whole batch.

## What it is especially good for

**Rapidly finding authoritative, high-quality references around a keyword, species, method, or research direction.** It combines broad discovery with DOI-level metadata reconciliation, citation-aware ranking, open-access full-text links, and evidence-level labels, making it useful for literature scans, proposal preparation, manuscript references, and identifying the strongest starting papers in an unfamiliar field.

The tool helps locate and organize high-quality evidence; it does not automatically certify a paper as authoritative. Source coverage, citation counts, study design, and the final inclusion decision should still be checked.

## Features

- Search OpenAlex, Crossref, Europe PMC, PubMed, DOAJ, arXiv, and CORE.
- Expand structured synonym sets across Chinese and English queries.
- Generate Taxonomy/MeSH/OpenAlex-based object layers and tag every record with `expansionLevel`.
- Resolve OA links through OpenAlex, Unpaywall, Europe PMC, and arXiv.
- Deduplicate by DOI and normalized title while preserving complementary metadata.
- Export CSV, TSV, BibTeX, Markdown, or JSON; group Markdown by evidence layer.
- Run search → OA → export as one resumable pipeline.
- Run offline tests and live source probes.

## Requirements

Node.js 18 or newer. No runtime dependencies are required.

## Install as a Codex skill

Place this folder under your Codex skills directory, normally:

```text
$CODEX_HOME/skills/open-scholar-search
```

Invoke it explicitly with `$open-scholar-search`. Automatic discovery remains enabled by default.

## Quick start

```text
node scripts/pipeline.js -q "feeding frequency grass carp" --source openalex,europepmc --email "you@example.com" --out-dir output --name literature
```

Outputs:

```text
literature-hits.jsonl
literature-with-oa.jsonl
literature.csv
literature.bib
literature.md
literature-pipeline.json
```

Resume after an OA failure without repeating search:

```text
node scripts/pipeline.js --out-dir output --name literature --from oa --email "you@example.com"
```

Generate layered queries:

```text
node scripts/expand-query.js "Aeromonas hydrophila" --topic "vaccine OR immunity" --out expand.json
node scripts/api-search.js --expand expand.json --source openalex,europepmc --out hits.jsonl
```

## Search behavior

- Natural-language queries are adapted per source.
- Explicit field syntax, quotes, and boolean operators are passed through unchanged.
- Europe PMC, PubMed, and CORE default to title/abstract scope to reduce full-text noise.
- L2/L3 layers are smaller, use stricter fields, and sort by citations where supported.
- Timeouts, 429s, and 5xx responses are retried with exponential backoff. A source that still fails is skipped and recorded in `_warnings`.

## API etiquette and access

- Provide your own real email for OpenAlex/Crossref polite pools and Unpaywall. Unpaywall rejects placeholder addresses.
- Register a CORE key for stable access and set `CORE_API_KEY`.
- Respect each API's rate limits and terms.
- The browser extractor handles only public pages the user is authorized to view. It does not provide or encourage bypassing access controls.
- When KNS or another licensed source is unavailable, report that fact and use compliant alternatives.

## Tests

```text
node scripts/release-check.js
node scripts/selftest.js
node scripts/selftest.js --probe
```

The release check blocks likely private paths, real email addresses, private keys, and access tokens. The offline suite verifies deduplication, field merging, layer preservation, five export formats, and unknown-argument handling. Probe mode checks seven API sources and distinguishes unavailable sources from valid zero-result responses.

## License

Code is MIT licensed. Documentation and report templates are CC BY 4.0; see `DOCS-LICENSE.md`.
