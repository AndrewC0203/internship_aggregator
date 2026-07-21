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
