# Priority 0

- Search page + API + apply status (Decisions 20, 21) — `npm run serve` starts one Fastify
  process serving the SSR search page (`/`), the JSON search API (`/api/search`), and
  apply-status writes (`PUT /api/applications/:id`). Faceted filters (type, cs_field, US
  state, country, class year, application status, new-only) with honest facet counts (each
  facet's counts computed with its own selection removed), free-text scan over title/company,
  freshness-first default sort with a NEW-since-3-days queue section, keyboard triage
  (j/k + s/a/i/o/x/u/Enter), pagination. Apply status lives in the user-owned `applications`
  table (saved/applied/interviewing/offer/rejected; row absence = untouched). Visual world:
  "Dispatch Board" (CTC panel; direction contract in `src/server/render.ts`, DESIGN.md).
- Board discovery via Common Crawl (Decisions 11, 26) — a standalone discovery job
  (`npm run discover`) mines Common Crawl's URL index for board tokens
  (`boards.greenhouse.io` / `job-boards.greenhouse.io` / `jobs.lever.co`), validates each
  against the live API (200 + non-empty jobs = keep), and upserts survivors into the
  `crawl_targets` table for the daily refresh to read. Per-source module
  (`src/discovery/`, shared CDX client in `cdx.ts`; Greenhouse + Lever real, Ashby
  stubbed). Lever walks backward through crawls to the newest one with real captures —
  `jobs.lever.co` has blocked CCBot since ~Oct 2025, so recent crawls are robots.txt-only
  (Decision 26, research/lever-discovery-common-crawl.md). `--source` runs one ATS;
  `--limit` caps the validation sweep until ATS rate limiting (GATED) is decided. Runs
  ~monthly (aligned to Common Crawl releases).
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
- Incremental persist for the AI tail (2026-08-25) — the shared tail (dedup → partition →
  filter → extract → persist) now runs in `BOARD_BATCH_SIZE`-board chunks (env var, default
  10) instead of once over the whole crawl. A crash mid-run (OOM, kill, Ctrl-C) now only loses
  the current chunk; every prior chunk is already persisted. Was P1-deferred pending dedup v1
  (Decision 15) — unblocked the same day Decision 15 landed. See `src/pipeline/orchestrator.ts`
  for why chunking doesn't break dedup (the DB-lookup branch catches cross-chunk duplicates
  that the in-batch branch would have caught in a single-batch run).
- Lever adapter (`fetchLever`/`normalizeLever`, 2026-08-31) — second ATS source live in the
  `SOURCES` array (`src/pipeline/orchestrator.ts`), `supportsFreshness: false` (no
  whole-board ETag for paginated fetches). Discovery wired 2026-09-08 (Decision 26).
  See the dated section below for the field-mapping specifics.
- Retry with backoff for Ollama calls (2026-08-25) — `chatJson()` (classify + extract, since
  both share this one call site) now retries a TRANSIENT failure (network error, timeout, 429,
  5xx) up to `OLLAMA_MAX_RETRIES` times (default 3) with exponential backoff
  (`OLLAMA_RETRY_BASE_MS`, default 1s: 1s/2s/4s) before giving up on that one listing. A 4xx
  (bad schema, wrong model tag) is NOT retried — retrying can't fix a config bug. Mirrors
  `withCdxRetry` in `src/discovery/greenhouse.ts` (same shape, kept as a separate copy on
  purpose — see that file's comment on why retry stays scoped per layer). The existing
  per-listing try/catch in `filter.ts`/`extract.ts` is unchanged: it now only sees an error
  after retries are exhausted, so a listing is skipped (and retried next run, per Decision 12)
  strictly LESS often than before.

# Priority 1

- Deadline filter — let users filter listings by application deadline. Confirmed P1
  (low-usage/secondary facet — "most people don't filter by closing date").
- Citizenship / work-authorization filter — filter listings by work-auth requirement
  (sponsorship available / no sponsorship / US citizen required / unknown). The
  `citizenship_status` enum column is part of the v1 schema; the filter itself is P1.
- Keep years-of-experience as data (v1) — store the parsed minimum as a
  `years_experience_min` column instead of only using it to drop listings, and make the cutoff
  configurable rather than the hardcoded `MAX_YEARS_EXPERIENCE = 0` in `filter.ts`. That turns
  a write-time drop into a read-time filter (same reversibility argument as `opportunity_type`
  in Decision 10), and lets users choose "0 years only" vs "up to 2 years". Deferred from the
  MVP deliberately (Decision 14): the MVP goal was to shorten local-model runs, and dropping
  is what buys the speed. Requires a migration, so it is a data-model change to decide, not a
  refactor.

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
- AI-tail failure isolation (2026-07-27): classify/extract wrap each listing in try/catch
  (mirrors the per-board loop). A classify failure is NOT recorded as a reject — seen_listings
  is key-only and never re-checked, so a transient error would PERMANENTLY drop the listing;
  instead it's left unseen and retried next run. An extract failure keeps the listing (already
  classified) with null extracted fields.
- Seen keeps refresh SOURCE fields, not AI fields (2026-07-27 bug fix): the reject-memory /
  partition optimization skips AI *inference* on already-seen listings, but must still sync
  edited source content (deadline/title/location/description). Only the AI columns
  (opportunity_type / grad year / citizenship) are left frozen on a refresh.
- Trust model shape, not semantics (2026-07-27): a JSON-schema-constrained model guarantees an
  integer/string, never a plausible value. Extracted grad years are clamped to currentYear-1…+6
  (null outside); deadlines accepted only as strict YYYY-MM-DD (null otherwise). Ollama calls
  have a 120s timeout (OLLAMA_TIMEOUT_MS) so a hung request can't stall the sequential run.
- Dedup was a TEMPORARY single-source pass-through (2026-07-27) justified by "no cross-source
  dups to find" — SUPERSEDED 2026-08-25 (Decision 15): that reasoning was wrong, every measured
  duplicate was within Greenhouse. See "Within-source dedup" below.
## Local-model throughput (Decision 13, 2026-08-04)

- Regex REJECT-router (`reject-router.ts`) drops unambiguously out-of-scope titles before any
  model call. Measured on 2,008 real Greenhouse titles: 1,653 dropped (82.2%), 356 reach the
  model, 0 early-career titles wrongly dropped. This reverses Decision 12, which had recorded
  "B3 seniority reject-router NOT adopted".
- The EARLY-CAREER VETO is the load-bearing part: if a title contains intern / co-op / new
  grad / university / campus / apprentice / entry-level / fellow / graduate / PhD / student /
  trainee / rotational / a season word, the router NEVER rejects and defers to the model. A
  false veto costs one model call; a false reject costs the listing. Without the veto, a
  plausible first-draft regex killed "Associate Product Manager, New Grad (2027 Start)" on the
  token "manager" — a role CLASSIFY_SYSTEM says to keep.
- "fellow" is a VETO token, not a seniority token, even though "Distinguished Fellow" is
  senior — fellowship is one of our opportunity types, so the ambiguity must go to the model.
- Level suffixes (II / III / IV) are deliberately NOT seniority tokens: they read as senior to
  a human but mis-match too easily ("Tier II Support"), and a wrong reject outweighs the gain.
- **Regex rejects are NOT written to `seen_listings`** — they are dropped in-place every run.
  Rationale: `seen_listings` exists to memoize the EXPENSIVE model call; a free deterministic
  regex saves nothing by being memoized, while recording it would make the drop permanent
  (partitionBySeen never re-checks) and unauditable (key-only, no title stored). Not recording
  means a fix to `reject-router.ts` retroactively recovers listings on the next run.
  **Consequence: never route a `rejectRoute()` drop into `newRejects`.**
- AMENDS the earlier "only the initial run is expensive" note: that still holds for MODEL
  rejects (memoized in `seen_listings`), but regex-dropped listings stay permanently "unseen"
  and are re-fetched, re-normalized and re-regexed every run. That is intentional and cheap —
  the regex is free — but it means `unseen` stays large forever and `seen_listings` is no
  longer a complete record of every rejection.
- Default model is now `qwen2.5:7b-instruct` (was 14B; 14B is still available via
  `OLLAMA_MODEL`). Measured on the 24GB M4 Pro: classify call 7.41s -> 3.61s (2.05x), resident
  memory 9.5 GB -> 4.7 GB, system free memory 21% -> 63% (the 14B pushed the machine into swap).
- The workload is PREFILL-bound, not decode-bound: ~1,450 tokens in, ~21 out, and 86-87% of
  wall time is prompt processing on both models. Decode tok/s — the number usually quoted for
  local models — is ~11% of runtime and is NOT the lever. Input size and call volume are.
- 68% of real postings exceed `MAX_DESC_CHARS = 6000`, so nearly every model call is a
  maximum-size prompt. Lowering that ceiling remains an untaken ~linear lever (Decision 13
  option B) if more speed is needed.
- OPEN RISK: both routers were tuned on an early-August sample containing only 3 internship
  titles out of 2,008. Re-validate against an internship-heavy board in September before
  trusting the 82% drop rate as steady-state.
- The "never route a `rejectRoute()` drop into `newRejects`" rule is now TEST-ENFORCED
  (`filter.test.ts`). Verified by mutation: pushing regex drops into `newRejects` fails 3
  tests. Those tests deliberately use only router-resolvable fixtures, so they need no live
  Ollama and no database — if a change ever lets a fixture reach the model, the suite hangs
  or errors loudly, which is itself the signal.

## First end-to-end run (2026-08-08)

- BUG FIXED — entity-decode ORDERING in `normalizeGreenhouse`: Greenhouse ships `content`
  entity-ENCODED (`&lt;p&gt;`), but `htmlToPlain()` strips tags FIRST and decodes entities
  LAST. Passing the raw string matched no tags, so they were decoded INTO the output —
  `description_plain` was stored as literal markup. Fix: decode ONCE in normalize, derive both
  fields from the decoded HTML. Edge case to remember: **anything entity-encoded must be
  decoded before tag-stripping, never after.** Pinned by `greenhouse/normalize.test.ts`.
- Impact was bigger than "cosmetic": text was 22% longer than it should be, and because the
  model call is prefill-bound with 68% of postings hitting `MAX_DESC_CHARS`, the markup
  padding was truncating real job requirements off the end of the prompt.
- OPEN — 7B accuracy: the run's single keep ("Data Analyst" @ 1stdibs, typed `new_grad`) is a
  FALSE KEEP; the posting requires "2+ years". 14B rejects the same text correctly. The HTML
  bug was ruled out as the cause (7B says `new_grad` on both versions). n=1, so this raises
  the priority of the 14B-vs-7B agreement test, it does not settle the model choice.
- Asymmetry worth remembering: a false KEEP is visible and reversible (delete the row); a
  false REJECT is invisible and permanent (key-only `seen_listings`, never re-checked). 7B
  erring toward keeps is the safer direction.
- CAVEAT on current DB state: the 38 `seen_listings` rejects were all decided on
  markup-polluted text (and 32 of them by the old 14B pipeline). They are permanent and will
  never be re-evaluated unless deleted.

## Experience filtering (Decision 14, 2026-08-09)

- Tier 3 in the filter: `minYearsExperience(description_plain)` drops any posting stating an
  experience minimum above `MAX_YEARS_EXPERIENCE` (MVP value: 0) BEFORE any model call.
  Measured: model calls fall from 90 to 35 on a 6-board sample (~2.6x on top of Decision 13).
- PARSE THE FIRST NUMBER OF A RANGE. "0-3 years" -> minimum 0 (keep); "2+ years" -> 2 (drop).
  A regex matching any number would return 3 for "0-3 years" and drop the one posting of the
  first three real keeps that was actually correct ("Junior Engineer", fresh grads welcome).
- Take the MIN across all matches, not the first or the max — keep-biased on purpose, since a
  false reject is invisible and a false keep is visible. "0-3 required, 5+ preferred" -> 0.
- `null` (posting states no minimum) is NOT a drop. null and 0 must stay distinct.
- Experience drops are NOT recorded in `seen_listings`, same rule as the title reject-router.
  Raising the cutoff later retroactively re-evaluates everything previously dropped.
- ORDERING: the accept-router runs BEFORE the experience filter. An explicit "Software
  Engineering Intern" is kept whatever its body says — at cutoff 0 an incidental "1 year
  program" would otherwise drop a genuine internship.
- The parser is a FACT extractor, the threshold is POLICY in `filter.ts`. Keeping them apart
  is what makes the v1 "store YOE + configurable cutoff" feature a small change.
- Known gaps, accepted: word-form ("one year"), month-form ("18+ months"), and reversed
  phrasing ("years of experience: 2+") are not matched; all fail toward KEEPING. Tenure
  language ("401k vesting after 1 year") would read as a 1-year minimum if it were the only
  match in a posting — not seen in 62 real matches, but possible.
- Prompt hardening (option D) shipped alongside: `CLASSIFY_SYSTEM` now says a stated minimum of
  1+ years means NOT early-career regardless of title, that a range starting at 0 does not
  disqualify, and that "Junior"/"Associate"/"Analyst"/"Researcher" are not themselves evidence.
  MEASURED PARTIAL: it fixed Data Analyst (now null) but NOT Researcher (7B still says
  `research`). Treat the prompt as a second layer, not the fix — the regex is what guarantees.
- `FilterResult.regexDropped` was split into `titleDropped` + `yoeDropped` so the run log shows
  which lever is doing the work.

## First clean run audit (2026-08-10) — see research/first-clean-run-audit.md

- DEDUP IS NOT CROSS-SOURCE ONLY. The `dedup.ts` pass-through says "with only Greenhouse wired
  there are no cross-source duplicates to find" — true, but it implies nothing needs deduping,
  and 16 of 38 listings in the first clean run were WITHIN-source duplicates. Decision 9's
  linking algorithm must handle intra-source dupes, not just cross-source. Current dup rate is
  42% against the <5% success metric.
- Two distinct duplicate classes, needing different answers: TRUE duplicates (same company +
  title + location, different req ID — 6x Meridial in the US) versus GEOGRAPHIC variants (same
  company + title, different country — Affirm Remote Poland vs Remote Spain, Meridial across 6
  countries). A `(company, title)` key collapses both; `(company, title, location)` collapses
  only the true duplicates. Still FIRST-DRAFT-MINE, undecided.
- OPEN SCOPE QUESTION (Decision 10): freelance AI-trainer / data-annotation gig work. One
  company (Meridial) was 45% of the run, all of it crowdwork classified `part_time`. It passes
  the filters legitimately — titles say "No Experience Required" so the YOE filter has nothing
  to catch, and the model reads "AI" as CS-adjacent. If in scope, this company dominates the
  hub and `part_time` becomes almost entirely gig work.
- VERIFIED at scale on this run: 0/38 HTML leaks into `description_plain` (normalize fix holds),
  0/38 experience-filter leaks, and extract correctly returned null for all 6 postings whose
  "deadline" text actually reads "there is no fixed deadline to apply" (rolling → null, per
  Decision 7) — a reminder that a keyword hit is not a stated deadline.

## Within-source dedup (Decision 15, 2026-08-25)

- `dedup.ts` is real now: key is `(company, title, location)`, exact string match (`.trim()`
  only — no case-folding, no location normalization). Collapses true within-source duplicates
  (same req reposted under different IDs) while leaving every geographic variant alone, since
  their location strings differ by construction.
- Runs BEFORE `partitionBySeen`, so it must handle both an in-batch duplicate (multiple copies
  of the same req in one crawl) and a duplicate against a row already in `listings` from a past
  refresh — one deterministic survivor per key (smallest `sourceExternalId`), one batched DB
  lookup resolves both cases in a single pass.
- SELF-HEALING NEEDED NO SPECIAL-CASE CODE: the DB lookup only matches `isListed: true` rows, so
  an inactive canonical simply stops appearing as a match — the next listing sharing its key is
  treated as brand new and gets its own row. The invariant (Decision 9: only suppress against a
  currently-ACTIVE canonical) falls directly out of that one filter.
- New `duplicateKeys Json` column on `listings` (array of `{source, sourceExternalId}`) — link,
  never delete, per Decision 9. Flows through `persist.ts`'s existing `{...listing}` spreads
  without that file needing to know dedup exists, because the field lives on `NormalizedListing`
  itself.
- ONE-TIME BACKFILL (`src/backfill-dedup.ts`, run once 2026-08-25): a fresh `dedup()` only stops
  NEW duplicates — it can't retroactively merge two rows that already both have their own ID in
  `listings`. The backfill applies the same key + survivor rule to existing active rows.
  Idempotent (a fully-collapsed group is a group of one on re-run), safe to re-run if a future
  bug reintroduces already-persisted duplicates.
- MEASURED: 71 active listings, 21.1% duplicate under the old `(company, title)` metric. Found 3
  real duplicate groups under the new key (the known 6x Meridial cluster, a second 2x Meridial
  cluster the audit didn't call out individually, and a 2x Amtech Software pair) — all confirmed
  exact matches, zero geo-variants wrongly caught. Post-backfill: 64 active rows, **0%**
  duplication under `(company, title, location)`, against the <5% target.
- `(company, title)` alone now reads 12.5% — NOT remaining duplicates, but the wrong metric:
  every legitimate geo-variant counts as a "dup" under it, which is exactly what Decision 15
  rejected. `(company, title, location)` is the metric to trust going forward.
- KNOWN GAP, accepted: exact-string matching means "USA" and "United States of America" would
  NOT collapse even if they were the same duplicate — false negative, safe direction. Location
  normalization is a separate, still-open decision (see the audit's Location Data Quality
  section) — deliberately not folded into this one.

## CS subfield + IT-scope tightening (Decision 16, 2026-08-27)

- New nullable `cs_field` enum on `listings` (`swe, ml_ai, data, quant, security,
  hardware_embedded, devops_infra, it, product, other`) — set by the classify pass (one extra
  schema field on the call we already pay for; prefill dominates, so marginal cost ≈ 0) or, for
  router-accepted listings that never reach the model, by a deterministic title regex
  (`csFieldFromTitle` in `accept-router.ts`, first-match-wins with specific fields before the
  `swe` catch-all).
- `CLASSIFY_SYSTEM` now splits IT: engineering-side (sysadmin/networking/cloud/IT-security) is
  cs_relevant, service-side (help desk, desk-side, phone/ticket support) is not.
- Decisions to remember: `null` csField ≠ `other`. `other` is the model's confident
  "CS but no bucket"; `null` means nobody decided (regex abstained / model abstained / row
  predates the field). Don't collapse them in UI filters.

## Grad dates as stated months (Decision 17, 2026-08-27)

- Extraction now copies the stated graduation window verbatim into new `grad_date_min/max`
  ("YYYY-MM" or "YYYY", strictly validated); `grad_year_min/max` are DERIVED in code
  (`src/model/grad-date.ts`): months Aug–Dec roll into the following class year, bare years
  pass through ("unspecified means Spring").
- Fixes the real bug where "Sep 2027 – June 2028" stored years 2027–2028 and wrongly included
  Spring-2027 grads; it now derives 2028/2028.
- Decisions to remember: the year columns are recomputable from the date columns without model
  calls — if the Aug-cutoff rule ever changes, re-derive, don't re-extract. A failed
  plausibility clamp nulls BOTH the year and the stored date string.

## Reclassify command (Decision 18, 2026-08-27)

- `npm run reclassify` re-runs the CURRENT classify prompt over all active listings; flags
  `--dry-run` (log, no writes — run this first after any prompt change), `--extract` (also
  re-run pass 2; used once for the Decision 17 grad-date backfill), `--limit N` (smoke run).
- Still-keeps: `opportunityType`/`csField` updated in place, `lastSeenAt` untouched (not a
  sighting). New-rejects: atomically delisted (`isListed=false`, row kept for audit) + key
  written to `seen_listings` so crawls skip them.
- Decisions to remember: `partitionBySeen` now checks reject-memory BEFORE keep-memory — a key
  can be in both tables post-reclassify, and keeps-first would resurrect delisted rows via
  `persist()`'s forced `isListed: true`. If a prompt is ever LOOSENED, reclassify-delisted keys
  in `seen_listings` must be deleted manually to be re-evaluated.

## Location facets + filter groundwork (Decision 19, 2026-08-27)

- New `loc_countries[]` (ISO alpha-2) and `loc_us_states[]` scalar-list columns, derived from
  raw `location` by a pure deterministic parser (`src/pipeline/stages/location.ts`) — no model
  calls. Arrays because real listings span multiple states/countries at once. Raw `location`
  stays untouched (dedup key input).
- Computed in `persist()` for every listing write (including seenKeep refreshes — no drift on
  upstream location edits) and in `reclassify`'s keep path unconditionally (this is the
  backfill; riding the next reclassify sweep, no `--extract` needed).
- MEASURED: 92.5% of 1,817 active rows resolve to ≥1 country; 91.3% of US rows get a state.
  The unresolved 7.5% is mostly place-less strings ("Hybrid", "Remote", "Worldwide") — the
  Option-3 model fallback is deferred as not-worth-it (research/location-shape-analysis.md).
- Decisions to remember: Canadian province codes are checked BEFORE US state codes (Toronto-ON
  trap — real rows exist). Ambiguous cities (Cambridge/Vancouver/Portland/Springfield) are
  deliberately unmapped: empty facets are the safe failure, wrong facets are invisible. Empty
  arrays mean "unresolved", which for the US-state filter means "excluded" — surface an
  "unknown location" bucket in the UI rather than hiding those listings entirely.

## Staleness / delisting (Decision 22, 2026-08-28)

- The pipeline now delists: right after each board's SUCCESSFUL fetch+normalize, active
  `listings` rows scoped to that board's `(source, company)` whose `sourceExternalId` was
  absent from the response get `isListed=false` (`src/pipeline/stages/delist.ts`). Failed or
  skipped crawls take the catch path and never reach the delist call — a flaky board cannot
  wipe its listings; a crashed run has only delisted against boards it actually completed.
- Zero grace period: a successful Greenhouse fetch is the whole board in one response
  (fetch.ts errors on malformed payloads rather than returning empty), so one absence is
  authoritative. Reversal is automatic, not manual: a delisted posting that reappears routes
  as a seenKeep and persist()'s forced `isListed: true` relists it — no special-case code.
- New nullable `CrawlTarget.company` cache (migration `20260828142547`), learned from each
  unambiguous successful crawl — exists so a board that legitimately returns `jobs: []` (a
  company pulling all postings) can still be delisted against.
- Gated per-source by `supportsFreshness` (Greenhouse only): the flag asserts "a successful
  fetch = the complete board." Do NOT enable for Lever/Ashby until their fetchers are
  confirmed to paginate to completion.
- Decisions to remember: staleness-delist deliberately does NOT write `seen_listings` — that
  table is classifier reject-memory, and its absence here is exactly what lets stale rows
  auto-relist while reclassify-delisted rows (whose keys ARE there) stay dead. The delist
  diff runs on the RAW normalized board output (pre-dedup/pre-filter), so suppressed
  duplicates and non-CS postings still count as "seen on the board." Boards deactivated by
  discovery are never crawled, so their rows never delist — the future CrawlTarget pruning
  logic must handle that case.

## Conditional fetch — ETag/304 (Decision 23, 2026-08-28)

- `fetchGreenhouse` now sends `If-None-Match` with the etag stored from the last successful
  full fetch (new nullable `CrawlTarget.etag`, migration `20260828150435`); a 304 skips the
  board's entire normalize/dedup/AI pass. Measured: ~0.13s / 0 bytes per unchanged board vs
  ~0.4s / 3.5MB full — a mostly-unchanged sweep of 3,187 boards drops from ~30–90 min toward
  ~10–15 min.
- Fetch results are a discriminated union (`{kind:"ok",jobs,etag} | {kind:"not_modified"}`) —
  deliberately NOT an empty jobs array, which would be indistinguishable from a genuinely
  empty board and would trigger Decision 22's delist-via-cached-company on unchanged boards.
- 304 path in the orchestrator: crawl health + `lastSeenAt` bump for the board's active
  listings (scoped by the company cache), NO delist (nothing can be absent from an unchanged
  set). Etag only stored from a fully-validated 200, so a malformed payload can't poison the
  cache.
- `npm run refresh -- --full` ignores stored etags and re-downloads everything — required
  after normalize-layer bug fixes, since a 304 skips exactly the bodies a rebuild needs.
- Decisions to remember: on a 304, `seen_listings` reject keys get NO lastSeenAt bump (no
  company column to scope by) — future reject-pruning must read that column as a lower bound.
  Lever/Ashby must have validator support verified per-source before trusting this path.

## UI reroll: Terminal Board world (2026-08-28)

- Replaced the Dispatch Board visual world (vintage CTC panel) with **Terminal Board —
  Monochrome**: market-data watchlist grammar in near-total monochrome on true black, chosen
  by the user on the decision page (seed ff70fa62) after two re-roll rounds and a
  four-variation comparison (Swiss light/dark vs Terminal mono/light).
- All behavior preserved: querystring filters + facets, j/k + s/a/i/o/x/u keyboard triage,
  status PUT, NEW/EARLIER dividers, pagination, single 880px breakpoint. Only `render.ts`
  changed; fonts trimmed to Chivo Mono (figures) + system sans (words).
- One law per hue: `#4D9FFF` blue may only mean NEW (figure, status code, divider, toggle).
  Statuses are marks + code words (HELD/APP/INT/OFF/REJ); deadlines are bold white; rejected
  rows dim + strikethrough. No green/red anywhere.
- Finish-review fix batch included a real security fix: hidden-input filter values are now
  `esc()`-escaped, closing a reflected-markup injection via `?state="><img...>` that also
  existed in the old world.
- Decisions to remember: the market metaphor is structural only — no sparklines/fake tickers
  (no per-listing time series exists to plot); the NEW figure never shrinks at any
  breakpoint; all motion is `steps()` (nothing glides), with flashing states inside
  `prefers-reduced-motion: no-preference`.

## Degree-status extraction (Decision 24, 2026-08-28)

- New `degree_status` column (pursuing / completed_required / unknown / null), extracted in
  the Pass-2 model call from the description — catches "internships" that require an
  already-completed degree (the WhiteWater case from research/degree-status-audit.md).
- Quote-first grounding: `degree_evidence` precedes `degree_status` in the schema so the 7B
  must quote the degree sentence before classifying; without it the model title-anchored to
  "pursuing" on every posting. Evidence is discarded, not stored.
- Store + surface, never a write-time drop: search API returns the field; UI shows a
  "DEG REQ" badge only when completed_required (the state that contradicts an internship
  label). Backfill for existing rows: `npm run reclassify -- --extract` (long; operator-run).
- Boundary guard `normalizeDegreeStatus()` unit-tested (junk model output → null).
- Decisions to remember: pursuing/unknown/null intentionally show no badge — badging the
  expected state would be row noise. Ambiguous "advanced degree preferred" postings may
  resolve to pursuing; only completed_required is treated as a warning signal.

## Lever adapter (2026-08-31)

- `fetchLever` paginates `skip`/`limit` (max 100/page) to completion and returns the combined
  board as one `{kind:"ok", jobs, etag:null}` — always `etag:null` on purpose, see below.
  `normalizeLever` maps the posting to `NormalizedListing` or drops it (`null`) if `ctx.company`
  is unresolvable.
- CORRECTED RESEARCH: `research/ats-field-reference.md`'s Lever pagination section was wrong —
  live capture (Palantir board) showed a bare JSON array response with `skip` (not `offset`)
  and no `total`/`hasNext` field anywhere, contradicting what was previously documented there.
  Termination is "stop when a page returns fewer than `limit` items," with a `MAX_PAGES=500`
  hard safety cap against a misbehaving server that never returns a short page.
- Company is NEVER in the payload — Lever boards are one-company-per-slug. `ctx.company` (now
  populated by the orchestrator as `target.company ?? target.token`) carries either Decision
  22's learned name or the raw slug on a board's first crawl; `prettifyCompanySlug()`
  (`src/sources/company-slug.ts`, new — shared with the future Ashby adapter, which has the
  identical gap) turns it into a display name and is deliberately idempotent against an
  already-prettified learned name.
- `categories.commitment` and `workplaceType` are free text the posting company chooses in
  their own Lever admin, not a closed enum — Palantir's live board used `"Fixed-Term"` and
  `"Scholarship"` (for a role literally titled "American Tech Fellowship") for values no Lever
  doc mentions. Both mappers fall through to `null` on anything unrecognized rather than
  throwing — `employmentType` is enrichment, not a gate; `opportunityType` still gets
  classified downstream from title/description regardless.
- `createdAt` is epoch MILLISECONDS (verified live) — `publishedAt: new Date(job.createdAt)`
  directly, no `* 1000`.
- `descriptionPlain` is Lever-provided pre-stripped, unlike Greenhouse's entity-double-encoded
  `content` — no `decodeHtmlEntities`/`htmlToPlain` round-trip needed for this source.
- Live capture ALSO found Lever sends a real, working weak `ETag` (undocumented) and genuinely
  304s on a matching `If-None-Match` — but scoped to one exact `skip`/`limit` request, not the
  whole board. A multi-page board has no single request representing "the whole board is
  unchanged," so `fetchLever` never sends `priorEtag` and always returns `etag:null` rather
  than caching a page-scoped signal that would be actively wrong once reused. `supportsFreshness`
  stays `false` for Lever until a real whole-board freshness signal exists for paginated sources.
- Decisions to remember: `url` is `hostedUrl` (posting page), not `applyUrl` (the application
  form) — matches `normalizeGreenhouse`'s `absolute_url` semantic so "view listing" behaves
  the same across sources. `applicationDeadline` is always `null` for Lever — not present on
  the public postings object at all (unlike Greenhouse's structured field), so it's AI-extracted
  only for this source, same as it already is for Greenhouse posts lacking the field.
- STILL BLOCKED, separately: no `CrawlTarget` rows exist for Lever in production — board
  discovery (`src/discovery/`) is Common-Crawl-Greenhouse-hostname-specific today, so this
  adapter has nothing to crawl in a real refresh until a Lever discovery mechanism is decided.
  Dev-only smoke-testing is unblocked via `npx tsx src/seed-crawl-target.ts <source> <token>`
  (new; inserts one `crawl_target` row, does not touch discovery policy).
- LIVE SMOKE TEST (2026-08-31): `fetchLever`/`normalizeLever` run directly against Palantir's
  real board (308 postings, 2 pages — confirms the mocked pagination-past-100 test path holds
  against a real server, not just fixtures) normalized 308/308 with zero drops. One
  `crawl_target` row seeded (`lever/palantir`, id 6998) for future full-refresh testing.

## Per-pass model split (Decision 25, 2026-08-31)

- Classify runs `qwen2.5:14b-instruct`, extract runs `qwen2.5:7b-instruct` by default;
  `chatJson` gained a per-call `model` param, resolution via `passModel()` (unit-tested).
- Env precedence: `OLLAMA_CLASSIFY_MODEL`/`OLLAMA_EXTRACT_MODEL` > `OLLAMA_MODEL` (forces
  one model everywhere — the bench/A-B escape hatch) > defaults.
- Requires both models pulled (README prerequisites updated). ~22GB resident together.
- Decisions to remember: enabled by the M5 Max/128GB upgrade — Decision 13's 7B-everywhere
  choice was RAM-gated, not accuracy-driven. Next 14B reclassify sweep will delist measured
  junk keeps; always dry-run it first.
