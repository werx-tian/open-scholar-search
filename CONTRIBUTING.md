# Contributing

1. Keep the runtime dependency-free and compatible with Node 18+.
2. Preserve unknown JSONL fields; `expansionLevel`, provenance, and `_warnings` must survive every stage.
3. Run `node scripts/release-check.js` and `node test/run.js` before submitting changes.
4. Do not add credentials, personal paths, private research caches, or scraper logic that bypasses access controls.
5. Document source-specific API behavior with a date and a reproducible probe.
