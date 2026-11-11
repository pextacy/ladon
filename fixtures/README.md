# fixtures

- `corpus.json` — evaluation corpus for `pnpm eval` (benign real packages, local-only canaries, hallucinated names).
- `eval-results.json` — per-package results written by `scripts/eval.mjs` (summary in `docs/EVAL.md`).

Unit tests in `packages/*` stub their sources inline; there are no recorded registry responses here.
