# internship_aggregator

CS opportunities hub — aggregates internships, co-ops, fellowships, new-grad, research, and
part-time roles from ATS boards (Greenhouse now; Lever/Ashby planned), normalizes them into one
schema, dedups, filters to CS-relevant early-career roles, and stores them for search.

Design rationale and tradeoffs live in [DECISIONS.md](DECISIONS.md); measurements and audit
findings live in [research/](research/); shipped features in [FEATURES.md](FEATURES.md).

## Prerequisites

- PostgreSQL running locally, `DATABASE_URL` set (see `.env`)
- [Ollama](https://ollama.com) running locally for classification/extraction:
  `ollama serve`, with BOTH models pulled — classify and extract run different models by
  default (Decision 25): `ollama pull qwen2.5:14b-instruct` (classify) and
  `ollama pull qwen2.5:7b-instruct` (extract). Override with `OLLAMA_CLASSIFY_MODEL` /
  `OLLAMA_EXTRACT_MODEL` per pass, or `OLLAMA_MODEL` to force one model everywhere
  (e.g. for A/B reclassify runs).
- For recommendations (Decisions 29–32): the embedding model —
  `ollama pull nomic-embed-text` (default; `ollama pull mxbai-embed-large` too if running
  the eval bake-off; override with `OLLAMA_EMBED_MODEL`) — and the **pgvector** Postgres
  extension. Homebrew's `pgvector` formula only builds against postgresql@17/18, so on
  postgresql@14 build from source (no sudo needed on Apple Silicon):
  `git clone --branch v0.8.6 https://github.com/pgvector/pgvector && cd pgvector &&
  make PG_CONFIG=/opt/homebrew/opt/postgresql@14/bin/pg_config && make install
  PG_CONFIG=/opt/homebrew/opt/postgresql@14/bin/pg_config` — the migration runs
  `CREATE EXTENSION` itself.
- Node + npm

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run db:migrate` | Apply Prisma migrations to the local DB |
| `npm run db:generate` | Regenerate the Prisma client after a schema change |
| `npm run db:studio` | Open Prisma Studio (browse the DB) |
| `npm run discover` | Common Crawl board discovery (Greenhouse + Lever + Ashby) — finds and validates ATS board tokens, upserts them into `crawl_targets`. Lever auto-walks back to the newest crawl with real captures (its host blocks CCBot since Oct 2025 — see DECISIONS.md Decision 26); Ashby isn't CCBot-blocked, so it mines the latest crawl directly (research/ashby-source.md) |
| `npm run discover -- --source lever` | Discovery for one source only (`greenhouse` \| `lever` \| `ashby`) — skips paging the others' indexes |
| `npm run discover -- --limit 20` | Discovery capped to 20 candidates per source (smoke test) |
| `npm run discover -- --crawl CC-MAIN-2026-25` | Discovery against a specific Common Crawl snapshot instead of the latest (for Lever this also bypasses the walk-back) |
| `npm run refresh` | Full ingestion pipeline over every active `crawl_target`: fetch → normalize → delist-stale → dedup → filter → classify → extract → persist. Listings absent from a board's successful crawl are delisted (`is_listed=false`, kept in DB; see DECISIONS.md Decision 22) — failed crawls never delist. Unchanged boards are skipped cheaply via ETag/304 revalidation (Decision 23). Requires `ollama serve` running. |
| `npm run refresh -- --limit 5` | Refresh capped to 5 boards per source (smoke test) |
| `npm run refresh -- --full` | Ignore stored ETags and re-download every board — use after fixing a normalize bug, when stored rows must be rebuilt from bodies a 304 would skip |
| `npm run reclassify -- --dry-run` | Preview re-running the current classify prompt against all active listings (no writes). Run after any prompt change. Requires `ollama serve`. |
| `npm run reclassify` | Apply it: still-keeps get `opportunity_type`/`cs_field` updated and their location facets (`loc_countries`/`loc_us_states`) recomputed; new-rejects are delisted (kept in DB, `is_listed=false`) and remembered in `seen_listings` |
| `npm run reclassify -- --extract --limit 20` | Also re-run the extraction pass (grad dates / citizenship); `--limit` caps rows for a smoke run |
| `npm run serve` | Start the hub server on `http://127.0.0.1:3000` (or `PORT=…`): the search page (`/`), the JSON search API (`/api/search`), apply-status writes (`PUT /api/applications/:id`), the profile setup page (`/profile`), the For You view (`/foryou`), and the recommendation API (`POST /api/profile/resume`, `GET/PUT /api/profile`, `PUT /api/profile/questionnaire`, `GET /api/recommendations`). Requires PostgreSQL; Ollama only needed for profile extraction/publish — browsing and ranking are pure math and work with Ollama down. |
| `npm run enrich` | Recommendation enrichment pass over stale active listings: 7B role-signature distillation + embedding under the current config. Fingerprint-driven, resumable, safe to interrupt/re-run; also runs automatically (non-fatally) at the end of `npm run refresh`. Requires `ollama serve`. |
| `npm run enrich -- --limit 10` | Enrichment capped to 10 rows per sub-pass (smoke test) |
| `npm run eval:recommend -- sample` | Eval gate step 1 (Decision 31): draw the stratified ~200-listing sample into `research/embedding-eval/` |
| `npm run eval:recommend -- pool` | Eval gate step 2: distill + embed the sample under 5 approaches (2 embed models × signature/raw + skill-overlap), write rankings + the pooled labeling sheet `research/embedding-eval/labels.csv`. Requires `ollama serve`; ~30 min. |
| `npm run eval:recommend -- score` | Eval gate step 3, after YOU label `labels.csv`: pre-registered P@10 (strict primary), held-out final check, freshness-blend sanity, clustering + soft-preference diagnostics. Results feed `research/embedding-model-bakeoff.md`. |
| `npm test` | Run the test suite (`node:test`; no live DB or Ollama needed — all DB-touching stages are unit-tested against fakes) |
| `npm run build` | Type-check + compile to `dist/` |
| `npx tsx src/backfill-dedup.ts` | One-time cleanup: collapses pre-existing duplicate rows already in `listings` (see DECISIONS.md Decision 15) |
| `npx tsx src/backfill-locations.ts` | Re-derives stored location facets (`loc_countries`/`loc_us_states`) for ALL rows with the current resolver. Idempotent; run after any `location.ts` fix or dictionary widening — persisted rows never re-derive on their own. |
| `npx tsx src/seed-crawl-target.ts <source> <token>` | Dev-only: manually inserts one `crawl_target` row (e.g. `lever palantir`) for smoke-testing a source with no real discovery mechanism wired up yet. NOT how boards get discovered in production — `npm run discover` is the real path once a source has one. |

Note: `--limit` and other flags need the `--` separator (`npm run refresh -- --limit 5`), or npm
consumes the flag itself instead of passing it through.

Request pacing (Decision 27): discovery validation and refresh space board-level requests
to each ATS host by `ATS_MIN_INTERVAL_MS` (default 500ms); on a 429 the source pauses for
`ATS_429_PAUSE_MS` (default 60s). Both are env vars — no flags.

## Architecture

Per-source `fetch` + `normalize`, then a shared staged pipeline: `dedup` → `partitionBySeen` →
`filter` (regex routers + local model) → `extract` (local model) → `persist`. See
[DECISIONS.md Decision 9](DECISIONS.md) for why, and `src/pipeline/orchestrator.ts` for the
actual wiring.

<!-- Architecture diagram maintained by hand, not generated — see CLAUDE.md -->
