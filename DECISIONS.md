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

Status: NOT YET DISCUSSED — needed before Phase 1 adapters are built.

Problem: Greenhouse, Lever, and Ashby each return differently-shaped job data
(postedAt vs createdAt vs publishedDate, different field names for location, comp,
grad requirements, etc). Need a strategy for unifying them into one schema.

Options considered:

1.
2.
3.

Decision:

Reason:

Tradeoffs accepted:

Date:

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
extraction model is prompted to return null (or set an uncertainty flag on the date) when
it is not confident about a value. A null deadline is displayed as "unknown"; rolling /
open-ended deadlines are collapsed into the same "unknown" state.

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
extracted / uncertainty flag) but deliberately not surfaced in filter behavior yet —
options (b) and (c) remain available later if the extraction false-positive rate proves
high. Deadline data also feeds the freshness/quality score (a passed deadline signals a
dead listing), but that scoring logic is a separate, self-authored component and is not
designed here.

Date: 2026-07-17

---
