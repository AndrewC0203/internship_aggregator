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

## Decision 19: Location facets — deterministic parser, arrays, model fallback deferred

Problem:
Filtering by US state (and by country outside the US) is a P0 product feature, but `location`
is free text: 762 distinct strings across 1,817 active rows, mixing "New York, NY", "London",
"US-VA-Arlington", "Toronto, ON", "Remote - US", regions ("EMEA", "Latam"), and multi-location
strings spanning several states AND countries at once. Measured shapes:
research/location-shape-analysis.md.

Options considered:

1. Model-only (extract pass adds state/country) — handles arbitrary text, but a 7B is
   confidently wrong on ambiguous city names (Cambridge/Portland/Vancouver), and a wrong state
   is invisible corruption of the filter; also costs model time per listing and a model sweep
   to backfill.
2. Deterministic parser only — pure code, testable, instant, backfills without model calls;
   failure mode is "unresolved → empty arrays" (visible, safe direction). Cost: a long tail of
   strings stays unresolved.
3. Deterministic-first with a model fallback for the unresolved residue, enum-constrained, run
   per distinct string.

Decision: Option 3 chosen by the user; only its deterministic half BUILT, fallback deferred by
measurement. `src/pipeline/stages/location.ts`: segments on `;`/`|`/case-insensitive " or ",
parens treated as token delimiters (annotation vs "(United States)"), `US-XX-` structured
prefix, then exact-token dictionaries with the ORDERING INVARIANT that Canadian province codes
are checked before US state codes ("Toronto, ON" trap — present in real data), then a
word-bounded prose scan of names only (never 2-letter codes). Ambiguous city names
(Cambridge/Vancouver/Portland/Springfield) are deliberately absent — unresolved beats a
coin-flip. Storage: `loc_countries[]` / `loc_us_states[]` scalar-list columns (migration
`20260827152220`), ARRAYS because single listings measurably span multiple states and
countries; raw `location` untouched (Decision 15 dedup key matches on it). Facets are computed
in persist() at the single write choke point — including the seenKeep refresh path, so an
upstream location edit can never leave stale facets — and unconditionally in reclassify's
keep path, which is the backfill.

Reason: the measured mess is dictionary-shaped, not judgment-shaped — the built parser
resolves 92.5% of rows to a country and gives 91.3% of US rows a state, and the 7.5% residue
is dominated by strings with NO place content ("Hybrid", "Remote", "Multiple Locations
Available") that a model reading the same string also couldn't resolve. The fallback earns
nothing today, so it stays unbuilt.

Tradeoffs accepted: dictionaries need occasional tending as new sources add vocabularies (the
coverage script in the research doc is the check). "Georgia" resolves to the US state, never
the country (corpus-appropriate bias; Tbilisi still maps to GE). Region strings
(EMEA/Worldwide) and bare "Remote" are unresolved by design — representing "remote anywhere"
as a first-class filter value is a UI/product question deliberately not smuggled into this
schema. If the model fallback is ever built, it must read the DESCRIPTION (e.g. "Flexible -
Any SpaceX Site" is US-only knowledge), not the location string.

Date: 2026-08-27

---

## Decision 20: Frontend stack — Fastify server-rendered HTML, no SPA framework

Problem: Phase 1 requires a search API + minimal UI, and no frontend stack was chosen
(PRODUCT.md left it explicitly undecided). This is a lock-in technology choice: whatever
renders the first page becomes the thing every later surface extends.

Options considered:

1. Fastify + server-rendered HTML — one process serves both the JSON search endpoint and the
   HTML page rendered from the same query layer; no build step, no bundler, vanilla
   progressive-enhancement JS. Failure mode: rich client-side interactivity (optimistic
   updates, complex state) gets hand-rolled if the UI grows.
2. Vite + React SPA over a JSON API — familiar to interviewers, scales to a real app; costs a
   second process, a build step, ~200MB of dependencies, and doubles the explainable surface.
3. Astro — islands middle ground; a third framework's conventions to defend, buying little
   for a single logged-out page.

Decision: Option 1 — Fastify + SSR HTML (user choice, 2026-08-27, from Claude's
recommendation).

Reason: Matches Decision 4's local-first single service — one process, one thing to run, one
thing to whiteboard. The search endpoint returns JSON and the page renders server-side from
the same query function, so the API the UI needs is the API the project promises, not a
parallel path. Under the recruiting deadline, zero build tooling is the fastest route to a
demoable end-to-end slice, and "I can explain every byte" is the interview criterion.

Tradeoffs accepted: No client framework means row-level interactivity (apply-status marking)
is hand-written fetch + DOM code; if the UI later needs real client state (saved views,
optimistic bulk edits), that's the point to revisit — the JSON API survives such a migration
unchanged.

Date: 2026-08-27

---

## Decision 21: Apply-status storage — separate `applications` table

Problem: The search page needs per-listing apply status (saved / applied / interviewing /
offer / rejected). That state is user-authored, but `listings` is pipeline-owned: the daily
refresh upserts every row by natural key, and reclassify can delist rows. Where user state
lives is a schema/migration decision.

Options considered:

1. New `applications` table — one row per listing the user has touched: listing_id (PK/FK),
   status enum, note, updated_at. One join at read time.
2. `application_status` column on `listings` — no join, but mixes hand-entered state into the
   table two pipelines upsert daily; a future multi-user split means a painful backfill.
3. Browser localStorage — zero migration, but status dies with the browser profile, can't be
   queried/sorted server-side, throwaway on multi-user.

Decision: Option 1 — separate `applications` table (user choice, 2026-08-27, from Claude's
recommendation).

Reason: Ownership boundary, same argument as Decision 12's seen_listings: tables are owned by
their writer. `listings` is written by the pipeline, `applications` by the human; neither can
clobber the other. A delisted listing keeps its application row (history survives freshness),
and when multi-user arrives the table grows a user_id column instead of forcing a listings
migration. `not_applied` is represented by row absence, not a stored default — the table only
holds listings the user acted on, so it stays small (dozens, not thousands).

Tradeoffs accepted: One LEFT JOIN on every search query (negligible at 1.8k rows, and the FK
is the listings PK). Status is keyed to the canonical row id: if dedup ever re-canonicalizes
a listing under a different row, the application row must follow — acceptable because
Decision 15's dedup never deletes canonical rows.

Date: 2026-08-27

---

## Decision 22: Staleness/delisting — snapshot-diff per successful crawl, zero grace period

Problem: Nothing ever set `isListed=false` when a posting disappeared from its board, so
active listings only accumulated — some of the ~1,600 "active" rows were dead postings with
dead apply links (flagged in research/first-clean-run-audit.md), a credibility problem now
that the search page exists. The core rule to implement: a listing is stale when its board
was crawled SUCCESSFULLY after the listing was last seen and the listing wasn't in the
response — absence from a failed or skipped crawl proves nothing.

Options considered:

1. Timestamp threshold ("lastSeenAt older than N days → delist") as a separate sweep —
   simplest query, but it violates the core rule by construction: a board that errored for
   N days (or was simply not crawled — `--limit` runs crawl a subset) would get its listings
   wiped by pure clock time, with no successful crawl ever contradicting them. A flaky board
   must not wipe its listings, so a wall-clock rule is disqualified regardless of N.
2. Snapshot diff per successful crawl, inline in the refresh loop — right after ONE board's
   fetch+normalize succeeds, flip `isListed=false` on that board's active rows whose
   `sourceExternalId` was absent from the response. Scoped per-board, so a run that crashes
   partway has only delisted against boards it actually crawled successfully; failed fetches
   take the catch path and never reach the delist call at all.
3. Run-level diff as a separate end-of-run command ("delist everything no successful crawl
   touched this run") — one bulk query, but it must reconstruct which boards succeeded after
   the fact, turns a partial/crashed run into a mass-delist hazard, and adds a second
   operational step that can be forgotten. The per-board version gets crash-safety for free
   from its scoping.

Sub-decision (grace period): NONE — one successful crawl without the listing delists it
immediately. A successful Greenhouse fetch is an authoritative full snapshot of the board
(single response, no pagination; fetch.ts treats a malformed/missing `jobs` field as an
ERROR, never as an empty board), so "absent from one successful crawl" literally means "not
on the board right now." Grace periods exist to hedge partial or untrustworthy responses;
with a full-snapshot source the hedge buys nothing and costs N more days of dead apply
links — and dead links are the exact credibility problem being fixed. The safety valve is
reversibility, not grace: a wrongly-delisted listing relists automatically on the next
successful crawl (below), so the worst case of a bad-but-well-formed empty response is one
crawl cycle of invisibility, not data loss.

Decision: Option 2, zero grace — `src/pipeline/stages/delist.ts`, called from the
orchestrator immediately after each board's successful fetch+normalize (and ONLY from that
success path — the catch branch never reaches it, which is where the "failed crawls prove
nothing" invariant physically lives). Independent of the batch/flush AI tail: delisting
needs only the board's raw `sourceExternalId`s, not classify/extract verdicts, so it doesn't
wait for a flush and survives an AI-tail crash. Gated per-source by a `supportsFreshness`
flag — true only for Greenhouse today, because the flag means "a successful fetch is the
WHOLE board"; Lever/Ashby must not get it until their (unimplemented) fetchers are confirmed
to paginate to completion.
(2026-09-08 update: Ashby implemented and flipped true — its posting-api returns the whole
board in one unpaginated response, verified live against a 780-job board; research/
ashby-source.md. Lever stays false: paginated, no whole-board ETag.)

Board→listings scoping: `Listing` has no FK to `CrawlTarget`, so the delist query is scoped
by `(source, company)`, with company derived fresh from the board's own normalized payload
each crawl (same no-guessing posture as Decision 11's company handling). New nullable
`CrawlTarget.company` cache column (migration `20260828142547`), refreshed whenever a
successful crawl resolves to exactly ONE company, exists for the empty-board case: a company
that pulls every posting returns a legitimate `jobs: []`, and with nothing in the response
to derive company from, only the cache can scope the delist. Two hard no-op cases: no fresh
AND no cached company (first-ever crawl of an empty board — nothing to act on), and an
AMBIGUOUS crawl (≥2 distinct companies in one board's response — dirty data; guessing or
falling back to the cache could delist the wrong company's rows, so it does nothing and
writes nothing). Chosen over storing `token` on `Listing` (more precise, but existing rows
have no token and can't be reliably backfilled, so it would fix only future postings — the
existing ~1,600 rows are the actual stated problem) and over no-cache (silently can't handle
the pulled-board case).

Reversibility (why relisting needs no code): delist flips `isListed=false` and touches
NOTHING else — crucially not `seen_listings`, which is classifier reject-memory (Decisions
12/18), and a staleness delist is not a classification verdict. When a delisted posting
reappears, `partitionBySeen`'s listings lookup (which ignores `isListed`) routes it as a
seenKeep, and `persist()`'s existing forced `isListed: true` — the exact path Decision 18
had to defend against for reclassify-rejects — is precisely the desired behavior here.
The Decision 18 asymmetry holds because the two delist flavors differ in `seen_listings`
membership: reclassify-delisted keys ARE there (reject-memory wins, row stays dead);
staleness-delisted keys are NOT (row relists through the normal pipeline).

Interactions verified: dedup self-healing (Decision 15) — a delisted canonical stops
matching dedup's `isListed: true` lookup, so a still-live duplicate surfaces as a new
canonical, possibly in the same run (delist runs pre-flush, so the flush's dedup lookup
already sees the flip); Application rows (Decision 21) — untouched, apply history survives
delisting by the table-ownership design; suppressed duplicates — delist diffs the RAW
normalized board output (pre-dedup, pre-filter), so a sourceExternalId that is live on the
board but suppressed/rejected by later stages still counts as seen and cannot cause its
canonical's wrongful delist... and non-CS rejects were never `listings` rows, so `notIn`
simply doesn't match them.

Tradeoffs accepted: (source, company) scoping delists across ALL boards sharing a company
string within a source — if discovery ever registered two Greenhouse tokens for one company,
board A's crawl could delist board B's rows until B's own crawl relists them (flappy, not
lossy; not observed in current data; the `token`-on-`Listing` design fixes it properly if it
ever materializes). A well-formed-but-wrong empty response from an ATS delists the whole
board for one cycle (self-corrects on the next successful crawl). The company cache trusts
payload-derived names; a company renaming itself mid-board ("Acme" → "Acme Inc") makes old
rows unmatchable by the new company string, orphaning them as permanently-active — same
staleness bug this fixes, at much smaller scale; acceptable because renames are rare and the
rows remain findable/fixable by query. Rows belonging to boards discovery has deactivated
(`isActive=false`) are never crawled, so they never delist — CrawlTarget pruning (Decision
11's open FIRST-DRAFT-MINE item) should delist a deactivated board's listings when built.

Date: 2026-08-28

---

## Decision 23: Conditional fetch — ETag/304 revalidation per board

Problem: The refresh sweep is now the wall-clock bottleneck: 3,187 active crawl targets
fetched sequentially at ~0.4–1.5s each is ~30–90 minutes per run, and the vast majority of
boards are unchanged day-to-day — but "unchanged" still must be *verified*, because as of
Decision 22 every successful crawl doubles as the absence-evidence that delists dead
postings. Skipping boards outright would silently skip freshness.

Options considered:

1. ETag conditional requests — store the validator from each full fetch on `CrawlTarget`,
   send `If-None-Match` next crawl; a 304 (measured: ~0.13s, 0 bytes, vs ~0.4s / 3.5MB for
   a large board) proves the body — and therefore the listing set — is unchanged, so the
   entire normalize/pipeline pass is skipped with freshness semantics fully intact.
   Verified live before building: Greenhouse sends stable weak ETags and honors
   If-None-Match with a real 304.
2. Concurrent fetching (~8-wide worker pool) — 5–10x wall-clock cut, but it IS the
   still-open GATED rate-limit posture toward Greenhouse (3,187 boards hammered 8-wide
   daily); must be decided deliberately, and stacks WITH option 1 later anyway.
3. Tiered crawl scheduling (quiet boards weekly) — Phase 2 scheduler territory; delays
   freshness on skipped boards by design, and buys little while option 1 is free.

Decision: Option 1 — new nullable `CrawlTarget.etag` column (migration `20260828150435`),
`fetchGreenhouse(token, priorEtag)` sends If-None-Match and returns a DISCRIMINATED UNION
(`{kind:"ok", jobs, etag} | {kind:"not_modified"}`, src/pipeline/types.ts). The union is
load-bearing, not style: a 304 represented as an empty jobs array would be indistinguishable
from a genuinely-empty board, and Decision 22 treats a genuine empty board as "delist
everything via the cached company" — the type makes that catastrophic conflation impossible
rather than merely discouraged. Orchestrator 304 path: bump `lastCrawledAt`/clear
`lastError`, bump `lastSeenAt` on the board's active listings (scoped by the Decision 22
company cache), skip delist (nothing can be absent from an unchanged set), skip
normalize/dedup/AI entirely. The etag is captured only from a fully-validated 200 — a
malformed response throws before the validator is surfaced, so a bad payload can never
poison the cache into 304-ing past a future valid body. `npm run refresh -- --full`
withholds stored etags to force re-downloads (needed when stored rows must be rebuilt from
bodies, e.g. after a normalize bug fix — a 304 skips exactly the content a rebuild needs).

Reason: it attacks the measured bottleneck (transfer + processing of unchanged boards)
without touching the GATED rate-limit posture — conditional requests REDUCE load on
Greenhouse rather than renegotiating it — and it composes with any future concurrency
decision instead of preempting it. Expected effect: an unchanged board costs ~0.13s and 0
bytes, so a mostly-unchanged daily sweep drops from ~30–90 min toward ~10–15 min
sequential, with ~40x bandwidth reduction.

Tradeoffs accepted: trusts Greenhouse's validator semantics — a server bug that 304s a
changed body would freeze that board's content AND suppress its delisting until the etag
next changes (bounded staleness, self-corrects; `--full` is the manual override). On a 304
the board's `seen_listings` reject keys get no `lastSeenAt` bump (that table has no company
column to scope by), so the future reject-pruning logic must treat `seen_listings.lastSeenAt`
as a LOWER bound on last sighting, not an exact one — documented in the orchestrator at the
304 path. seenKeep content sync is skipped on 304, which is exactly correct (unchanged body
= nothing to sync) but means the etag must be trusted for content freshness too, same bounded
exposure as above. Lever/Ashby fetch stubs accept-and-ignore `priorEtag`; their validator
support must be verified per-source when implemented.
(2026-09-08 update: Ashby verified — it sends a weak whole-board ETag (`W/"job-board:…"`)
and honors If-None-Match with a real 304, so `fetchAshby` sends `priorEtag` and Ashby is
the second live conditional-fetch source. Lever verified the other way in late Aug: its
ETag is page-scoped, so it stays out; see src/sources/lever/fetch.ts.)
(2026-09-09 crash-window fix: etags are now persisted only AFTER the flush containing that
board's listings, not eagerly at fetch time. The eager write had a window — crash between
a board's fetch and its chunk's flush stored the etag while its listings died unpersisted,
and the next run's 304 skipped past them until the board's content changed. Invariant: an
etag may only be stored once every listing it validates is durable; losing an etag costs
one re-download, storing it early can silently lose listings. `lastCrawledAt`/`lastError`
still write eagerly — crawl health doesn't gate ingestion. See pendingEtags in
src/pipeline/orchestrator.ts.)

Date: 2026-08-28

---
## Decision 24: Degree-status extraction — model field with quote-first grounding, store + surface, no write-time drop

Problem: Listings titled "Intern" were surfacing with student-facing grad years while their
bodies demand an already-completed degree — the audit (research/degree-status-audit.md) found
WhiteWater's "Data Science Intern - Summer 2027" stored as internship/class-of-2028 when its
text says "Bachelor's degree required" and literally describes itself as the next step *after*
their internship. Nothing in the pipeline modeled degree-completion status, and the worst
case never even reached the classify model: its title regex-fast-tracked it past Pass 1, so
only the extract pass ever sees 100% of keeps.

Options considered:

1. Cheap regex tier (like the YOE filter) matching "pursuing" vs "degree required" —
   rejected: unlike "N+ years" the phrasing space is wide open, and the audit showed the
   dominant *legitimate* pattern at quant shops ("Are pursuing a Bachelor's, Master's, or
   PhD...") shares its keywords with the violation pattern; a keyword regex false-rejects
   the best listings on the board.
2. New `degreeStatus` field on the extract pass (chosen) — same call, same
   abstain-when-unsure contract as citizenshipStatus, and extract is the only stage that
   runs on every keep including router-accepted ones.
3. Write-time drop when completed_required meets internship — rejected: 1 confirmed
   violation in 663 internships doesn't justify an invisible, unauditable reject; every
   other filter in the repo already follows "false rejects are invisible, keep-biased wins."

Decision: Option 2. `DegreeStatus` enum (pursuing / completed_required / unknown), nullable
`degree_status` column (migration `20260828192021`), extracted in Pass 2 and stored +
surfaced (search API field; "DEG REQ" badge in the UI only for completed_required — the one
state that contradicts an internship label). Boundary-guarded by `normalizeDegreeStatus()`
(junk → null, unit-tested) at the same seam as the grad-date validators.

The load-bearing implementation detail: a `degree_evidence` field sits BEFORE
`degree_status` in the extract schema, forcing the 7B to quote the description's degree
sentence before classifying it. Measured on the audit cases: without it the model anchored
on "Intern" in the title and returned "pursuing" for every posting (including WhiteWater,
twice, across two prompt phrasings); with it, WhiteWater → completed_required, DRW →
pursuing, no-degree-mention → null, and grad-date extraction unaffected. The evidence string
is discarded after the call — it steers generation, it is not stored. This is the same
title-anchoring failure Decision 14 hit with YOE, solved in-prompt instead of with a regex
because here the signal has no tight lexical shape.

Reason: extract-pass placement is the only spot that sees every keep; store-and-surface
keeps the mistake visible and reversible while write-time drops are neither; the
quote-first schema was the difference between 0/3 and 3/3 on the real cases, at zero extra
model calls.

Tradeoffs accepted: existing rows have null degree_status until an operator runs
`npm run reclassify -- --extract` (hours-long local model sweep — deliberately not run
unattended; it monopolizes Ollama on a 24GB machine). "unknown"/ambiguous postings (e.g.
Virtu's "advanced degree (preferably PhD)" alongside "graduate students") resolve by the
model's reading and may land pursuing — accepted, since only completed_required drives UI
warnings. One extra generated field per extract call (~a sentence of tokens) buys the
grounding.

Date: 2026-08-28

---
## Decision 25: Per-pass model split — 14B classify, 7B extract

Problem: The 7B-everywhere default (Decision 13) was forced by the 24GB M4 Pro's RAM
ceiling, which the M5 Max/128GB upgrade removed. Re-benchmarking on the new machine
(research/model-rebenchmark-m5max.md, 35 listings, both passes, both models, disagreements
adjudicated against posting text) showed the 7B keeping non-CS junk at scale: 8/35 classify
disagreements, 14B right on essentially all, every 7B error a false keep (~15-20% of active
hub rows extrapolated). Meanwhile the 14B's extract pass was 2.3× slower and produced the
benchmark's only hallucination (a grad window invented from a "Fall 2026" start term).

Options considered:

1. Split: 14B classify + 7B extract (chosen) — captures the decisive classify win at
   ~+0.33s/call (classify is prefill-bound, emits ~20 tokens; the M5 Max mostly erased the
   14B's prefill penalty), keeps extract on the model that didn't hallucinate.
2. 14B everywhere — simplest, better degree/grad sensitivity, but 1.7× sweeps (~3.4h) and
   accepts the #139-style grad-date hallucination risk on every extract.
3. Stay 7B everywhere — indefensible after the benchmark: confirmed false keeps (CSIS
   policy research, BVP VC analyst, help-desk IT, marketing internship) are hub-quality
   damage the reject-router can't catch.

Decision: Option 1. `chatJson` takes a per-call `model`; `passModel(pass)` in classifier.ts
resolves precedence per-pass env (`OLLAMA_CLASSIFY_MODEL`/`OLLAMA_EXTRACT_MODEL`) > global
`OLLAMA_MODEL` > defaults (14B/7B). The global override is preserved deliberately — bench
scripts and A/B reclassify runs need to force ONE model everywhere. Both models resident
together measured at ~22GB, fine on 128GB (impossible on the old machine — this decision
was hardware-gated, which is why it reverses Decision 13 without contradicting it).

Reason: the classify delta is decisive and nearly free; the extract delta was mixed on the
same sample. Splitting takes the win where it's proven and defers the extract-model
question until the degree-status backfill produces more ground truth.

Tradeoffs accepted: two models must be pulled (README updated); ~+9 min per full sweep;
per-pass envs add one more knob. The known 7B extract weaknesses stay for now (Zipline
"completed the second year" misread, IMC penultimate-year miss — see
research/degree-status-audit.md backfill results); revisit extract's model with more data.
A 14B reclassify sweep to purge the measured false keeps is the natural follow-up and is an
operator action (it delists — dry-run first).

Date: 2026-08-31

---

## Decision 26: Lever board discovery — Common Crawl mining with crawl walk-back

Problem: The Lever adapter (fetch + normalize) is live-ready but had exactly one manually
seeded board (Palantir). Decision 11 solved discovery for Greenhouse by mining Common
Crawl's URL index for board URLs; the open question was whether the same works for
`jobs.lever.co` — flagged as untested. Measurement (research/lever-discovery-common-crawl.md)
found a twist: Lever's CDN added a Cloudflare-managed robots.txt block on CCBot in late Oct
2025, so every crawl from CC-MAIN-2025-47 onward captures ONLY robots.txt. Crawls up to
CC-MAIN-2025-43 are rich (~1,600 unique board tokens each).

Options considered:

A. Common Crawl mining with a crawl walk-back (chosen) — mirror Decision 11, but instead of
   "use latest crawl," walk backward through crawls newest-first and use the first that
   yields real tokens (currently lands on CC-MAIN-2025-43). Reuses the whole existing
   discovery stack (CDX retry, live-API validation, upsert, CLI); one consistent mechanism
   across sources. Failure mode: token supply frozen at Oct 2025 — post-block Lever
   adopters are invisible until the P2 supplementary source fills the gap.
B. Community GitHub lists (SimplifyJobs-style) as primary — fresh and zero-infra, but
   inherits external curation/format/continuity, and it's already scoped as a P2
   SUPPLEMENTARY source (FEATURES.md), which is the right role for it: it patches A's
   post-Oct-2025 blind spot rather than replacing the defensible primary mechanism.
C. Manual seeding at scale — what Palantir got; does not scale past tens of boards.
   Effectively pre-rejected by Decision 11.

Decision: Option A. `src/discovery/lever.ts` implements token extraction plus
`mineFirstCrawlWithSignal`: iterate crawl ids newest-first (≤24), mine each, accept the
first yielding ≥25 unique tokens (robots-only crawls yield 0, healthy ones ~1,600 — any
threshold between works), else fall back to the largest yield seen. Walk-back chosen over
pinning CC-MAIN-2025-43 in code because a pin goes stale silently, while walk-back
self-heals if Lever ever unblocks CCBot; a dead crawl costs ~2 tiny CDX requests to rule
out. `--crawl <id>` bypasses the walk-back (operator knows best). Shared CDX plumbing
(retry/backoff, paging, collinfo) extracted from greenhouse.ts into `src/discovery/cdx.ts`
so Lever doesn't import from a sibling source. `--source <name>` added to `npm run
discover` so mining one ATS doesn't re-page the other's index. `jobs.eu.lever.co` (still
crawlable, ~74 EU boards) deliberately excluded — fetchLever only speaks api.lever.co, so
EU tokens would just 404 in validation; needs api.eu.lever.co support end-to-end if ever
wanted.

Reason: it's the only option that scales AND keeps one explainable discovery story
("web-scale index mining + live-API validation") across all sources, and measurement showed
the blocker (CCBot ban) is a freshness cap, not a viability kill: validation already makes
mined-list staleness safe by design. Smoke run (2026-09-08, --limit 15): walked back 10
dead crawls, landed on CC-MAIN-2025-43, 15 candidates → 5 valid boards upserted, 10
dropped, 0 errors; the manually seeded Palantir row was untouched (upsert on
(source, token)).

Tradeoffs accepted: discovery pool frozen at Oct 2025 (~1,600 candidates; expect several
hundred live after validation) and it only shrinks as boards die — the P2 GitHub-list
source is the designated gap-filler, not more CC mining. Each uncapped Lever run spends
~20 extra CDX requests ruling out dead crawls before finding signal. Politeness posture:
we never crawl the robots-blocked host — we read Common Crawl's archive from when crawling
was permitted, and validation hits api.lever.co, the documented public postings API, which
the block does not cover. Full ~1,600-candidate validation sweep remains GATED behind the
ATS rate-limit decision, same as Greenhouse's.

Date: 2026-09-08

---

## Decision 27: ATS rate-limit posture — fixed per-host delay (visible politeness)

Problem: Discovery validation and refresh hit three third-party posting APIs
(boards-api.greenhouse.io, api.lever.co, api.ashbyhq.com) with no throttling — only
`--limit` caps kept runs polite, which capped discovery at 163 Greenhouse boards and
gated Lever's ~1,600- and Ashby's 926-candidate sweeps (the project's top volume blocker).
All three APIs are public, unauthenticated, Cloudflare-fronted, and publish no rate
limits; the real failure mode of crawling too fast is not a 429 but silent IP-reputation
damage — an effectively irreversible posture toward hosts this project depends on.

Options considered:

1. Fixed per-host delay — constant minimum gap between requests to one host (default
   500ms = 2 req/s), sources parallel to each other, honor 429 by pausing that host.
   Simple, self-documenting politeness; no burst absorption; "slow" if board counts 10x
   (but slow costs nothing here).
2. Token bucket per host — sustained rate + burst allowance. Tunable and faster in
   spurts, but more machinery, and with no published limits the tuning is guesswork.
3. Adaptive (fast until 429, back off hard) — max throughput, but deliberately provokes
   rate-limit responses from Cloudflare-fronted hosts; exactly the reputation-risk
   posture to avoid. Ruled out.

Decision: Option 1 (user-chosen, matching my recommendation). `createRateGate` in
`src/pipeline/rate-limit.ts`, one gate per source (each source speaks to exactly one
host), wired into both the discovery validation loop and the refresh fetch loop.
`ATS_MIN_INTERVAL_MS` (default 500) and `ATS_429_PAUSE_MS` (default 60s) env-tunable.
A 429 skips that board/token and pauses the whole source's loop; discovery surfaces it
as a distinct `rate_limited` validation outcome so the pause is per-source, not per-token.

Reason: every crawl is a background job (monthly discovery, daily refresh), so throughput
buys nothing — measured: a full ~2,700-board discovery sweep at 500ms spacing is ~23 min,
and the AI classify/extract tail dominates any refresh that ingests new content by 1–2
orders of magnitude (hours of model time vs. minutes of paced fetches). The steady-state
daily refresh is ~15 min of fetches (Greenhouse/Ashby mostly 304 for ~free; Lever's full
re-download is its pagination's structural cost, not the throttle's). A constant delay is
also the easiest posture to defend: visibly polite to free APIs the project depends on.

Tradeoffs accepted: no burst capacity, and Lever's intra-board page requests (≤ a handful,
back-to-back) are NOT paced — the gate spaces board-level calls only; accepted since a
board is a short burst followed by a paced gap. The flat 60s pause stands in for
Retry-After (fetch errors don't carry headers; none of these APIs has been observed
sending it). If interactive re-crawls ever matter, the fix is raising one constant or
upgrading this gate to a token bucket behind the same `wait()` interface — not a redesign.

Date: 2026-09-09

## Decision 28: Dup residue policy — keep the exact dedup key, group variants at render time

Problem: 12.0% of active listings (218 rows in 137 clusters) share a (company, title) but
differ in location, vs the <5% dup target. The open question from Decision 15: is this
residue duplicates the key is missing (needing location normalization in the key), or
legitimate variants the key is correctly preserving?

Options considered:
1. Fold location normalization into the dedup key — (company, title, country+state facet)
   instead of raw string. Simulated dup rate: 0.8%. But measured cluster-by-cluster
   (research/dedup-key-simulation.md), it merges only 12 clusters, and ~8 of them are FALSE
   merges: SpaceX Hawthorne vs Palo Alto, Graphcore London vs Bristol vs Cambridge —
   different offices sharing a facet because facets stop at country/state granularity.
   Write-time suppression would silently destroy real city-level signal.
2. Collapse to (company, title) in the key. 0% dup by construction, but write-time drops
   Palantir NY vs CA as if they were one posting — worst version of option 1's flaw.
3. Keep the storage key exactly as is; group by (company, title) at RENDER time — one
   search-result card per role, N location chips, each variant row intact underneath.
   Location filtering still works on the stored facet arrays; the dup metric is redefined
   to what the user sees (cards), which is the thing the <5% target was a proxy for.

Decision: Option 3. Dedup key unchanged; presentation-layer grouping; dup metric measured
at card level.

Reason: The simulation reframed the problem — the residue is 11.7 points of true
geographic variants (131 clusters whose facets genuinely differ; Meridial's 6-country spam
facets to 6 different countries, so NO location normalization ever collapses it) and only
0.8 points of location aliasing (12 clusters, majority of which are false merges at facet
granularity). The assumed fix — normalization in the key — addresses almost none of the
problem and pays for it in silent data destruction, the exact failure mode Decision 9/15
were designed to avoid. Render grouping solves 100% of what the user experiences (one card
per role) while keeping every row queryable and reversible.

Tradeoffs accepted: (a) The listings TABLE keeps a 12% row-level "dup rate" — the metric
moves to the API/UI layer, so the README metric needs its definition stated to stay
honest. (b) Two same-titled postings that are genuinely different jobs (different teams,
same generic title) would group into one card; the card links out to each posting, so the
information survives one click away. (c) Cross-source company aliasing (Greenhouse
"Affirm, Inc." vs a prettified Lever slug) stays unsolved — measured at ONE cluster today,
deferred until it isn't negligible.

Date: 2026-09-11

## Decision 29: Recommendation embeddings — local Ollama model, not a paid API

Problem: The Phase 3 recommender needs an embedding model to place listings and the
user profile in one vector space. Stored vectors are model-specific: every listing
(1,832 active today) must be re-embedded on any model change, so the provider choice
is the sticky one; everything downstream (storage, ranking) is provider-agnostic.

Options considered:

1. Local via the already-running Ollama (nomic-embed-text / mxbai-embed-large class
   models) — free, private, offline, consistent with the local-first stack
   (Decision 4). Quality a notch below frontier APIs.
2. Paid API (OpenAI text-embedding-3 / Voyage) — best retrieval quality, but adds a
   key, a per-call cost, network dependency, and re-embedding cost on any future
   provider switch anyway.

Decision: Option 1 (user-chosen, matching my recommendation): local Ollama. The exact
model within Ollama is an implementation detail, to be picked by a quick bake-off on
real data (embed the corpus, check that known csField clusters separate) — reversible
by one batch re-embed, so not gated.

Reason: the corpus is small (low thousands) and homogeneous-by-construction, so
ranking quality hinges more on WHAT we embed (distilled signatures vs raw text) than
on marginal model quality. Local keeps the demo self-contained and free; the M5 Max
embeds the full corpus in minutes. If the project ever ships publicly, swapping to a
paid API is one config change plus one re-embed job — explicitly deferred, not
foreclosed.

Tradeoffs accepted: measurably weaker embeddings than frontier APIs; no cross-machine
reproducibility guarantee if the local model version drifts (mitigated: record model
name+version alongside vectors so a mismatch is detectable, not silent).

Date: 2026-09-12

## Decision 30: Vector storage — pgvector extension, exact search, no ANN index

Problem: Listing embeddings need to live somewhere queryable. This is the feature's
only schema migration, and the storage choice shapes how ranking queries compose with
the existing hard filters (grad year, citizenship, location, opportunity type).

Options considered:

1. pgvector `vector` column, exact (sequential) search via `<=>` cosine operator, NO
   ANN index — one extension + one column; similarity and SQL WHERE filters compose in
   one query; exact results.
2. Same but with an HNSW/IVFFlat ANN index — standard at scale, but approximate, adds
   index tuning, and buys nothing under ~100k rows.
3. Plain `Float[]` column + brute-force cosine in Node — zero extensions, but ranking
   leaves the database: every query ships all candidate vectors to the app, and
   filter-then-rank composition is hand-rolled.

Decision: Option 1 (user-chosen, matching my recommendation). Enable pgvector, add an
embedding column to `listings`, rank with the cosine distance operator directly in the
filtered query. Revisit an ANN index only if corpus growth makes ranking latency
observable (~100k rows, ~50x today's corpus).

Reason: at 1,832 active rows an exact scan is sub-millisecond-to-milliseconds — an ANN
index would add approximation error and tuning surface to solve a problem we measurably
do not have. Doing similarity in Postgres keeps one source of truth for
"filter by facts, rank by fit": the hard filters (Decision 19 location arrays,
grad-year columns, citizenship) and the vector ordering are one SQL statement, not two
systems glued in app code. And "why no ANN index" has a numbers-backed answer, which
is the defense this repo optimizes for.

Tradeoffs accepted: a required Postgres extension (breaks "vanilla postgres" if the DB
ever moves; all managed providers support pgvector). Prisma has no native vector type —
the column rides as `Unsupported("vector")` and similarity queries drop to
`$queryRaw`, a second query idiom in a codebase that otherwise uses the Prisma client.

Date: 2026-09-12

## Decision 31: Recommendation matching — symmetric distillation, gated by a labeled evaluation

Problem: How to rank listings against a resume + optional questionnaire (the Phase 3
differentiator). Naive whole-document cosine fails two ways: resumes and postings are
asymmetric document types (past-tense achievements vs requirements boilerplate), and
posting boilerplate (soft skills, benefits, EEO) appears everywhere, carrying no ranking
signal while pulling all scores together.

Options considered:

1. Asymmetric-light — embed raw descriptionPlain per listing; distill only the resume into
   a pseudo-job-description. Cheapest (no backfill); listing-side boilerplate stays in the
   vectors; the soft-skill noise problem goes unsolved.
2. Symmetric distillation — both sides distilled by the local 7B into one shared
   role-signature schema (technical skills / domains / level / focus, soft skills banned);
   embed canonical sectioned text (Experience vs Seeking kept distinct so interest in ML
   never reads as ML experience). Costs one extra 7B call per listing + a one-time
   backfill.
3. Field-wise multi-vector — separate embeddings per facet, hand-weighted cosine sum. Most
   control, but the weights are unprincipled magic numbers. Rejected for v1; the escape
   hatch if signature scores compress.

Decision: Option 2 (user-chosen, matching my recommendation), AMENDED after external
audit with an evaluation gate that must run before the full backfill: on a ~200-listing
stratified sample, compare signature embeddings against (a) a no-distillation baseline
embedding title + cleaned description and (b) a deterministic skill-overlap scorer, using
pooled user-labeled judgments and pre-registered Precision@10 (borderline = not relevant;
held-out slice reserved for a post-tuning final check). Field clustering is diagnostic
only — csField leaks into the signature text, so clustering would validate the leak, not
the ranking. If the baseline wins, ship it and amend this entry.

Reason: distillation attacks both failure modes at once (asymmetry + boilerplate noise) and
reuses the extraction discipline the pipeline already defends; the gate exists because the
distillation pass is the design's main recurring cost and "looks plausible" is not
evidence. Architecture invariant: facts filter (SQL), vectors rank (pgvector), labels
inform — model calls at write time only.

Tradeoffs accepted: one extra 7B call per listing forever; ~30–45 min of one-time human
labeling; the deterministic baseline (b) shares the signature model's skills, so the eval
tests embeddings-beyond-extraction, not the whole LLM pipeline; eval conclusions can
overfit the label set if re-tuned repeatedly (mitigated by the held-out slice, not
eliminated).

Date: 2026-09-12

**Gate outcome (2026-09-14, addendum):** the evaluation ran as pre-registered
(research/embedding-model-bakeoff.md has every number). GO — signatures stand, with
`nomic-embed-text` (primary strict P@10 tied 0.40/0.40 between sig models after the
dead-link label correction; secondary lenient tiebreak 0.90 vs 0.80 → nomic). The raw
baseline (raw:mxbai) won the primary by one item (0.50) but is DISQUALIFIED on the
pre-registered soft-preference MUST: it moved zero SWE listings (10→10) because
mxbai's 512-token truncation never sees soft answers appended to a ~750-token resume
query — the questionnaire's one soft mechanism would be structurally dead. Its edge was
also duplicate-inflated (a 3-row Tulip role family = 3 "relevant" hits that Decision 28's
cards collapse) and unconfirmed by the held-out slice (all approaches tied at n=7).
Two calibrations from the same labeled set: `W_FRESH` 0.15 → 0.05 (0.15 churned 4–6 of
top-10 with unjudged items — remake, not nudge; 0.05 churns 1–2 with zero
labeled-irrelevant entrants) and bands became RANK-based (labeled-class similarity
distributions overlap almost completely — irrelevant max 0.749 > relevant median 0.707 —
so absolute thresholds cannot honestly claim "strong"). Tradeoffs accepted: the verdict
leans on a disqualifier rather than a P@10 margin (margins at n=10 are 1–2 items — the
eval was sized to catch "clearly better/worse," and neither happened); the eval is
single-profile; full backfill proceeds under this config.

**Template v2 (2026-09-14, user-directed):** skills list removed from the embedded
profile text — the user judged resume skill lists overstated relative to demonstrated
experience, and in a single-vector design weight IS token share, so omission is the
honest "little weight" (Decision 31 already rejected hand-weighted multi-vector sums).
Screened against the labeled set before shipping: P@10 identical with/without the skills
sentence (0.60 strict / 0.90 lenient, judged projection), soft-preference intact (14→16).
Skills still drive matched-skills explanations and the overlap scorer. TEMPLATE_VERSION
1→2; the shared version bump also invalidates listing vectors (unchanged text, cheap
~3-min re-embed) — accepted over splitting per-side versions, which would add a second
gate for no measured benefit.

## Decision 32: Attainability — alignment chip + curated selectivity badge; no probability banding

Problem: User requirement — "someone with no projects shouldn't be pointed at Google."
Similarity measures direction of fit, not competitiveness, so this needs its own signal.
The v1 design (reach/match/safety bands from strengthScore minus role bar) died under
audit: subtracting a 1–5 rubric from years-of-experience has no common scale, and
"safety" asserts a hiring probability nothing in the system can estimate.

Options considered:

1. Requirements-alignment chip only (auditor's initial position) — grounded in extracted
   facts (YOE, degreeStatus), but cannot distinguish Google from a 40-person startup for
   interns: internship postings state near-zero formal requirements, so it silently drops
   the user's actual concern.
2. Alignment chip + hand-curated selectivity badge — (1) plus data/company-tiers.json
   marking only famously-selective employers. Badge wording carries no hiring claim
   ("Highly selective employer — manually curated"); unlisted companies are NOT ASSESSED,
   never implicitly less selective. Annotates, never filters.
3. Defer selectivity entirely to v2.

Decision: Option 2 (user-approved via audited review; auditor concurred after the pushback
in option 1's description). Chip wording is "No gaps found in checked requirements" — not
"meets requirements" — because we only check what we extract. The strength rubric is
DROPPED from v1: with banding gone it drove nothing, and it was model output + review work
with no consumer. Flagged: this defers the "rank my resume's strength" half of the original
ask until there's evidence a strength score changes decisions.

Reason: the honest version of the requirement is editorial, not probabilistic — a small
inspectable JSON beats a fake number; every label is traceable to shown facts or a curated
list with stated methodology.

Tradeoffs accepted: tier list is manual and will age; covers only famous names (long tail
unassessed); no per-user calibration of "reach" — the feature answers "is this company
famously selective", not "can I get in".

Date: 2026-09-12

## Decision 33: Semantic-ranked search — extend /foryou, not a second ranking path on /search

Problem: Wanted profile-based ranking reachable with a search box and more filters
(workplace type, curated-list) layered on top, matching what /search's facets already
offer. /search's filters are built on Prisma's typed query API; /foryou's ranking is
raw-SQL-only because pgvector columns are `Unsupported("vector")` in schema.prisma —
invisible to the typed client entirely. The two query engines don't compose for free.

Options considered:

1. Bolt a `rank=fit` mode onto /search — a second, raw-SQL translation of every
   `SearchParams` facet (type/field/workplace/state/country/gradYear) so cosine ranking
   can run alongside them. Matches the literal ask, but creates two copies of "what does
   type=intern mean" to keep in sync — a real drift risk (one path gets a fix, the other
   doesn't) on a project moving fast under deadline. Facet counts also get expensive or
   get dropped in ranked mode.
2. Extend /foryou — it already IS "ranked search with hard filters," just with a
   narrower filter set than /search. Widen `Questionnaire`/`hardConditions()` with the
   two missing facets and add a query box that, only when typed, triggers one ad-hoc
   re-embed of the stored profile (same stateless pattern /tryout already uses). Zero
   duplicate filter logic — reuses `hardConditions()`/`rankAgainst()` exactly as built.
3. Unify /search and /foryou into one query engine — rewrite /search's filters as raw
   SQL so one path serves both chronological and fit-ranked views. Architecturally the
   cleanest end state, but means rewriting a working, tested, DB-side-paginated page
   into /foryou's fetch-all-and-group-in-JS model (viable there specifically because the
   corpus is ~2k rows — see Decision 30's ANN-index tradeoff) for a payoff not clearly
   bigger than option 2's.

Decision: Option 2 (user-approved). `Questionnaire` gains `workplaceTypes`/`curatedOnly`,
parsed/persisted like every other field, but never surfaced in the /profile edit UI —
`/foryou`'s page sets them per-request via new options on `recommend()`, so clicking a
filter chip there never edits the approved profile or bumps its revision. The query box
REPLACES the Seeking: free text for that one request (never the stored `interests`,
never `profile.focus`); toggling workplace/curated is pure SQL and costs nothing, so
only a typed query pays for a re-embed — verified live (curl) that filter toggles are
instant while a query costs one Ollama round-trip.

Reason: the corpus-scale argument that already justified /foryou's fetch-all-then-JS-
group design (Decision 30: no ANN index needed at ~2k rows) is exactly why extending
that engine is the cheap path — it was already built to answer this kind of query.
Bolting ranking onto /search would have meant maintaining the same filter semantics
twice; unifying the two pages would have meant rewriting a page that isn't broken.

Tradeoffs accepted: ranking and chronological browsing now live on two pages instead of
one — a user who wants both filters AND simple recency sort still has to pick a page.
`/search`'s honest six-way `groupBy` facet-count machinery is not available on /foryou
(chips show state, not live counts) — acceptable since /foryou's chip set is small (3
workplace values + 1 toggle) and none of them are dynamic vocabularies like state/country.

Date: 2026-09-16

## Decision 34: Supersedes Decision 33 — ranking moves onto /search itself, "paste and go"

Problem: user pushback on Decision 33, same day. Two pages (chronological /search with
the full filter rail, ranked /foryou with a narrower one) is worse UX than one home
screen that ranks differently once it knows about you. The duplication cost Decision 33
was built to avoid was also smaller than estimated: most of `/search`'s facets were
already ported into `Questionnaire` for that decision, shrinking the real gap to two
filters (status join, free text) plus a second query engine.

Options considered (same three as Decision 33, re-weighed):

1. Rewrite /search's own filters onto raw SQL so ranking runs there directly — the option
   rejected in Decision 33 for creating two copies of filter semantics. Chosen this time:
   the duplication is bounded and explicit (`searchParamsToSql`, one function, parity
   asserted by test + a live parity sweep across every facet before shipping) rather than
   spread across the ranking algorithm.
2. Keep the two-page split, just improve /foryou's UX. Rejected: doesn't address the
   actual complaint (two places to look), and /foryou's narrower filter set was never
   going to reach parity with /search's without becoming /search.
3. Full unification (retire /search's DB-side pagination, one query engine for both
   sorts). Deferred: `rankedSearch` fetches-all-and-groups-in-JS (same ~2k-row
   justification as Decision 30/33), while the DB-side `groupBy` path stays for
   chronological browsing — the facet-count queries are shared unchanged between both
   (they don't depend on sort order), so this gets most of option 3's benefit without
   its rewrite risk.

Decision: Option 1, plus a bigger scope change the user asked for in the same
conversation — the resume-paste flow itself changes. Pasting on `/search` is now
"ephemeral by default": extract + embed happen immediately into an in-memory draft slot
(`draftCache.ts`), NOT `user_profile.resumeText/extractedProfile` (those still mean "the
human's in-progress draft on the /profile page" — conflating the two would mean a quick
paste into /search silently clobbers what /profile shows). `/search`'s default sort
becomes `fit` whenever a draft OR a previously-approved profile is active; an explicit
sort choice always overrides. A "SAVE AS MY PROFILE" action promotes the draft through
the existing `publishProfile` guarded-UPDATE — no new persistence mechanism, just a new
trigger for the one that already existed. `/tryout` is kept as a separate tool per the
user's explicit call, even though its stateless-testing use case now overlaps with
"paste on /search and just don't hit save."

Reason: matches what the user actually wants to do (paste a resume, see the board ranked
by it, still have every filter) more directly than routing them through a second page
with fewer options. The draft/approved split preserves the one invariant that matters —
"nothing downstream reads unapproved content" — while removing the ceremony of an
approval gate standing between pasting and seeing results.

Tradeoffs accepted, flagged open (not resolved this session):
- The approved profile's OWN persisted `Questionnaire` hard filters (work-auth,
  sponsorship, remote-ok) are NOT applied by `/search`'s ranked mode — only `/search`'s
  own filter rail is. `/foryou` still applies them. A user who set "needs sponsorship"
  on `/profile` and expects that respected everywhere will be surprised it isn't on
  `/search`. Candidate fix: port those three fields onto `/search`'s rail the same way
  workplace/curated were — not done here, scope was already large.
- `/foryou` and `/search`'s ranked mode are now two ranking views with different filter
  power (`/foryou`: full questionnaire incl. work-auth; `/search`: rail filters
  incl. status/curated-list but not work-auth) and no shared code between their WHERE
  translation (`hardConditions()` vs `searchParamsToSql()`). Whether `/foryou` should be
  retired, merged, or left as the "full-questionnaire" view is an open call for the user.
- In-memory draft does not survive a server restart — acceptable (re-paste is cheap, one
  extraction + one embed call) but worth knowing before relying on it across a deploy.

Date: 2026-09-16

**Addendum (2026-09-16, same day):** /foryou retired outright, accepting the work-auth
gap rather than closing it first — the user's explicit choice over porting those three
filters to /search's rail before removing the page. Removed: the `/foryou` route,
`render-foryou.ts`, `recommend()` (rank.ts's stored-profile wrapper — `rankAgainst()`
stays, still /tryout's ranking core), `/api/recommendations`, and
`parseRecommendOverrides`/`RecommendOverrides` (dead once both callers were gone). Left
in place, deliberately: `Questionnaire`'s `workplaceTypes`/`curatedOnly` fields and
`hardConditions()`'s branches for them — harmless (no-op when unset), still exercised by
existing tests, and the natural home if work-auth filters ever do get ported to
`/search`'s rail. `/tryout` untouched. Verified live: `/foryou` 404s, `/`, `/profile`,
`/tryout`, and paste-and-rank all still work; 314/314 tests passing after removing the
3 tests that covered the deleted `parseRecommendOverrides`.

## Decision 35: Template v3 — literal title line joins the listing embed text

Problem: Under Template v2 the embedded listing text was `Role:` (distilled level/domains/
focus) + `Requires:` (skills) — the LITERAL job title reached the vector only if the 7B
echoed it into `focus`. A discriminative title term the distiller dropped ("Site
Reliability", "Core Operations") was invisible to similarity, surfaced by the 2026-09-17
embedding-system review as the cheapest untested quality lever.

Options considered:
1. Keep v2 (the 1-item strict margin is within the bake-off's stated noise floor).
2. Promote v3: prepend `Title: {title}` to the listing text (bump TEMPLATE_VERSION,
   ~3-min corpus re-embed, profile re-approval to re-stamp).
3. Defer to a future larger-label eval round.

Decision: Promote (option 2). Gated first as an eval-only variant `sigt:nomic` against the
existing pooled-label harness, criteria stated BEFORE results: must beat sig:nomic on
strict P@10 (NDCG tiebreak) with the soft-preference MUST intact.

Reason: sigt won every measured axis — strict P@10 0.60 vs 0.50, NDCG@10 0.715 vs 0.652,
lenient tied 0.70, soft-preference 11→13 (same +2 responsiveness as sig's 14→16). The
entire strict gain is ONE mechanistically-explained swap: FeverUp "Becas de Excelencia"
(irrelevant, scholarship posting with an engineering-flavored signature) pushed OUT by the
title line; Virtu "2027 Internship – Core Operations Engineer" (relevant, pure title-term
pull) brought IN. No duplicate inflation (checked: Varda/DRW pairs are distinct roles;
the Cloudflare dead-link pair sits in both approaches symmetrically). Marginal eval cost
was 7 labels thanks to pooled-label carry-forward.

Tradeoffs accepted: The primary-metric margin is one item at n=10 — the same scale the
2026-09-14 bake-off called unresolvable noise (logged objection). Accepted because the
direction is corroborated by an independent position-aware metric (NDCG), the mechanism is
visible in the actual swap rather than statistical, the MUST is intact, and reverting is a
version-bump + 3-minute re-embed if a future larger eval disagrees. Also accepted: titles
re-introduce some marketing noise ("Rockstar Engineer") that distillation existed to
remove — bounded to one line of token share by construction.

Date: 2026-09-17

---

## Decision 36: Deployment split — serve-only goes public, Ollama-dependent stages stay local

Problem: User wants a real, live link for recruiting without taking on ongoing per-call
inference cost. The initial framing was "deploy everything except embedding," but that
undercounts the actual dependency: `classify`/`extract` (Decision 12/25, 14B+7B models,
~22GB resident together) run on local Ollama too, not just the enrichment embed step — so
excluding only embedding still leaves a deploy target that can't run the ingestion pipeline
without either a paid high-RAM host or a cloud LLM API (the exact per-call cost Decision 12
rejected: ~$8.8/day estimated at only 163 boards). Separately, Decision 3 (BullMQ + Redis)
was never implemented — `package.json` has no queue dependency; `discover`/`refresh`/
`reclassify`/`enrich` are plain npm/tsx scripts with no scheduler to migrate. Data volume
itself is a non-issue: 6,965 listings, 93MB total DB (checked live).

Options considered:

1. Serve-only public deploy — the Fastify hub (`npm run serve`: search/browse, `/profile`,
   `/tryout`, `/search` paste-to-rank) deploys to a free host reading a free hosted Postgres;
   `discover`/`refresh`/`reclassify`/`enrich` keep running on the operator's own machine
   against the same DB. $0/month. The plain-browse path never touches Ollama; the routes
   that do (resume upload, `/tryout`, paste-to-rank) already 503 gracefully via
   `ollamaDown()` (`src/server/recommend.ts`) when Ollama isn't reachable from the host —
   pre-existing behavior, not new work. Tradeoff: the public DB only updates when the
   operator's machine runs a refresh; if that machine is off for a while, the live listings
   go stale (recruiter sees whatever was last synced, not a live crawl).
2. Deploy the whole pipeline, including `refresh`/`classify`/`extract`/`enrich`, to a paid
   host with enough RAM for both Ollama models — real recurring cost ($20–80+/mo range for
   that much RAM on any current host), and turns board-scraping into a 24/7
   externally-facing job the ATS hosts could rate-limit against (Decision 27 pacing was
   tuned for a personal machine's cadence, not a public server's).
3. Swap `classify`/`extract`/`embed` to a cloud LLM API for the deployed pipeline only —
   reintroduces the per-call cost Decision 12 already measured and rejected, and gets worse,
   not better, as board coverage grows past 163.

Decision: Option 1. Verified current (2026-09, since pricing/free-tier terms shift and
shouldn't be asserted from stale knowledge): Render offers a real free web-service tier, no
card required; Railway and Fly.io no longer do (trial credit only). For Postgres, Neon's
free tier auto-suspends on idle and resumes transparently on the next connection; Supabase's
free tier pauses after 7 days idle and needs a manual dashboard click to resume — worse for
a portfolio link a recruiter might open sporadically. Picked Render (web) + Neon (DB).
`render.yaml` added (blueprint: `npm ci && npx prisma migrate deploy && npm run build` /
`npm start`). Fixed two real deploy-blockers found while wiring this up: the server bound to
`host: "127.0.0.1"` (unreachable from outside its own container — now `0.0.0.0`), and
`package.json`'s `main`/`start` pointed at a stale DB-smoke-test stub (`src/index.ts`), not
the real Fastify server — `npm start` would have connected to Postgres, logged a row count,
and exited without ever serving anything. Also added `postinstall: prisma generate` (a
clean `npm ci` on a new host has no generated client otherwise) and a `postbuild` step
copying `src/server/public` (the self-hosted font) into `dist/server/public`, since `tsc`
doesn't copy non-`.ts` assets. Verified live: compiled server builds, binds `0.0.0.0`, serves
`/` and `/api/search` with 200s; full suite (335/335) still passes.

Reason: This is free, fully reversible (delete the two accounts, nothing lost), and the
better interview answer of the three — "I kept inference local because that's the
cost-conscious call at this data volume, and the read/write boundary was already an
architectural invariant (README: browsing works with Ollama down) before I even needed to
deploy; I just drew the deployment line along it" beats either eating a recurring GPU-host
bill or reintroducing the per-call cost Decision 12 rejected.

Tradeoffs accepted: The public deploy's data freshness is bounded by how often the
operator's own machine runs `refresh` — no cron/scheduler enforces a cadence (Decision 3's
BullMQ was never built, and this doesn't revisit that). Resume upload / `/tryout` / paste-
to-rank will 503 on the deployed link whenever Ollama isn't reachable from Render, which is
always, since Ollama only runs locally — accepted; those routes were already built to
degrade this way. Neon's free tier has a real storage ceiling that hasn't been hit yet (93MB
against typical free-tier limits in the low-single-digit GB) but would eventually need
revisiting if the corpus grows an order of magnitude. Migrating off either free host later
is a connection-string/redeploy change, not a rewrite.

Date: 2026-09-18

**Addendum (2026-09-19):** Two enhancements added on top of the same free architecture, both
user-confirmed choices (not re-opening the core split):
- **Pre-seeded demo profile.** New `src/seed-profile.ts` — a one-off script (no HTTP round
  trip) that calls the existing `ensureProfileRow`/`publishProfile` (`src/recommend/
  profile.ts`) against whatever `DATABASE_URL` is set, from two new local-only,
  `.gitignore`d files (`resume.local.txt`, `questionnaire.local.json`, never committed).
  Run once against the Neon DB, this makes `/search`'s fit-sort work for every public
  visitor by default (Decision 34: fit-sort activates whenever an approved profile exists)
  with zero Ollama calls at request time — the operator's real resume/questionnaire content
  lands in the public `user_profile` row, a conscious tradeoff (reversible: clear the row to
  undo) chosen because the recommendation engine is the project's actual differentiator and
  was otherwise invisible on the live link.
- **Free keep-alive ping.** An external free ping service (e.g. cron-job.org) hits the
  deployed URL every ~10 minutes so Render's free-tier cold start (~30-60s after 15 min
  idle) never surprises a recruiter. No code change; pure operational config outside the
  repo. Accepted tradeoff: one more free third-party dependency to maintain, in exchange for
  a link that's always warm.

Explicitly deferred, not built: automating local `refresh`/`enrich` on a schedule (FIRST-
DRAFT-MINE scheduler-orchestration territory — Decision 3's BullMQ was never implemented and
this doesn't revisit that) and swapping the ingestion pipeline to a free-tier cloud LLM to
remove the local-machine dependency entirely (a real technology-choice-with-lock-in decision,
not taken here — see the Decision 36 body above for why it cuts against Decision 12/13/25's
local-model story).

**Addendum (2026-09-21): context-aware `ollama_down` messaging.** Every route gated on
Ollama (`/api/profile/resume`, `PUT /api/profile`, `PUT /api/profile/questionnaire`,
`/api/search/paste`, `/api/search/typed`, `/api/tryout`) previously 503'd with the identical
hint `"start \`ollama serve\`"` — correct advice locally, meaningless to a public visitor who
cannot start anything on the developer's machine. New `render.yaml` env var `PUBLIC_DEPLOY`
switches one shared constant (`OLLAMA_DOWN_HINT`, `src/server/recommend.ts`) to a public-demo
explanation instead; all four client-side error handlers (`render.ts` ×2, `render-profile.ts`,
`render-tryout.ts`) now display whatever hint the server sent rather than a hardcoded string,
so the wording lives in exactly one place. Requires the Render service's environment to pick
up the new var (redeploy, or add it manually in the dashboard if blueprint auto-sync is off).
