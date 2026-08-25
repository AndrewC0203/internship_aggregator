# Audit of the first clean pipeline run (2026-08-10)

38 listings, produced after the DB truncate and with all three recent changes live: the
Greenhouse entity-decode fix, the Decision 14 experience filter, and the hardened
`CLASSIFY_SYSTEM` prompt.

## Mechanics — all verified clean

| check | result |
|---|---|
| HTML leaked into `description_plain` | 0 / 38 |
| YOE filter leaks (a keep with min > 0) | 0 / 38 |
| grad-year stated in text but left null | 0 (1 posting stated one; extract caught it) |
| deadlines missed | 0 — all 6 "deadline" hits read *"there is no fixed deadline to apply"*, so null is correct per Decision 7 |
| extract fill rates | gradYear 1/38, citizenship 13/38, deadline 0/38 |

Early-career precision reads well: `Jr. Software Engineer`, `Engineer I`, `Software Engineer I`,
`Associate Data Analyst (New Graduate)`, `Returning Summer Analyst`, `Engineering Fellowship`,
`Tech Cooperative Internship`.

## Finding 1 — WITHIN-source duplicates exist (16 of 38 rows)

```
6x  Meridial :: AI Training Generalist (No Prior Experience Needed)
      6 distinct req IDs, ALL location "United States of America"  <- true duplicates
6x  Meridial :: Social Media Annotation - Freelance AI Trainer
      US, UK, Canada, Australia, New Zealand, Ireland              <- geographic variants
2x  Affirm   :: Software Engineer I, Backend (Collections)
      Remote Poland / Remote Spain                                  <- geographic variants
2x  Affirm   :: Software Engineer I, Fullstack (Servicing International)
      Remote Spain / Remote Poland                                  <- geographic variants
```

**This contradicts the stated rationale in `dedup.ts`**, which justifies the pass-through with
"with only Greenhouse wired there are no cross-source duplicates to find". True as written, but
it implies there is nothing to dedup — and there is. Every duplicate above is within a single
source.

Two classes needing different treatment:
- **True duplicates**: same company, same title, same location, different req ID. Noise.
- **Geographic variants**: same company, same title, different country. Arguably listings a
  student legitimately wants to see separately.

A dedup key of `(company, title)` collapses both; `(company, title, location)` collapses only
the true duplicates. UNDECIDED — Decision 9's linking algorithm is FIRST-DRAFT-MINE.

Current duplicate rate is **42%** against a project success metric of <5%.

## Finding 2 — one company is 45% of the hub

| company | listings | share |
|---|---|---|
| Meridial | 17 | 45% |
| Accenture Federal Services | 6 | 16% |
| Affirm | 4 | 11% |
| Agoda | 4 | 11% |
| others (6 companies) | 7 | 18% |

Every Meridial listing is freelance AI-trainer / data-annotation gig work, classified
`part_time`. They pass the filters legitimately: titles literally say "No Experience Required"
so the YOE filter has nothing to catch, and the model reads "AI" as CS-adjacent.

Whether crowdwork annotation is in scope is a Decision 10 question, not a bug. If kept, this
single company dominates the product and `part_time` becomes almost entirely gig work.
UNDECIDED.

## Finding 3 — the internship drought is SUPPLY, not the pipeline (2026-08-10)

Re-fetched all 99 crawled boards and counted what actually exists:

```
99 boards | 5,105 live postings
titles containing "intern" or "co-op" :  14  (0.27%)
  of those, CS-flavoured              :   2
new-grad-ish CS titles                :  28
```

Every intern title across all 99 boards, for the record: Graphic Design Marketing, Social
Media, Sales/Communications Marketing, Chief of Staff, Product Analyst, Live Streaming
(Content), Consumer Insights, Content Creator, IT Service Desk, AI Data Curation, Web3
Product Management, Web3 Security Consultant, **Web3 Software Engineering**, **[Tech
Cooperative Internship 2026] SWE Back End**.

Only the last two are CS. The pipeline captured one of them.

Run breakdown by type: `new_grad` 15, `part_time` 17 (all Meridial gig), `internship` 4,
`fellowship` 2. Of the 4 internships, only Agoda's Tech Cooperative Internship is a clear CS
internship; `Returning Summer Analyst` (Accenture) is CS-adjacent; `Data Platform Developer
(6-month Contract)` is a contract role questionably typed as an internship; `Consumer Insights
Intern` is not CS.

**Implication:** yield is bounded by supply, not by filter tuning. Sampled 2026-08-10 —
Summer 2026 internships have closed and been pulled; Summer 2027 postings mostly go up late
August through November. Finding almost entirely `new_grad` right now is correct behaviour.

**This makes the September re-validation the highest-value outstanding task.** Both the
Decision 13 reject-router (82% drop rate) and the Decision 14 experience filter (cutoff 0)
were tuned on corpora containing essentially zero internships. They have never been tested
against the population they will face once internship season opens.

## Finding 4 — UNRESOLVED anomaly: AIFT board produced nothing

`Web3 Internship- Software Engineering Intern, OneSavieLab` (aift, id 5034882004) appears in
NEITHER `listings` nor `seen_listings`, and no AIFT listing exists at all (0 of 31 jobs).

What was ruled out:
- board fetch failed — no: `lastCrawledAt` set 00:02:38, `lastError` null
- posting not live at crawl time — no: `first_published` 2023-12-06, `updated_at` 2026-05-13
- normalize dropped it — no: 0 of 31 AIFT jobs return null from `normalizeGreenhouse`
- current code would drop it — no: tracing the live board through the tiers gives
  `accept=1 titleDrop=19 yoeDrop=3 toModel=8`, and the accepted one IS the Web3 SWE intern

So today's code would keep it, and the cause of the run not keeping it is UNKNOWN. Next step
is simply to re-run and see whether AIFT yields listings; if it still yields nothing, there is
a real bug to chase.

## Finding 5 — one keep worth eyeballing

`Consumer Insights Intern` @ 10Beauty — consumer/market research at a beauty company, kept as
`internship` + CS-relevant. Possible CS-relevance false keep; not confirmed either way.

## Board fetch failures — dead vs slow (2026-08-22)

Six of 163 boards errored on a full refresh. Live re-check shows `lastError` conflates two
different conditions, so it must NOT be used as a pruning signal on its own:

| board | refresh error | live re-check | verdict |
|---|---|---|---|
| 10xgenomics | 404 | 404 | dead (had succeeded 2026-08-10) |
| aerospike | 404 | 404 | dead (never succeeded) |
| accreditedlabs | 404 | 404 | dead (had succeeded 2026-08-10) |
| amenitiz | 404 | 404 | dead (never succeeded) |
| **abinbev** | timeout | **HTTP 200, 69 jobs** | **ALIVE — just slow** |
| **andurilindustries** | timeout | timed out again at 15s | **almost certainly alive** |

**The actionable finding is the timeouts, not the 404s.** `fetch.ts` sets
`TIMEOUT_MS = 10_000` while fetching with `?content=true`, which returns full HTML for every
job — a large board is a multi-megabyte payload. Whole boards are being silently lost every
run. Anduril is a heavy new-grad employer, i.e. exactly the target inventory. UNDECIDED
whether to raise the constant.

**Pruning implications (FIRST-DRAFT-MINE — user writes this):**
- Decision 11 already settles delete-vs-deactivate: DEACTIVATE, never hard-delete. Hard-delete
  loses the error history and Common Crawl re-adds the token next discovery run anyway.
- Decision 11's trigger is `last_seen_in_discovery_at` (~2–3 months). All six were seen
  2026-07-25, so none qualify under the logged policy regardless of their errors.
- Nothing currently sets `isActive = false` — the pruning logic does not exist yet.
- Open design question: should a repeated 404 across N consecutive refreshes be a SECOND
  deactivation signal alongside the discovery-staleness one? The logged design has only one.
  If so, it must key on 404 specifically, never on `lastError` being non-null — see the table.
- Cost of leaving all six alone: 4 instant 404s + 2×10s timeouts ≈ 20s per run. Negligible.

## Full 163-board run (2026-08-22) — funnel + findings

| stage | count | share |
|---|---|---|
| unseen | 6,391 | 100% |
| title-dropped (reject-router) | 4,433 | 69.4% |
| experience-dropped (YOE, cutoff 0) | 1,403 | 22.0% |
| reached the model | 555 | **8.7%** |
| keeps / model-rejects | 22 / 533 | |

91% of listings never touched the model. Totals after the run: 71 listings, 1,949
seen_listings, 160/163 boards crawled, 10 internships (up from 4 — purely from more boards,
confirming supply is the binding constraint until September).

**THE ROUTERS ARE ENGLISH-DEPENDENT.** The keep `Practicante de ingeniería` (Spanish for
"engineering intern", Advanced Technology Services, Monterrey) could not have been caught by
any regex here: the accept-router matches only `intern|internship|co-op`, and the
reject-router's early-career veto and seniority lists are entirely English. It survived the
title router by matching NOTHING, and only the model recognised it.

Consequences to remember:
- This is a concrete argument FOR the hybrid design: regexes are the cheap high-volume filter,
  the model handles the long tail the regexes are structurally blind to. A regex-only pipeline
  would silently lose every non-English posting, and Greenhouse boards are global.
- The 69% title-drop rate is English-dependent. A Spanish/French SENIOR title won't match the
  seniority regex either, so it costs a model call — the safe direction to fail, but it means
  the drop rate will be lower on international-heavy board sets.
- Same applies to the YOE parser: "2+ años de experiencia" is not matched.

**Non-findings (checked, not bugs):** `<T>` / `<TKey, TValue>` surviving in
`description_plain` on the Amtech rows are C# generics in the job text, correctly preserved by
the double-decode path — not leaked HTML. An audit regex of `<[a-z][^>]*>` false-positives on
them. The AIFT `Web3 Internship – Software Engineering Intern` anomaly from the previous run
is RESOLVED — it is now captured, so it was a board-selection artifact, not a filter bug.

**Still open:** duplicate rate 21% (target <5%) — `Meridial::Social Media Annotation` ×6 spans
6 different countries (arguably distinct) while `AI Training Generalist` ×6 is all
"United States of America" (pure noise); the dedup key choice decides which collapses.
Meridial is 24% of all listings. Extraction stays conservative: citizenship 13/71, grad year
1/71, deadline 0/71.

## Location data quality — input to a US-filter decision (2026-08-22)

`location` is free text: **45 distinct strings across 71 listings.** No country column exists,
and no location filter exists. Observed formats:

```
Remote US                                  United States of America
Annapolis Junction, MD                     Remote within the U.S.
New Britain, Pennsylvania, United States   Washington D.C.
Remote Poland / Remote Spain               Bangkok            (no country)
Toronto, ON, Saskatoon, SK                 Remote             (country unknown)
US-Remote | US-Washington DC | US-VA-Arlington | US-NC-Chapel Hill | ... (9 in ONE row)
```

**A naive US regex gives 38 US / 33 non-US and is WRONG.** Matching `,\s*[A-Z]{2}` to catch
US state codes also matches Canadian provinces — `Toronto, ON` and `Saskatoon, SK` are counted
as US. `Remote` alone is unclassifiable. Any read-time regex approach inherits this.

Also note the multi-location row (American Institutes for Research intern, 9 pipe-separated
US locations): whatever is chosen must handle one-listing-to-many-locations, which pushes
toward an array column or a join table rather than a scalar country field.

Options are UNDECIDED and GATED (schema): (A) structured country column parsed at normalize
time; (B) read-time regex over free text — no migration but demonstrably unreliable per above;
(C) have `extract()` pull country, since it already reads the posting and already abstains
when unsure — free at runtime, inherits the schema-valid-≠-correct risk; (D) punt to
free-text search.

## Yield math — why output is low (2026-08-22)

The filter is NOT the limiting factor. Measured: **0.44 listings per board** (71 / 163), with
69% of postings title-dropped as senior/non-CS (normal for company boards) and a ~0.9% keep
rate over all postings.

| target listings | boards needed at current yield |
|---|---|
| 500 | ~1,100 |
| 2,000 ("thousands", the success metric) | ~4,600 |
| 5,000 | ~11,500 |

**163 boards is a deliberate cap, not a discovery failure.** `discovery/orchestrator.ts`
caps the validation sweep because a full sweep needs the GATED ATS rate-limiting decision,
which is still unmade. Greenhouse has tens of thousands of live boards.

Consequence to remember: the pipeline keeps ~1% of whatever it is fed, so volume scales with
board count and nothing else. Prompt/regex tuning cannot substitute. **The ATS rate-limit
decision is the highest-leverage open item — ahead of dedup and the location filter.**
