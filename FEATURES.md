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
- Classification & extraction pipeline (Decision 12) — the filter/extract stages, finalized.
  A partition-by-seen step skips any listing already in `listings` or `seen_listing`; a cheap
  regex accept-router fast-tracks unambiguous CS internships (CS-token AND intern/co-op-token);
  everything else goes to a local Ollama model (Qwen2.5-14B-Instruct, 7B fallback, JSON-mode
  enforced) in two passes — classify (CS-relevance + opportunity_type), then extract (grad
  year / citizenship / deadline) on survivors only. Keeps are written to `listings`; rejects
  have their key recorded in a narrow, key-only `seen_listing` table so they aren't
  re-classified next run. Finalized spec: `finalized_decisions/classification-extraction.md`;
  model reasoning: `research/local-model-classification.md`.
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
- Reject-memory is KEY-ONLY (Decision 12): the `seen_listing` table stores only (source,
  external_id) for dropped listings — no description hash. Consequence: a reject is NEVER
  re-evaluated, even if the posting is later edited into scope. Accepted for simplicity.
- The regex accept-router must require a CS token AND an intern/co-op token together (e.g.
  "Software … Intern"). Matching "intern" alone would admit non-CS internships ("Marketing
  Intern") past the CS-relevance filter and violate Decision 10. High precision, deliberately
  false-negative-heavy — anything it doesn't accept (co-ops, "Summer 2026 Analyst Program",
  ambiguous titles) falls through to the AI.
- Two passes, not one combined call (Decision 12): extraction runs only on filter survivors,
  so separating the passes barely costs compute; the big initial classify run dominates cost.
- "Only the initial run is expensive" holds ONLY because rejects are stored — the reject
  majority (~90% of each fetch) is skipped by the partition step on every run after the first;
  steady-state, only genuinely-new postings reach the model.
- Local model chosen: Qwen2.5-14B-Instruct (Q4_K_M) via Ollama on the 24GB M4 Pro, 7B as the
  throughput fallback if the initial run is too slow. Enforce JSON output regardless of model.
  The extract pass must return null when unsure (existing deadline/citizenship rule) — carries
  over unchanged.