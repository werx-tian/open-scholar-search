# Examples

`sample-records.jsonl` contains fictional metadata and can be used without network access:

```text
node scripts/cnki-export.js -i examples/sample-records.jsonl -o output/sample.csv --format csv --sort expansion
```

`expand-aeromonas.json` shows a manual three-layer configuration:

```text
node scripts/api-search.js --expand examples/expand-aeromonas.json --source openalex --out output/expanded.jsonl
```

A complete pipeline run:

```text
node scripts/pipeline.js -q "Aeromonas hydrophila vaccine" --source openalex,europepmc --limit 10 --email "you@example.com" --out-dir output --name example
```
