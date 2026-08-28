# internship_aggregator

CS opportunities hub — aggregates internships, co-ops, fellowships, new-grad, research, and
part-time roles from ATS boards (Greenhouse now; Lever/Ashby planned), normalizes them into one
schema, dedups, filters to CS-relevant early-career roles, and stores them for search.

Design rationale and tradeoffs live in [DECISIONS.md](DECISIONS.md); measurements and audit
findings live in [research/](research/); shipped features in [FEATURES.md](FEATURES.md).

## Prerequisites

- PostgreSQL running locally, `DATABASE_URL` set (see `.env`)
- [Ollama](https://ollama.com) running locally for classification/extraction:
  `ollama serve`, with the model pulled (`ollama pull qwen2.5:7b-instruct`)
- Node + npm

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run db:migrate` | Apply Prisma migrations to the local DB |
| `npm run db:generate` | Regenerate the Prisma client after a schema change |
| `npm run db:studio` | Open Prisma Studio (browse the DB) |
| `npm run discover` | Common Crawl board discovery — finds and validates ATS board tokens, upserts them into `crawl_targets` |
| `npm run discover -- --limit 20` | Discovery capped to 20 candidates (smoke test) |
| `npm run discover -- --crawl CC-MAIN-2026-25` | Discovery against a specific Common Crawl snapshot instead of the latest |
| `npm run refresh` | Full ingestion pipeline over every active `crawl_target`: fetch → normalize → dedup → filter → classify → extract → persist. Requires `ollama serve` running. |
| `npm run refresh -- --limit 5` | Refresh capped to 5 boards per source (smoke test) |
| `npm run reclassify -- --dry-run` | Preview re-running the current classify prompt against all active listings (no writes). Run after any prompt change. Requires `ollama serve`. |
| `npm run reclassify` | Apply it: still-keeps get `opportunity_type`/`cs_field` updated and their location facets (`loc_countries`/`loc_us_states`) recomputed; new-rejects are delisted (kept in DB, `is_listed=false`) and remembered in `seen_listings` |
| `npm run reclassify -- --extract --limit 20` | Also re-run the extraction pass (grad dates / citizenship); `--limit` caps rows for a smoke run |
| `npm run serve` | Start the hub server on `http://127.0.0.1:3000` (or `PORT=…`): the search page (`/`), the JSON search API (`/api/search`), and apply-status writes (`PUT /api/applications/:id`). Requires PostgreSQL; Ollama not needed. |
| `npm test` | Run the test suite (`node:test`; no live DB or Ollama needed — all DB-touching stages are unit-tested against fakes) |
| `npm run build` | Type-check + compile to `dist/` |
| `npx tsx src/backfill-dedup.ts` | One-time cleanup: collapses pre-existing duplicate rows already in `listings` (see DECISIONS.md Decision 15) |

Note: `--limit` and other flags need the `--` separator (`npm run refresh -- --limit 5`), or npm
consumes the flag itself instead of passing it through.

## Architecture

Per-source `fetch` + `normalize`, then a shared staged pipeline: `dedup` → `partitionBySeen` →
`filter` (regex routers + local model) → `extract` (local model) → `persist`. See
[DECISIONS.md Decision 9](DECISIONS.md) for why, and `src/pipeline/orchestrator.ts` for the
actual wiring.

<!-- Architecture diagram maintained by hand, not generated — see CLAUDE.md -->
