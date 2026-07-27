# Priority 0

- Greenhouse board discovery via Common Crawl (Decision 11) — a standalone discovery job
  (`npm run discover`) mines Common Crawl's URL index for `boards.greenhouse.io` /
  `job-boards.greenhouse.io` tokens, validates each against the live API (200 + non-empty
  jobs = keep), and upserts survivors into the `crawl_targets` table for the daily refresh
  to read. Per-source module (`src/discovery/`, Greenhouse real, Lever/Ashby stubbed);
  `--limit` caps the validation sweep until ATS rate limiting (GATED) is decided. Runs
  ~monthly (aligned to Common Crawl releases). See DECISIONS.md Decision 11.
- Opportunity-type classification & browse — classify each stored listing into an
  `opportunity_type` (internship, co-op, fellowship, new-grad, research, part-time) and let
  users browse/filter the hub by type. Core to the CS-opportunities-hub scope (Decision 10).
- CS-relevance write-time filter — only CS-adjacent opportunities are ingested; non-CS and
  non-opportunity roles are dropped before DB write (Decision 10).
- Application deadline capture — normalize a single `application_deadline` per listing,
  populated from Greenhouse's structured field where present and from AI extraction over
  `description_plain` otherwise (Lever, Ashby, and Greenhouse posts without the field).
  Core schema field; also feeds the freshness/quality score (passed deadline = likely
  dead listing). See DECISIONS.md Decision 7.
- Refresh pipeline wired to `crawl_targets` — orchestrator reads active `CrawlTarget` rows
  per source (populated by Decision 11 discovery) instead of a hardcoded list, and writes
  crawl health back (`last_crawled_at` on success, `last_error` on failure). Connects the
  discovery subsystem to the ingestion pipeline for the first time.
- Greenhouse company resolved from payload — `normalizeGreenhouse` reads `company_name`
  off the job payload instead of crawl-target config (which is slug-only per Decision 11).
  Closes that decision's open consequence; see DECISIONS.md Decision 11 resolution note.
- Listing upsert (persist stage) — upserts each listing on `(source, source_external_id)`:
  `first_seen_at` stamps once via schema default, `last_seen_at`/`is_listed` refresh on
  every run.

# Priority 1

- Deadline filter — let users filter listings by application deadline. Confirmed P1
  (low-usage/secondary facet — "most people don't filter by closing date").
- Citizenship / work-authorization filter — filter listings by work-auth requirement
  (sponsorship available / no sponsorship / US citizen required / unknown). The
  `citizenship_status` enum column is part of the v1 schema; the filter itself is P1.

# Priority 2

- Simplify GitHub repo as a supplementary discovery source — parse Greenhouse (and later
  Lever/Ashby) board tokens out of a community-maintained internship list (e.g.
  SimplifyJobs Summer/New-Grad repos) to catch companies the Common Crawl sweep misses.
  Deferred to v2: Common Crawl discovery (Decision 11) is the primary mechanism; this is
  additive coverage, not a dependency. Accepts that it partly overlaps CC's output (dedupe
  tokens before validating) and inherits the repo's format/continuity.

# Decisions to remember

- Deadlines have two confidence tiers: Greenhouse's structured field is authoritative;
  AI-extracted deadlines (from `description_plain`) are lower confidence. For now they are
  treated identically in filtering — revisit if false-positive rate is high.
- The extraction model must be prompted to return null when it is unsure about a date, to
  avoid false positives like mistaking a program end date ("program runs June 1 – Aug 15")
  for an application deadline. No estimated/uncertainty flag is stored — extracted and
  authoritative deadlines are treated identically (bets on ~90%+ extraction accuracy).
- Null deadline is shown as "unknown". Rolling / open-ended deadlines are collapsed into
  the same "unknown" state — the rolling distinction is intentionally not preserved.
- Deadline extraction reuses the same local-model pipeline as grad-year extraction; don't
  build a second extraction path for it.
- `citizenship_status` must be an ENUM, not a boolean — "US citizen required", "no
  sponsorship", "sponsorship available", and "unknown" are distinct states (citizenship ≠
  work authorization ≠ visa sponsorship); a boolean would mislead the international
  students the field is meant to help.
- Citizenship status is not a structured field in any ATS — it's extracted from
  `description_plain` via the same local-model pipeline as grad year / deadline.
- Null/unknown citizenship ≠ "no requirement" — most postings say nothing, and absence of
  a statement is not permission. High-stakes both directions (false "sponsors" wastes an
  application; false "citizens only" makes a qualified student skip a job).
- Scope is CS-adjacent only (SWE, data/ML, security, hardware, quant, PM…). CS-relevance is
  a HARD write-time filter — non-CS rows are dropped, not stored — so it's irreversible
  without re-crawling. `opportunity_type` IS stored (so type filtering is reversible at read).
- "CS-adjacent" is a fuzzy boundary (quant, PM, design) — the classifier makes judgment
  calls there; expect to tune it. Both CS-relevance and opportunity_type are classified by
  the same local-model pipeline (grad year / deadline / citizenship) — one path, not many.
- Must add / manually recrawl monthly.