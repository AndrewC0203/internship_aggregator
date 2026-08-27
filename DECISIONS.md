# Decisions

Formal record of GATED architecture/design decisions. See CLAUDE.md for the protocol —
Claude drafts Problem/Options, I write Decision/Reason/Tradeoffs myself.

---

## Decision 1: Backend language & framework

Problem: Need a language and web framework for the ingestion pipeline, adapters, and
search API.

Options considered:

1. TypeScript + Fastify — schema validation built in, plugin architecture, matches
   prior projects (FitOS, Muscle Map, arb scanner)
2. TypeScript + Express — largest ecosystem, no built-in validation/typing
3. TypeScript + Hono — modern, edge-compatible, smaller community
4. TypeScript + Next.js API routes — fullstack in one app, awkward fit for a
   persistent background scheduler
5. Python — would reinforce the concurrent CS-fundamentals roadmap, but unfamiliar

Decision: TypeScript + Fastify

Reason: Typescript familiarity, and schema built in + modern framework

Tradeoffs accepted: More familiarity with express / next.js

---

## Decision 2: Database

Problem: Storage for companies, jobs, sources, and refresh run history, queried by
both the API and the refresh job concurrently.

Options considered:

1. PostgreSQL — relational joins, built-in full-text search, requires running an instance
2. SQLite — zero-config, file-based, weaker at concurrent writes (API reads while
   refresh job writes)
3. MongoDB — schema flexibility for raw ATS payloads, weaker at the relational joins
   this project needs

Decision: PostgreSQL

Reason: Familiarity with postgres, relational database seems better for now until we verify the shape of data, better for large scale operations

## Tradeoffs accepted: N/A, clear

## Decision 3: Queue / scheduler

Problem: Something needs to re-run the ingestion pipeline on a schedule and handle
retries/failures per source.

Options considered:

1. Cron + polling — zero new infra, retry/concurrency logic hand-written
2. BullMQ + Redis — real job queue, built-in retry/backoff/concurrency limiting,
   failure dashboard (Bull Board), adds a Redis dependency
3. Managed cron (GitHub Actions / Railway) — no infra to run, coarser retry control,
   logs live outside the app

Decision: BullMQ + Redis

Reason: New framework, handles retries and limiting + better dashboard and similar time besides a small learning curve

Tradeoffs accepted: Simpler with cron + polling, and costs money

---

## Decision 4: Deployment target & service structure

Problem: Where and how the app runs while building, and whether frontend/backend are
one deployable unit or two.

Options considered:

1. Local only, single service (Fastify serves both API and built frontend) — simplest,
   no CORS, but the daily-refresh success metric goes untested until deployed
2. Cloud from day one — forces scheduling/env/logging to get solved early, setup
   overhead before any pipeline code exists
3. Hybrid — build locally, deploy just the scheduler early
4. Monorepo, separate frontend/backend packages — independent deploys, but two
   origins, needs CORS, more moving parts solo

Decision: Local-first, single service

Reason: Simplest to deploy at first, can setup later once get working product

Tradeoffs accepted: Harder to test metrics, need to figure out how to deploy later

---

## Decision 5: Data model / schema normalization

Problem: Greenhouse, Lever, and Ashby each return differently-shaped job data
(postedAt vs createdAt vs publishedDate, different field names for location, comp,
grad requirements, etc). Need a strategy for unifying them into one schema. See
`research/ats-api-comparison.md` and `research/ats-field-reference.md` for the raw
per-ATS shapes this normalizes.

Options considered:

1. Single normalized flat table — one row per listing with a common column set;
   ATS-specific extras dropped or flattened, and fields a source doesn't provide are
   AI-inferred/extracted at ingest. Simplest to query/filter; loses ATS-specific richness
   (Greenhouse dept hierarchy, Ashby multi-tier comp, multi-location).
2. Normalized core + raw JSONB — same core columns plus a raw payload JSONB per row to
   preserve the full original response for later re-derivation. Future-proof against schema
   changes; heavier storage and two places "truth" can live (normalized vs. raw drift).
3. Two-layer staging → transform — ingest raw per-ATS rows into staging tables, normalize
   into a reporting table in a separate step. Cleanest separation, replayable transforms;
   most infrastructure/complexity for a solo ~1-month build.

Decision: Option 1 — a single normalized flat table (`listings`), one row per source
listing. Columns:

Identity / provenance:
- `id` — integer surrogate, PRIMARY KEY (auto-increment IDENTITY). No business meaning;
  used for FKs/URLs. See Decision 5 discussion for surrogate-vs-natural-key reasoning.
- `source` — enum/text: greenhouse | lever | ashby | (other, extensible)
- `source_external_id` — text (the ATS's native id; stored as text to unify Greenhouse
  integer ids with Lever/Ashby UUIDs)
- `UNIQUE (source, source_external_id)` — natural key; the target of refresh upserts so a
  listing is never re-inserted across runs

Content:
- `company` — text (inline string; no separate companies table in v1)
- `title` — text
- `description_html` — text (canonical; for display — see Decision 6)
- `description_plain` — text (derived at ingest; for classification/search — see Decision 6)
- `location` — text (single primary location; multi-location intentionally dropped in v1)
- `department` — text (Greenhouse hierarchy flattened to a single string)
- `employment_type` — enum (e.g. full_time | part_time | intern | contract | temporary);
  provided by Lever/Ashby, inferred for Greenhouse
- `workplace_type` — enum (onsite | remote | hybrid); provided by Lever/Ashby, inferred
  for Greenhouse
- `comp_min` / `comp_max` — numeric, nullable
- `comp_currency` — text, nullable
- `comp_interval` — enum (hourly | monthly | yearly | one_time), nullable
- `grad_year_min` / `grad_year_max` — integer, nullable (AI-extracted)
- `citizenship_status` — enum (us_citizen_required | no_sponsorship | sponsorship_available
  | unknown); AI-extracted (see FEATURES.md decisions-to-remember). Filter is P1.
- `opportunity_type` — enum (internship | co_op | fellowship | new_grad | research |
  part_time); AI-classified, nullable (added by Decision 10). Coexists with
  `employment_type` (raw ATS value); overlap on intern/part_time is intentional.

Dates / lifecycle:
- `published_at` — timestamptz (source publish date; Lever createdAt epoch-ms converted)
- `application_deadline` — timestamptz, nullable (see Decision 7)
- `first_seen_at` — timestamptz (when we first ingested it)
- `last_seen_at` — timestamptz (updated every refresh the listing still appears)
- `is_listed` — boolean, derived from last_seen_at (soft-delete: a stale listing flips to
  false, the row is kept for history/dedup memory rather than hard-deleted)

Links:
- `url` — text (hosted/apply URL)

Reason: A single normalized flat table is the simplest model to build and query within the
~1-month solo timeline, and the easiest to defend end-to-end in an interview — every column
maps to a clear product need and every dropped/flattened field was a conscious tradeoff. The
richer options (raw JSONB, staging→transform) buy flexibility this project doesn't need yet
at a complexity cost the timeline can't afford.

Tradeoffs accepted: Chose the flat single-table model over raw-JSONB or a staging/transform
layer, accepting loss of ATS-specific richness: Ashby's multi-tier/multi-component comp is
collapsed to a single min/max/currency/interval; Greenhouse's department hierarchy is
flattened to one string; multiple locations are reduced to one primary. No raw payload is
stored, so re-deriving a field later (e.g. after fixing an extraction bug) requires
re-fetching from the source rather than reprocessing a stored blob. Several fields
(`employment_type` and `workplace_type` for Greenhouse, `grad_year_*`, `citizenship_status`,
some deadlines) are AI-inferred/extracted rather than source-authoritative — accepting
extraction-accuracy risk in exchange for coverage across all three ATSes. `is_listed` is
derived from `last_seen_at`; the staleness threshold and removal logic that consume these
timestamps are deferred to the freshness/quality-scoring component (FIRST-DRAFT-MINE) and
are not designed here.

Date: 2026-07-18

---

## Decision 6: Job description storage format (HTML vs. plain text)

Problem: Greenhouse's public Job Board post only returns description content as HTML
(`content`), with no plain-text variant. Lever and Ashby both return HTML and plain-text
variants natively. A locally-run AI model will be used to classify/extract structured
fields (e.g. grad year) from the description, and naive HTML tag-stripping (regex-removing
`<...>` without accounting for block-level tags) concatenates adjacent list items with no
whitespace between them (e.g. "...Bachelor's degree" + "Graduating in 2027..." becomes
"...Bachelor's degreeGraduating in 2027..."), which risks corrupting extraction — glued
digit sequences (grad year next to a salary figure or zip code) are a specific failure
case for a smaller local model. The same derived text would also be reused for future
full-text search indexing, where the same glued-word problem degrades match quality.
Need a decision on what to store and how the plain-text variant is produced for the one
ATS (Greenhouse) that doesn't supply it natively.

Options considered:

1. Store HTML only — single canonical column (`description_html`); derive plain text
   on demand at classification/search time. Avoids duplicate storage but repeats the
   tag-stripping work on every read and risks drift if the stripping logic isn't
   identical across call sites.
2. Store both HTML and plain text — `description_html` as canonical/raw (needed for
   display, since plain text can't be reconstructed back into HTML), `description_plain`
   derived once at ingest time via a shared normalization function (block-level tags
   converted to whitespace, HTML entities decoded) and persisted. For Lever/Ashby, the
   native plain-text field can be used directly or re-derived from HTML for consistency;
   for Greenhouse, it's always derived.
3. Store plain text only — simplest single-column schema, but permanently discards
   HTML structure/formatting fidelity from Lever and Ashby (both of which provide it
   natively), imposing Greenhouse's gap on all three sources instead of just one.

Decision: Option 2 — store both `description_html` and `description_plain`.

Reason: description_plain lets the classifier extract structured fields (e.g. grad year)
without HTML tags confusing the extraction, and description_html is kept so the posting
can still be displayed properly to users.

Tradeoffs accepted: Two columns to keep in sync instead of one — both must be written by
the same ingest-time normalization function, or the two can drift (e.g. HTML updated on
a refresh but plain text left stale). Storage cost is doubled but trivial at target scale
(thousands of listings). description_plain is a one-way derivation — if the stripping
logic has a bug, the original structure can't be recovered from the plain column alone,
only by re-deriving from the stored HTML. description_html still requires sanitization
before being rendered client-side (untrusted third-party content, stored-XSS risk) —
that work is separate from this decision and still outstanding.

Date: 2026-07-17

---

## Decision 7: Application deadline handling (structured vs. extracted)

Problem: Greenhouse's public Job Board post exposes a structured `application_deadline`
field (itself nullable — not every Greenhouse post sets it). Lever and Ashby have no
deadline field at all. Deadlines also frequently appear in free-text description bodies
across all three ATSes ("Applications due March 1", "rolling basis"). Need a strategy for
populating a single normalized deadline, and for how that value behaves in a
user-facing deadline filter given the two sources have very different reliability.

Options considered (population):

1. Structured-only — store `application_deadline`, populate only from Greenhouse's field,
   null everywhere else. Simplest and honest, but coverage is lumpy-by-source and thin.
2. Structured + extracted — populate from Greenhouse's structured field where present, and
   reuse the local AI extraction pipeline (the same one used for grad year) to pull
   deadlines from `description_plain` for Lever, Ashby, and Greenhouse posts lacking the
   field. Denser coverage, but text-date extraction introduces false positives (e.g.
   mistaking a program end date for an application deadline).
3. No dedicated column — treat deadline as prose inside the description only. Simplest
   schema, but can't sort/filter/badge by it.

Options considered (filter behavior, if extracted values are stored):

a. Treat extracted and authoritative deadlines identically in the filter.
b. Filter only on authoritative (Greenhouse) deadlines; show extracted ones as a
   display-only badge.
c. Let the user opt in to including extracted deadlines (toggle, default off).

Decision: Option 2 for population + Option (a) for filtering — store a single
`application_deadline`, populated from Greenhouse's structured field where present and
from AI extraction (over `description_plain`) otherwise. Extracted and authoritative
deadlines are treated the same for filtering, for now. To limit false positives, the
extraction model is prompted to return null when it is not confident about a value (no
separate uncertainty/estimated flag is stored — see tradeoffs). A null deadline is
displayed as "unknown"; rolling / open-ended deadlines are collapsed into the same
"unknown" state.

Reason: Extracting the deadline with an AI model (rather than leaving it Greenhouse-only)
gives denser, more consistent structured data, which helps flag stale listings (a passed
deadline signals a listing that is likely no longer active). It does not meaningfully help
deduplication. Missing dates are acceptable — most filtering won't be by date anyway, so
sparse coverage on this field is low-cost.

Tradeoffs accepted: Treating extracted deadlines the same as authoritative ones in the
filter means a wrong extraction can silently include a dead listing or exclude a live one
from filtered results — mitigated (not eliminated) by instructing the model to abstain
when unsure. Collapsing "rolling" into "unknown" loses a distinction some applicants care
about (rolling = apply ASAP), accepted because deadline filtering is a low-usage,
secondary facet. The confidence distinction is captured in data (authoritative vs.
extracted) is NOT stored as an explicit flag: for Greenhouse a stored deadline could be
either the structured field or an extraction and the two can't be told apart after the
fact; for Lever/Ashby a deadline is always an extraction, inferable from source. This
bets on the extraction model being high-accuracy (~90%+) and accepts that a wrong
extracted deadline can silently drop a live listing from a filtered view. Options (b)/(c)
(confident-only filter, or a user toggle) would require adding the estimated flag back
later. Deadline data also feeds the freshness/quality score (a passed deadline signals a
dead listing), but that scoring logic is a separate, self-authored component and is not
designed here.

Date: 2026-07-17

---

## Decision 8: Database access / migration tooling

Problem: Need a way to define the schema (Decision 5), run migrations against the local
Postgres `internship_aggregator` DB, and query it from the TypeScript/Fastify app. This is
a library-with-lock-in choice.

Options considered:

1. Raw SQL + a thin migration runner (e.g. node-pg-migrate, or `pg` + .sql files) —
   write real SQL, minimal abstraction, maximum understanding of what hits the DB.
   Slowest to build, most learning.
2. Query builder (Kysely, Drizzle) — typed, SQL-shaped TypeScript with migrations
   included; you still see the query. Light lock-in, moderate convenience.
3. Full ORM (Prisma) — define a schema file, it generates migrations + a typed client;
   most convenience and type-safety, most abstraction between you and the SQL. Most
   lock-in.

Decision: Option 3 — Prisma.

Reason: Prisma is a modern, convenient tool that's worth learning, and I'm running behind
on time so the velocity and generated typed client are worth it.

Tradeoffs accepted: Prisma abstracts away the SQL — the generated queries, connection
handling, and query planning are hidden, which is exactly the layer this learning project
would otherwise build fluency in. To keep decisions interview-defensible (esp. the
`(source, source_external_id)` upsert and the dedup queries, which are core), I need to
stay aware of the SQL Prisma generates rather than treating it as a black box. Accepting
Prisma's lock-in (schema DSL, client API) over the closer-to-SQL Drizzle option, in
exchange for speed.

Date: 2026-07-18

---

## Decision 9: Ingestion pipeline / module structure + dedup write handling

Problem: Three heterogeneous ATS APIs (Greenhouse, Lever, Ashby) each need fetch
(HTTP + per-source pagination/rate limits) -> normalize (raw -> unified Listing) ->
shared post-processing (dedup, internship filtering, AI extraction) -> persist. Need a
module structure that isolates per-source quirks, keeps the shared work in one place, and
defines what dedup does at write time given cross-source duplicates.

Options considered:

A. Adapter interface (strategy pattern) — each source implements a shared contract; one
   orchestrator loops adapters. Quirks isolated, shared logic written once; risk of a
   leaky interface when sources differ (e.g. pagination styles).
B. Per-source self-contained modules — each source does fetch+normalize+upsert end to end.
   Simplest, fastest first source; duplicates the upsert/orchestration logic across
   sources and lets them drift.
C. Staged pipeline — per-source fetch + pure normalize, then standalone shared stages
   (dedup -> filter -> extract -> persist) wired by an orchestrator. Each stage testable;
   clean insertion points; most files/ceremony.

Decision: Hybrid landing on C. Per-source `fetch` + pure `normalize` (3 separate modules,
because each ATS normalizes differently), feeding shared, separately-staged steps run by
an orchestrator in order: dedup -> internship filter (cheap regex pass, then AI model) ->
extract (grad year, visa status) -> persist. The stages are kept distinct (not one
"program") because they differ in shape (per-record vs cross-record) and tier
(classification is GATED, dedup is FIRST-DRAFT-MINE).

Dedup write handling: links, does not hard-delete (Option A storage — an array column on
the canonical row holding each suppressed duplicate's (source, external_id)). A duplicate
is not written while its canonical is active; once the canonical goes inactive, the next
refresh cycle writes the duplicate, so a still-live role resurfaces.

Reason: Option A is simple, and it self-heals: if Greenhouse's posting goes away, the next
cycle adds Lever's because the Greenhouse row is no longer active.

Tradeoffs accepted: Per-source normalization divergence is isolated; the shared tail avoids
B's duplication. Array-column dup storage is denormalized (bidirectional consistency
burden). Suppressing the duplicate write means a live role can be invisible for up to one
refresh cycle after its canonical goes stale, and only the canonical's apply URL is
surfaced at a time — accepted for simplicity. KEY INVARIANT for the (self-written) dedup:
only treat an incoming listing as a suppressible duplicate of a *currently-active*
canonical; if the canonical is inactive, write the duplicate. Still open / not decided
here: the exact array representation for the dup column and its migration (added when dedup
is built), the company/board list source (config vs DB table), rate limiting (GATED) and
retry/backoff (FIRST-DRAFT-MINE) inside fetch, and the classification/extraction approach
(GATED).

Date: 2026-07-18

---

## Decision 10: Ingestion scope & write-time filtering (CS opportunities hub)

Problem: The project was framed as an "internship" aggregator, but the real goal is a CS
opportunities hub spanning several opportunity types. ATS boards return ALL of a company's
jobs with no server-side filtering, so we must define (a) what's in scope and (b) where
filtering happens (write-time vs read-time).

Options considered:

1. Narrow — store only CS internships via a write-time hard filter. Smallest DB, cheapest
   extraction; irreversibly drops the fellowships/co-ops/new-grad roles the hub needs.
2. Coarse filter + tag — crawl broadly; at write time keep only CS-adjacent early-career
   opportunities across the in-scope types, store `opportunity_type` as a category, and
   filter type at read. Reversible for type; larger fetch volume + classification cost.
3. Store everything, categorize at read — max flexibility; infeasible at aggregator scale
   (a board returns hundreds of unrelated senior/FT/non-CS roles).

Decision: Option 2.
- In-scope opportunity types: internship, co-op, fellowship, new-grad, research, part-time.
- Field scope: CS-adjacent (SWE, data/ML, security, hardware, quant, PM, etc.).
- Crawl broadly. Write-time filter keeps a row only if it is BOTH CS-adjacent AND one of
  the in-scope opportunity types; everything else is dropped before write.
- `opportunity_type` is stored as a category (classified). CS-relevance is a hard
  write-time filter, NOT stored as a column.
- This refines Decision 9's "internship filter" stage into a "CS-opportunity filter +
  opportunity_type classification" stage (still GATED; algorithm undecided).

Reason: The original project goal was a CS opportunities hub (internships, fellowships,
etc.) for CS students, not internships alone.

Tradeoffs accepted: Non-CS and non-opportunity roles are dropped irreversibly at write —
recovering them means re-crawling and re-classifying (fine; they're out of scope). Broad
crawl raises fetch volume and classification cost vs. a curated company list. "CS-adjacent"
is fuzzy, so the classifier makes judgment calls at the boundary (quant, PM, design). The
ATS-provided `employment_type` and the new classified `opportunity_type` overlap on
intern/part_time — exact enum + relationship finalized in the Decision 5 schema update.

Amendment (2026-07-27, see Decision 12): "dropped irreversibly at write" is refined — the
dropped listing's full content is still not stored, but its natural KEY (source,
external_id) is now persisted in a narrow `seen_listing` table so the daily refresh can skip
re-classifying it. "CS-relevance is NOT stored as a column" continues to hold: there is no
relevance column on `listings` and no non-CS content is stored; only the reject key is kept,
as skip-memory.

Date: 2026-07-18

---

## Decision 11: Crawl-target discovery & storage (how boards are found and where the list lives)

Problem: The orchestrator crawls a list of `{token, company}` targets, but that list is
empty (`targets: []`). Two coupled questions: (a) how do we DISCOVER which Greenhouse boards
to crawl — there is no official directory of customers, board tokens aren't guessable from
company names, and hitting the "thousands of active listings" metric needs several hundred
boards — and (b) WHERE does the resulting target list live (source-code array vs config file
vs DB table). See `research/greenhouse-board-discovery.md` for the discovery-source
comparison.

Options considered (discovery):

A. Curated static list only (~20–100 hand-picked boards) — cheapest, fully controlled;
   plateaus below the listings metric and never finds companies you didn't think of.
B. Seed from curated GitHub lists (parse tokens out of e.g. SimplifyJobs repos) — near-zero
   effort, hundreds of relevant companies fast; inherits someone else's list quality and
   repo format/continuity, and is essentially reading another project's work.
C. Common Crawl discovery + validated refresh set — query CC's URL index for
   `boards.greenhouse.io/*`, extract + dedupe tokens, validate each against the live API
   (200 + non-empty jobs = keep), feed survivors into the crawl set. Most complete and most
   defensible; most engineering; the validation sweep is high-volume (surfaces the GATED
   rate-limit question) and CC's snapshot is weeks-to-months stale.
D. Dictionary brute force against the API — ruled out: ~100k requests for a few hundred
   hits, and mass-404 sweeps are the most plausible way to get IP-blocked.

Options considered (storage):

1. Hardcoded array in source (`src/config/targets.ts`) — simplest, zero infra; can't absorb
   a discovery feed of thousands of tokens, no per-target runtime state.
2. Checked-in config file (JSON/YAML) — out of TS, git-diffable; same deploy-to-change cost.
3. DB table (Prisma `CrawlTarget` model) — needs a migration + seed path; supports
   per-target state (enabled/disabled, last-crawled-at, last-error) and absorbs a discovery
   feed without code changes.

Decision: Discovery = Option C (Common Crawl), storage = Option 3 (DB table). One combined
entry. A Common Crawl discovery job produces candidate tokens, each validated against the
live API, and validated targets are stored in a DB table that the daily refresh reads from.
Simplify-repo scraping (Option B) is deferred to v2 as a supplementary discovery source
(see FEATURES.md P2), not the primary mechanism.

Reason: Common Crawl is the only feasible way to discover thousands of companies without
brute forcing or copying Simplify's repo. Slug discovery is more valuable than a curated
list because most companies posting on Greenhouse will have postings year-round even if a
SWE internship isn't always up, so a broad discovered set keeps yielding roles over time.
The DB table is required because a discovery feed of thousands of validated tokens can't be
hand-maintained in a source array.

Tradeoffs accepted: Dealing with more stale postings (CC's snapshot lags, so newly-created
boards are missed until the next monthly index and dead tokens must be validated out), more
time / complexity to implement the Common Crawl discovery job, and potential rate limits
with the ATS during the validation sweep. Coverage is not comprehensive — missing some
boards is acceptable, and the v2 Simplify source will cover additional companies later.
Worth it because it's the only feasible way to discover thousands of companies without
brute forcing or copying Simplify's repo. Note: the validation sweep pulls the GATED
rate-limiting decision forward for that job specifically (the daily refresh of validated
boards stays sequential/gentle); rate-limiting and retry/backoff inside fetch remain
undecided/self-authored.

Schema & structure (finalized 2026-07-23):

- Table structure: SINGLE `CrawlTarget` table with a `source` enum column
  (greenhouse | lever | ashby), not three per-ATS tables. Chosen for simplicity and to
  match the Decision 5 `listings` single-table + source-column convention (one model, one
  migration, shared pruning logic). A `source` column differentiates tokens, so three tables
  were unnecessary.
- File/module structure: PER-SOURCE discovery modules + an orchestrator (mirrors the
  fetch/normalize adapter layout), not one monolithic file. Chosen for maintainability and
  scale — avoids one file with three divergent if-branches; each source owns its Common
  Crawl query pattern + slug parser. Only Greenhouse is implemented now; Lever/Ashby stubs.
- Stale handling: DEACTIVATE, not hard-delete. A target not seen in discovery for ~2–3
  months is flipped `is_active = false` (row kept, consistent with `listings.is_listed`),
  not removed. The threshold + pruning policy itself is FIRST-DRAFT-MINE (freshness-adjacent)
  — user writes that logic; the column only stores the timestamp it reads.
- `company` is NOT stored on `CrawlTarget` — discovery is intentionally slug-only.
  OPEN CONSEQUENCE: the refresh path currently reads company from `Target.company` ->
  `NormalizeContext.company` (orchestrator comment: "payloads don't reliably carry it"), and
  `normalizeGreenhouse` uses `ctx.company`. With no company on the target, normalize must
  instead derive company from the job payload (`company_name`, which Greenhouse returns).
  Fine for Greenhouse; unverified for Lever/Ashby — resolve per-source when wiring refresh.
  RESOLVED (2026-07-27), Greenhouse only: `company_name` confirmed present in the real
  payload (GitLab capture, ats-field-reference.md). If it's ever missing/blank at runtime,
  `normalizeGreenhouse` drops that single job (returns null) rather than falling back to a
  token-derived name or throwing — chosen to avoid persisting a wrong/lossy company over
  losing one listing. `NormalizeContext.company` became optional as a result; Lever/Ashby
  still need their own resolution when their refresh path is wired.
- Indexing: NONE beyond the natural key for now — added later only if the pruning/refresh
  queries need them at scale.

Candidate columns:
- `id` — surrogate PK
- `source` — enum greenhouse | lever | ashby
- `token` — text, the board slug (the only field the discovery job writes)
- `is_active` — boolean, soft-deactivation flag
- `last_seen_in_discovery_at` — timestamptz, updated each discovery run the token appears +
  validates; the ~2–3-month pruning rule reads this
- `last_crawled_at` — timestamptz, nullable; updated by the daily refresh (crawl health)
- `last_error` — text, nullable; last refresh failure reason
- `UNIQUE (source, token)` — natural key; discovery re-runs upsert instead of duplicating

Once these columns are confirmed, the Prisma model + migration + per-source discovery file
scaffolding are FREE (migration/adapters from an agreed schema).

Date: 2026-07-23

---

## Decision 12: Classification & extraction approach (CS-relevance filter, opportunity_type, grad year / citizenship / deadline)

Problem: Decision 10 refined Decision 9's "internship filter" into a "CS-opportunity filter +
opportunity_type classification" stage but left the algorithm undecided; the extract stage
(grad year, citizenship, deadline from `description_plain`) reuses the same model pipeline
(FEATURES.md: "one path, not many"). ATS boards return ALL of a company's jobs, so the
majority of every fetch is out-of-scope. Need to settle four coupled sub-questions: (a) which
model runs the AI step and where it runs; (b) the shape of the cheap regex pre-pass; (c) one
combined AI call vs separate classify/extract passes; (d) how to avoid re-processing the same
listings — especially the majority-share rejects, which Decision 10 drops before write and so
would otherwise be re-classified on every daily refresh (the dominant cost driver).

Options considered:

(a) Model runtime —
  A1. Local instruct LLM via Ollama (one model does classify + extract + JSON). Free per call,
      no data egress, real "local model" learning; failure mode is throughput on consumer
      hardware.
  A2. Local zero-shot classifier (MNLI/cross-encoder) — fast for the type label but doesn't do
      extraction, so it fights "one path".
  A3. Cloud API (Claude Haiku) — fast, reliable JSON, no infra; per-run cost + external
      dependency. Cost analysis (this session): at ~163→several-hundred boards, ~90% of each
      fetch is rejects; if rejects are NOT remembered they re-run daily → ~5.9k+ calls/day ≈
      ~$8.8/day Haiku (~$4.4 batch), over the user's "<$1/day" bar. Only lands under $1/day
      (~$0.56) IF rejects are remembered (sub-question d), which cuts steady-state volume to
      genuinely-new postings.
  A4. Fine-tuned small encoder — best latency/accuracy, needs labeled data + a training loop;
      out of scope for a ~1-month build.

(b) Regex pre-pass —
  B1. Hard gate (regex drops before AI) — cheapest, but false drops on CS-relevance are
      irreversible (dropped rows are never written); "Summer 2026 Analyst Program" has no
      "intern" token. Rejected by user.
  B2. Cheap ACCEPT-router — regex fast-tracks only unambiguous CS internships, everything else
      falls through to the AI. Must be high-precision (false-negative-heavy OK). KEY
      CONSTRAINT: the accept condition must require a CS token AND an intern/co-op token
      together (e.g. "Software … Intern"); matching "intern" alone would admit "Marketing
      Intern" past the CS filter and violate Decision 10.
  B3. Seniority REJECT-router (drop "Senior/Staff/Principal/VP/Director") — safe, bigger
      volume-cut; considered, NOT adopted.
  B4. No regex — AI sees everything; simplest, max AI volume.

(c) Call structure — C1 two passes (classify, then extract on survivors) vs C2 one combined
    classify+extract call. Extraction only runs on filter survivors either way, so two passes
    only doubles work on the small kept set, not the big reject set.

(d) Reject-memory (skip already-processed listings) —
  D-none. Don't remember rejects — simplest state, but re-classifies the reject majority every
    run (see cost note above).
  D-A. Separate narrow table in the same Postgres (`seen_listing`, key-only) — no bloat on
    `listings`, one DB/migration/connection; consistent with Decision 2 (one Postgres) and
    Decision 4 (single service).
  D-B. Store rejects in `listings` with a relevance flag — no new table, but bloats the product
    table with null-heavy junk and contradicts Decision 10 ("non-CS rows are dropped, not
    stored").
  D-C. Separate datastore (second Postgres, or a Redis SET — Redis already present via
    Decision 3) — full isolation, but splits "what we've seen" across two sources of truth and
    adds operational surface.

Decision (factual record of the user's picks — 2026-07-27):
- Runtime: A1 local Ollama. Model chosen by Claude at the user's explicit request:
  **Qwen2.5-14B-Instruct (Q4_K_M)** as primary, **Qwen2.5-7B-Instruct** as the throughput
  fallback for the big initial run; JSON output enforced via Ollama structured output. Runs on
  the user's 24GB M4 Pro in the background initially, on a server later (Decision 4 path).
  Rationale + sizing/throughput math in `research/local-model-classification.md`.
- Regex: B2 accept-router with the CS-token-AND-intern/co-op-token constraint. B3 seniority
  reject-router NOT adopted.
- Call structure: C1 two passes (classify → extract on survivors).
- Reject-memory: D-A — a narrow, KEY-ONLY `seen_listing` table in the existing Postgres.
  Key-only means a reject is never re-evaluated even if its posting text later changes (no
  description hash).
- New pipeline stage: a partition-by-seen step before the filter (skips any listing already in
  `listings` OR `seen_listing`), so only the initial run is expensive.
- This AMENDS Decision 10: reject *keys* (source, external_id) are now persisted in
  `seen_listing` for skip-memory. Decision 10's "CS-relevance is NOT stored as a column [on
  `listings`]" still holds — no relevance column on the product table, no non-CS content stored.

Reason: _(your words — e.g. why local-only was worth the slower initial run, why key-only
reject memory over a description hash, why a separate table over a flag or a second store)_

Tradeoffs accepted: _(your words — e.g. multi-hour initial classify run on the Mac; rejects
never re-checked if a posting is edited into scope; a second table + a Decision 10 amendment;
accept-router misses non-obvious keeps (co-ops, "Analyst Program") and leans on the AI for
them)_

Date: 2026-07-27

---

## Decision 13: Local-model throughput — regex reject-router + 7B model

Problem:
The first full classify run was unusably slow and made the machine unusable. Measured
(2026-08-04, M4 Pro / 24GB, `research/local-model-performance.md`):
- `qwen2.5:14b-instruct` = 9.5 GB resident, 100% GPU. System free memory fell to ~21% with
  244k pageouts — the machine was swapping. Ollama keeps the model resident ~4 min after each
  call, so during a run it is effectively always in RAM.
- A classify call takes **7.41 s**, of which **87% is prefill** (6.42 s) and only 11% is
  decode (0.82 s). We send ~1,450 tokens and get back ~21. Decode speed — the number usually
  quoted for local models — is not the bottleneck; input volume is.
- On 2,008 real Greenhouse postings: median description 6,997 chars, and **68% exceed the
  `MAX_DESC_CHARS = 6000` ceiling**, so nearly every call is a maximum-size prompt.
- The Decision 12 accept-router fast-tracked **1 of 2,008 titles (0.05%)** — only 3 titles
  contained "intern"/"co-op" at all — so ~100% of listings reached the model.
- Implied: ~4.1 hours for the classify pass alone, before `extract()` runs a second call per
  keep. Consistent with the observed run that reached ~210 of 1,599 after several hours.
  (Caveat: sampled in early August, when summer-2027 internship postings are not yet up, so
  the 0.05% router rate may be partly seasonal.)

Options considered:
- A. Smaller model (7B / 3B). ~2x faster (prefill scales with parameter count); resident
  memory 9.5 GB -> ~5 GB. Costs accuracy on exactly the ambiguous population the routers
  defer to the model. One config line, reversible.
- B. Send less text (lower `MAX_DESC_CHARS`). Prefill is linear in input length, so
  6000 -> 2000 is ~3x on any model. Costs `extract` quality most — grad-year / visa /
  deadline signals often sit late in a posting.
- C. Cheap regex pre-filter that REJECTS before the model. Largest upside (most postings on a
  company board are experienced or non-CS roles) and the sharpest failure mode.
- D. Merge classify + extract into one call. ~2x on keeps; costs prompt clarity and makes
  extract's abstain-when-unsure discipline harder to enforce.
B and C are independent of A and compose with it.

Decision (2026-08-04): **C + A**, with a specific safety constraint on C.
- New `src/pipeline/stages/reject-router.ts`: `rejectRoute(title)` drops unambiguously
  out-of-scope titles (non-CS function, or seniority marker) before any model call.
- **An early-career veto runs first**: if the title contains intern / co-op / new grad /
  university / campus / apprentice / entry-level / fellow / graduate / PhD / student /
  trainee / rotational / a season word, the router NEVER rejects and defers to the model.
- **Regex rejects are NOT written to `seen_listings`.** They are dropped in-place every run.
- `OLLAMA_MODEL` default changes `qwen2.5:14b-instruct` -> `qwen2.5:7b-instruct`.

This AMENDS Decision 12, which recorded "B3 seniority reject-router NOT adopted" and named
the 7B as a fallback rather than the default. Both are now reversed, on measured evidence.

Measured effect of the reject-router on the same 2,008 real titles: **1,653 dropped (82.2%)**,
356 reach the model, and **0 early-career titles wrongly dropped**. A naive version without
the veto dropped 13 early-career titles, including "Associate Product Manager, New Grad
(2027 Start)" — a listing CLASSIFY_SYSTEM says to keep — killed on the token "manager".

Reason: _(your words — why a regex is allowed to make final reject calls that previously only
the model made; why the not-recording rule is the thing that makes that acceptable; why 7B's
accuracy loss is worth ~2x on the population that survives the routers)_

Tradeoffs accepted: _(your words — e.g. false rejects are invisible (no log line, no row) even
though they are now recoverable; the routers are tuned on an August sample with almost no
internship postings; `seen_listings` is no longer a complete record of every rejection; 7B is
weaker on exactly the ambiguous titles that reach it)_

Claude's objection on the record: none to C+A as scoped. The one flagged risk that remains
open is that both routers were tuned on a corpus containing 3 internship titles out of 2,008.
Re-validate `reject-router.ts` against an internship-heavy board in September before trusting
the 82% drop rate as steady-state.

Date: 2026-08-04

---

## Decision 14: Years-of-experience filtering (stop the early-career false keeps)

Problem:
The first real runs produced 3 keeps; 2 were wrong, all failing the same way — the local model
anchors on the TITLE and under-weights the stated experience requirement in the body.

| listing | stated requirement | 7B verdict | correct? |
|---|---|---|---|
| Junior Engineer @ 2K | "0–3 years (excellent fresh graduates are welcome)" | `new_grad` | yes |
| Researcher @ 2K | "2+ years of UX or other social science research" | `research` | NO |
| Data Analyst @ 1stdibs | "2+ years in data or product analytics" | `new_grad` | NO |

`CLASSIFY_SYSTEM` said "prefer null when unsure" but never stated that a years-minimum
disqualifies a role, so the title prior won. Separately, the MVP goal is to stop local-model
runs taking hours.

Measured on 90 real postings that survive the title reject-router (6 boards,
research/yoe-filter-analysis.md):
- 33 state no experience minimum at all
- 2 state a minimum of 0
- 7 state a minimum of 1
- 48 state a minimum of 2+
- 94% of "N years" matches sit next to an experience word, and ALL of the 6% that do not were
  still genuine experience requirements — so no proximity gate is needed.

Options considered:
- A. Body-level YOE regex, dropping before the model.
- B. Fold it into `extract()`, which already reads the body for grad year. Costs no extra call
  but buys correctness only, not speed — extract runs AFTER classify, so the model call is
  already paid for — and it moves a stage boundary (`extract()` would have to return late
  rejects for `persist()`).
- C. Add `min_years_experience` to the CLASSIFY schema; model extracts the fact, code applies
  the threshold. Same call, ~5 extra output tokens.
- D. Prompt-only fix naming the failure explicitly in `CLASSIFY_SYSTEM`.

Decision (2026-08-09): **A + D**, cutoff 0, drop the listing.
- New `src/pipeline/stages/experience.ts`: `minYearsExperience(text)` returns the SMALLEST
  stated minimum, or null. It is a FACT extractor; the threshold lives in `filter.ts`.
- Reads the FIRST number of a range: "0-3 years" -> 0 (keep), "2+ years" -> 2 (drop). This is
  load-bearing — a regex matching any number would drop the one posting of three we got right.
- Takes the MIN across matches (keep-biased): "0-3 required, 5+ preferred" -> 0.
- `MAX_YEARS_EXPERIENCE = 0` in `filter.ts`: any stated minimum >= 1 is dropped. `null` (states
  nothing) is NOT a drop.
- New tier 3 in the filter, between the title reject-router and the model. Drops are NOT
  recorded in seen_listings, same rule and same reversibility argument as Decision 13.
- Tier 1 (accept-router) still runs FIRST: an explicit "Software Engineering Intern" is kept
  regardless of body text, so an incidental "1 year program" cannot drop a real internship.
- D: `CLASSIFY_SYSTEM` now states that a stated minimum of 1+ years means NOT early-career
  regardless of title, that a range starting at zero does not disqualify, and that
  "Junior"/"Associate"/"Analyst"/"Researcher" are not themselves evidence.

Measured effect: model calls fall from 90 to 35 on the sample (39%), roughly a further 2.6x on
top of Decision 13. Verified on the three real postings: Junior Engineer reaches the model and
is kept; the other two are dropped by the regex before any model call.

Honest note on D: it fixed ONE of the two model-level errors (Data Analyst now returns null),
but NOT the other (Researcher is still classified `research` by 7B). A is what actually
guarantees both. D is a cheap second layer, not the fix.

Reason: _(your words — why dropping beats storing for the MVP, why cutoff 0 is acceptable when
it also drops "1+ years" roles a new grad could plausibly get, and why a regex is allowed to
overrule the model on this signal)_

Tradeoffs accepted: _(your words — e.g. 55 of 90 postings dropped without a model ever seeing
them; roles stating "1+ years" are lost even though many are new-grad-accessible; word-form
("one year") and month-form ("18+ months") minimums are not caught; tenure language ("401k
after 1 year") could read as a minimum if it is the only match in a posting)_

Claude's objection on the record: none to A+D as scoped — the not-recording rule keeps every
drop reversible, and the measurement supports the regex. The open risk is unchanged from
Decision 13: this was measured on an August corpus with almost no internship postings in it,
which is exactly the population where "must have completed 2 years of undergraduate
coursework" would cause a false reject. Re-validate in September.

Date: 2026-08-09

---

## Decision 15: Dedup key + duplicate-link representation

Problem:
`dedup.ts` was a pass-through, justified by "with only Greenhouse wired there are no
cross-source duplicates to find." True as written, but wrong in effect — every measured
duplicate is WITHIN Greenhouse. `research/first-clean-run-audit.md` (Finding 1) measured 21%
duplication (16 of 38 rows, later 21% of 71), against a <5% success-metric target. Two distinct
flavours needing different treatment:

```
PURE NOISE          6x Meridial :: AI Training Generalist, all location "United States of
                        America", different req IDs — the same posting, re-crawled duplicates.
GEOGRAPHIC VARIANTS  6x Meridial :: Social Media Annotation, US/UK/Canada/Australia/NZ/Ireland
                     2x Affirm   :: Software Engineer I, Remote Poland / Remote Spain
                        — genuinely different postings a student may want to see separately.
```

Decision 9 already fixed the write-time mechanism (link via an array column on the canonical
row, suppress only against a currently-ACTIVE canonical, never hard-delete) and left two things
open: the dedup KEY, and the array's concrete representation.

Options considered (key):

1. `(company, title)` — collapses both flavours above. Simplest, but wrongly merges every
   geo-variant into one row, hiding real country-specific postings from students in those
   countries.
2. `(company, title, location)`, exact string match (only `.trim()`'d, no case-folding or
   semantic normalization) — collapses only the pure-noise case, since geo-variants have
   different location strings by construction. Matches the audit's measured data exactly.
3. `(company, title, normalized_location)` — same as 2 plus mapping location variants like
   "USA"/"US"/"United States of America" onto one bucket. Solves a real but *separate* problem:
   the audit already flags `location` as 45 messy free-text strings needing its own decision
   (structured country column vs. read-time regex vs. extraction). Bundling it into the dedup
   key would make that call implicitly, by the back door.

Options considered (array representation, Decision 9's open item):

A. JSONB column on the canonical row (`duplicate_keys`, array of `{source, sourceExternalId}`)
   — matches Decision 9's "array column" language directly; one column, no new table.
B. A separate `ListingDuplicate` join table — more relational/queryable, but this array is only
   ever read/written as a whole by `dedup.ts`, never queried independently — a second table +
   migration is ceremony for an access pattern that doesn't need it.

Decision: Option 2 for the key, Option A for storage.

- New `duplicateKeys Json @default("[]")` column on `listings` (migration
  `20260825145125_add_duplicate_keys`), plus `@@index([company, title, location])` for the
  lookup `dedup.ts` runs on every refresh.
- `dedup.ts` groups the incoming batch by key, picks a deterministic survivor (smallest
  `sourceExternalId`, so re-runs converge instead of flapping), and checks a single batched
  lookup against ACTIVE `listings` rows sharing that key. Three outcomes: no active owner → the
  survivor proceeds as a (possibly new) canonical; the survivor IS the active owner (a
  seenKeep) → its history merges with any fresh in-batch siblings; a DIFFERENT active row owns
  the key → the survivor and its siblings are fully suppressed and folded into that row via a
  direct DB write.
- Self-healing (Decision 9's invariant) needed no special-case code: the lookup filters to
  `isListed: true`, so once a canonical goes inactive it stops matching, and the next listing
  sharing its key is treated as brand new.
- One-time backfill (`src/backfill-dedup.ts`) applies the same key to rows already in
  `listings` from before this feature existed — a fresh `dedup()` only prevents new duplicates,
  it can't retroactively merge two rows that already both have their own ID. Same rule:
  deactivate losers (`isListed = false`), never delete, fold their keys into the survivor.

Reason: Option 2 fixes exactly the measured problem with a one-line key function and zero
dependency on the still-open location-quality decision — it's the smallest change that gets
real duplicates down and leaves every legitimate geo-variant alone. Option A matches Decision
9's already-decided storage shape and avoids a second table for data that's never queried on
its own. `.trim()`-only normalization (no case-folding, no semantic location mapping) keeps the
key's behavior exactly as measured against the audit — anything smarter is Option 3, deferred
as its own decision so it doesn't quietly ride in on this one.

Tradeoffs accepted: Exact-string matching means near-duplicate location text ("USA" vs.
"United States of America" from different companies/sources) will NOT collapse — a false
negative, the safe-direction failure mode, but it means the <5% target depends on Greenhouse
locations staying reasonably consistent per company; a second source with differently-formatted
locations could reopen this. The DB lookup is one query per refresh across all of that batch's
keys (`OR` of up to N triples) — fine at the current/target scale (thousands of listings), would
need revisiting at much higher volume. `mergeDuplicateKeys` is a read-then-write, not
transactional — safe only because Decision 4 keeps the refresh single-instance/sequential; a
concurrent pipeline would need this in a transaction. The backfill is a one-time script, not a
migration — it must be re-run manually if a future bug reintroduces already-persisted
duplicates (it's idempotent, so re-running it is always safe, just not automatic).

Measured effect: 71 active listings, 21.1% duplicate under the old (company, title) metric.
Under the new (company, title, location) key: 3 real duplicate groups found (the known 6x
Meridial cluster, a second 2x Meridial cluster the audit didn't call out individually, and a 2x
Amtech Software pair) — all confirmed exact title+location matches, no geo-variant wrongly
caught. Backfill deactivated 7 rows; active count dropped to 64, all now unique under the new
key — **0% duplication**, against the <5% target. Note the (company, title) metric itself now
reads 12.5%, not because duplicates remain but because it's the wrong metric post-decision: it
counts every legitimate geo-variant as a "duplicate," which is exactly what this decision
rejected — post-Decision-15, (company, title, location) is the correct duplicate measure.

Date: 2026-08-25

---

## Decision 16: CS-subfield classification (`cs_field`) + IT-scope tightening

Problem:
Two related classify-prompt gaps. (1) No subfield: the hub can't answer "show me only ML
internships" — `opportunity_type` says *what kind* of opportunity, nothing says *what kind of
CS*. (2) IT scope was undefined: `CLASSIFY_SYSTEM` never mentioned IT/support roles, so the 7B
decided help-desk postings unguided, and manual/phone-support roles were leaking in as keeps.

Options considered:

1. Separate model pass for subfield — clean separation, but measured prefill economics kill
   it: 87% of a classify call is prompt prefill (~1,450 tokens in, ~21 out), so a second pass
   doubles model time to gain ~10 output tokens.
2. Add `cs_field` to the existing classify pass — same prompt tokens, one more field in the
   constrained JSON schema; marginal cost ≈ zero. Router-accepted listings never reach the
   model, so they get a deterministic title→field regex (`csFieldFromTitle`) instead.
3. Multi-label (array of fields) — more truthful for straddling roles ("ML SWE"), but the
   consumer is one-click UI filters; primary-label is simpler everywhere downstream.

Decision: Option 2, single-label. New nullable `CsField` enum column on `listings`
(`swe, ml_ai, data, quant, security, hardware_embedded, devops_infra, it, product, other`),
migration `20260827144421_add_cs_field_and_grad_dates`. IT tightening in the same prompt
revision: engineering-side IT (sysadmin, networking, cloud infra, IT security, automation) is
cs_relevant; service-side IT (help desk, desk-side, phone/ticket support) is not.

Reason: the subfield rides the call we already pay for, and the title-regex fallback keeps the
accept-router's no-model-call property while still filling the field for the highest-confidence
listings. Null vs `other` is kept meaningful on purpose: `other` = the model's confident
"CS-relevant but uncategorized"; null = nobody decided (regex had no token / model abstained /
row predates the field).

Tradeoffs accepted: single-label loses secondary fields ("ML SWE" shows under one filter, not
two) — revisit as multi-label only if users ask. The IT split now lives in prompt text, so it's
enforced by a 7B's judgment, not code; the reclassify dry-run is the check on how well it
lands. Prompt changes are not retroactive (rejects are never re-evaluated; keeps only via
`npm run reclassify` — Decision 18).

Date: 2026-08-27

---

## Decision 17: Grad-date representation — extract stated months, derive class year in code

Problem:
Postings state eligibility windows as month+year ranges ("graduating between September 2027 and
June 2028"). The extract schema forced bare integer years, so the model lossily truncated that
to `gradYearMin 2027, gradYearMax 2028` — wrongly presenting Spring-2027 grads (whom the
posting excludes) as eligible. Found by the user in real DB rows.

Options considered:

1. Term enums (`Fall`/`Spring` + year) — matches how students talk, but makes the MODEL do the
   month→term mapping, reintroducing inference exactly where a small model is weakest.
2. Extract the stated window verbatim as `"YYYY-MM"`/`"YYYY"` strings, then derive class years
   in code with one documented rule. Copying beats converting for a 7B, and the policy becomes
   testable TypeScript instead of prompt behavior.
3. Leave years as-is and note the inaccuracy — free, but the whole point of grad-year data is
   an eligibility filter; a filter that's wrong for every Fall-start window is worse than none.

Decision: Option 2 — the same fact-vs-policy split Decision 14 used for `experience.ts`.
New nullable `gradDateMin`/`gradDateMax` string columns (validated `YYYY-MM` or `YYYY`;
`src/model/grad-date.ts`), extraction copies what the posting states. `gradYearMin/Max` stay
but become DERIVED: graduation months Aug–Dec roll into the FOLLOWING class year (Sep 2027 →
class of 2028); bare years pass through unchanged (unspecified month ≈ Spring, which keeps its
calendar year). The motivating case now stores dates `2027-09`/`2028-06` and years 2028/2028.
A failed plausibility clamp on the derived year also nulls the stored date string — a fact we
don't believe shouldn't sit in the DB looking authoritative.

Reason: verbatim extraction is the easiest possible task for the model (copy, don't infer),
and keeping the raw months means the Aug-cutoff rule can be changed later and the year columns
recomputed for free, with zero model calls. Existing rows backfill via
`npm run reclassify -- --extract` (Decision 18).

Tradeoffs accepted: the Aug–Dec→next-class rule is a heuristic — a quarter-system December grad
or a posting that genuinely means calendar years can be mis-bucketed by one year (mitigated:
the stated string is preserved, so any future rule fixes re-derive without re-extraction).
"Unspecified means Spring" biases bare years toward including more students, the
keep-biased direction consistent with the rest of the filter stack.

Date: 2026-08-27

---

## Decision 18: Reclassify command — retroactive prompt application, delist-don't-delete

Problem:
Prompt changes are not retroactive by design: keeps live in `listings`, rejects in
`seen_listings`, and the pipeline never re-classifies either. So Decision 16's tightened prompt
(and any future prompt change) would only govern future postings, leaving stale verdicts —
e.g. already-kept help-desk rows — in the product forever.

Options considered:

1. Hard-delete rows the new prompt rejects — simplest, but destroys paid-for content and the
   audit trail of what the old prompt kept; contradicts Decision 9's delete posture.
2. Delist (`isListed=false`) + write the key to `seen_listings` — row preserved for audit,
   future crawls skip it via existing reject-memory. Requires one semantic change: a key can
   now be in BOTH tables, so `partitionBySeen` must check reject-memory FIRST (previously
   arbitrary order; keeps-first would let `persist()`'s seenKeep path force `isListed: true`
   and silently resurrect the row on the next crawl).
3. Delist only, no `seen_listings` row — avoids the partition change but is broken by that
   same resurrection path.

Decision: Option 2, as `npm run reclassify` (`--dry-run`, `--extract`, `--limit N`). Walks
ACTIVE listings only, sequential like every model loop. Still-keeps get `opportunityType` +
`csField` updated in place; new-rejects get the atomic delist+seen pair (one transaction, so a
crash can't leave the resurrection-prone half-state). `lastSeenAt` is never touched — a
reclassify is not a sighting. `--extract` additionally re-runs pass 2 for the Decision 17
backfill; `applicationDeadline` is fill-if-null only, since an existing value may be
Greenhouse's structured field (Decision 7) and the DB can't distinguish origin.

Reason: delisting keeps every reversal path cheap (flip `isListed` back / delete the seen key)
while reusing the existing reject-memory machinery instead of inventing a parallel one. The
partition ordering change is one line and encodes a defensible general rule: when memories
conflict, the most recent verdict wins.

Tradeoffs accepted: a reclassify-delisted key in `seen_listings` is permanent skip-memory like
any other reject — if the prompt later LOOSENS, those keys must be deleted manually to get
re-evaluated (documented in `src/reclassify.ts`). Rows delisted this way keep their content
(unlike pipeline rejects, which are key-only) — deliberate asymmetry, since the content was
already paid for and is the audit trail for prompt-change review. Dry-run before real run is
the expected workflow; verified live on 2026-08-27 (3-listing dry-run correctly delisted a
"Consumer Insights Intern" false keep and subfielded the two real keeps).

Date: 2026-08-27

---
