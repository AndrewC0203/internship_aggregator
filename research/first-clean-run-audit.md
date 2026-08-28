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
the true duplicates. RESOLVED 2026-08-25 — see Decision 15 (key = `(company, title, location)`).

Current duplicate rate is **42%** against a project success metric of <5%. (Measured again on
the 71-listing run below at 21%; 0% after Decision 15 + backfill.)

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

**RESOLVED (2026-08-25, Decision 15):** dedup key is `(company, title, location)`, exact match —
collapses pure-noise (`AI Training Generalist` ×6, all "United States of America") while
leaving every geo-variant (`Social Media Annotation` ×6 across 6 countries) alone. Backfilled
the pre-existing duplicates; post-backfill duplicate rate is 0% under this key (was 21.1% under
the old `(company, title)` metric). See DECISIONS.md Decision 15 and FEATURES.md. Meridial is
still 24% of all listings — that's Finding 2's scope question, not a dedup problem. Extraction
stays conservative: citizenship 13/71, grad year 1/71, deadline 0/71.

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

## 787-board run (2026-08-25) — scale-up + season-inflection findings

Discovery re-run uncapped, then `--limit 1000` (787 boards kept, up from 163 — see DECISIONS.md
for why an uncapped sweep was aborted: Common Crawl's CDX endpoint was ~20% 502/504 that day,
confirmed independently, not a bug). Refresh run against all 787 boards, now chunked in
`BOARD_BATCH_SIZE`-board flushes (FEATURES.md P1, unblocked by Decision 15) so a mid-run crash
loses at most one chunk instead of the whole crawl.

| metric | 2026-08-22 (163 boards) | 2026-08-25 (787 boards) |
|---|---|---|
| active listings | 71 | 495 |
| listings / board | 0.44 | 0.63 |
| internship share | 10/71 (14%) | 176/495 (**35.6%**) |
| top-company share | Meridial 24% | DRW 6.7% |
| distinct companies | ~10 | 151 |
| dup rate, (company,title,location) | n/a (pre-Decision 15) | **0.0%** (7 real dup groups caught, all correctly suppressed) |
| gradYear extracted | 1/71 (1.4%) | 78/495 (15.8%) |
| citizenship extracted | 13/71 (18%) | 112/495 (22.6%) |
| deadline extracted | 0/71 (0%) | 4/495 (0.8%) |

**INTERNSHIP SEASON HAS ARRIVED, EARLIER THAN PREDICTED.** Finding 3 predicted internship
volume would stay near-zero until "late August through November." Internship share just moved
from 14% to 36% of the hub in three days. This is the single most consequential change in this
run — it means the Decision 13 reject-router (82% drop rate, tuned on ~0.05%-internship data)
and the Decision 14 YOE filter (cutoff 0, tuned on a 90-posting sample with 3 internships) are
now operating on exactly the population they were NEVER validated against. Both routers'
false-reject risk is a live question now, not a September one — and neither drop is recorded
(by design, for reversibility), so there is no retroactive way to audit what they silently
rejected this run. **Re-validating both routers against this run's title/YOE-dropped population
is now the highest-priority open item**, ahead of the ATS rate-limit decision — board count no
longer bottlenecks internship share the way it did in August.

**Company concentration problem is resolved, as a side effect of board scale, not a targeted
fix.** Meridial dropped from 24% to 2.2% of the hub purely because 787 boards dilutes any one
company's share; nothing in the filter/classify logic changed. Top company (DRW) is under 7%.
Finding 2's "is crowdwork in scope" question (Decision 10) is now much lower-stakes — Meridial
no longer dominates the product either way.

**Dedup (Decision 15) held cleanly at 7x scale.** 0% duplication under the real key, and the
suppressed-duplicate audit trail (`duplicateKeys`) caught two NEW real duplicate clusters not
in the original 38/71-listing sample (Cloudflare's Fall 2026 Research Engineer Intern posted
under 3 req IDs, its Software Engineer Intern under 2) — evidence the key generalizes past the
original audit sample, not just fits it.

**Extraction fill rates roughly doubled** (gradYear 1.4%→15.8%, citizenship 18%→22.6%) —
consistent with the season-inflection finding: internship postings state grad-year/citizenship
requirements far more often than the new-grad-heavy population this was previously measured on.
Deadline extraction is still near-zero (0.8%) — unchanged conclusion from Finding 3: most
postings genuinely don't state one, this isn't an extraction miss.

Crawl health: 783/787 boards successfully crawled at least once, 5 currently carry a
`last_error`. No pruning action taken — all under Decision 11's ~2–3 month staleness threshold.

## Router false-reject spot-check + US/CS internship count (2026-08-25)

Prompted by the season-inflection finding above: were Decision 13/14's routers, tuned on
near-zero-internship corpora, actually wrong on this run?

**YOE-filter leak check (cheap — DB-only):** ran `minYearsExperience()` against all 495 active
keeps' `description_plain`, looking for a kept listing stating a minimum > 0 (would mean the
gate leaked). Found 7, all `opportunityType: internship`:

```
DRW :: Quantitative Developer Intern (Python)  -> parsed min 25
Epic Games :: Machine Learning Intern (x3)      -> parsed min 30
Truveta :: ML PhD Intern - LLMs & Generative AI -> parsed min 1
Zscaler :: ...SkillBridge Intern (x2)           -> parsed min 5
```

**Not filter bugs — the accept-router safety net working as designed.** All 7 titles contain an
explicit "Intern" + CS/eng token, so Tier 1 (accept-router) kept them regardless of body text
(Decision 14's ordering: accept-router runs BEFORE the YOE gate on purpose). The parsed numbers
are themselves false positives of `minYearsExperience`'s context-blindness — "25"/"30" are
almost certainly company-history mentions ("DRW has been trading for 25 years"), not a
candidate requirement, and Zscaler's "5" is SkillBridge-program military-experience eligibility,
not a professional-software-experience bar. **This is a real, concrete case of exactly what
Decision 14 predicted** ("an incidental '1 year program' in the description would otherwise drop
a genuine internship") — without the accept-router override, all 7 of these would have been
wrongly dropped.

**Live router retrace (partial — interrupted before completion):** re-fetched live boards for
DRW, Canonical, Anthropic, Anduril Industries, Hudson River Trading, and Astranis; for every
live intern/co-op-titled job, checked whether it's in `listings` (kept), `seen_listings`
(model-rejected, recorded), or neither (would need live tracing through today's routers).
DRW (22 intern titles) and Astranis (18) — every non-kept title was a recorded MODEL rejection,
not a silent regex/YOE drop. Anthropic's 7 intern/co-op-titled matches were all correctly
title-dropped (Tax/Deal-Desk/Internal-Comms roles that happen to contain "intern" as a
substring of "international"/"internal", not real internships). Anduril timed out (10s fetch
limit — a real board, not a router issue); Hudson River Trading's careers page isn't on
`job-boards.greenhouse.io`/`boards.greenhouse.io` so the token extractor found nothing. **No
false rejects found in the boards checked before this was interrupted** — Canonical, Anduril,
and HRT still need a real pass.

**US + CS-adjacent internship count: ~76 of 176 (43%), by manual read, not a location regex**
(per the Location Data Quality section above, a naive one is provably wrong on this data — e.g.
Toronto/Saskatoon false-matching a US state-code pattern). Breakdown of exclusions:

- Non-US location is the majority of the loss — DRW/Virtu/HRT/Zscaler all post identical roles
  across London/Dublin/Singapore/Toronto alongside their US postings; only the US copies count.
- Non-CS field despite `opportunityType = internship`: `10Beauty :: Consumer Insights Intern`
  (market research — audit's own Finding 5, still present), `Varda Space :: Biologics
  Formulation Research Internship` (pharma/biology, not CS), `Voyager Technologies :: Aerospace
  Technician` (not even internship-shaped), several Varda/True Anomaly/Vast mechanical-
  engineering roles (Decision 10 scopes "hardware" as computer hardware, not rocket propulsion
  — judgment call, may not match your intent).
- Bad location data independent of the US/CS question: `Epic Games :: Machine Learning Intern`
  has a `"BLANK,BLANK,Multiple Locations"` row — likely a real US posting, uncountable as
  written. `Cloudflare` has 3 rows with `location = "In-Office"` (no country at all); the 4th
  survives only because the TITLE names "Austin, TX", not the location field.
- `Compeer Financial :: Intern Engineering` has 2 rows (`"IL-Bloomington; MN-Mankato;
  WI-SunPrairie"` vs `"WI-Sun Prairie; IL-Bloomington; MN-Mankato"`) that look like the same
  posting with reordered/respaced location text — a live example of Decision 15's accepted
  tradeoff (exact-string key, no semantic normalization) letting a near-duplicate through.

Both the router-leak check and the US/CS count point the same direction as the Location Data
Quality section: the open location-normalization decision is now costing real, countable
listings (at minimum Epic Games' and 3 of 4 Cloudflare rows), not just a theoretical dedup risk.

**Pure-CS sub-breakdown of the 76.** Decision 10 scopes CS-adjacent broadly (SWE, data/ML,
security, hardware, quant, PM). Narrowing to core software/CS roles only (SWE, ML/data science,
security engineering, SRE) — excluding hardware/EE, quant, and PM as their own disciplines —
cuts 76 down to **38 (22% of the 176 total)**:

| category cut from the 76 | count | examples |
|---|---|---|
| Hardware/EE | ~15 | Astranis (13 of its 15 US roles: Avionics, CAD, Electrical Reliability, Environmental Test, PCB, Radiation Effects), Anduril EE, Virtu FPGA |
| Quant (research/trading) | ~9 | DRW Quant Research/Trading, Virtu Quant Researcher/Trading, HRT Algorithm Development (×2), CTC Quant Trading |
| PM | 2 | Databricks PM Intern, Datadog PM Intern |
| IT/Analyst/ops, not engineering | ~6 | AMOREPACIFIC IT Intern, Accenture Returning Summer Analyst, Zscaler Insider Risk Analyst, Compeer Intern Engineering (×4 — genuinely ambiguous, finance company, unclear if software) |
| Aerospace/mechanical-adjacent | ~6 | True Anomaly GSE Engineering, Varda GNC |

Judgment call worth flagging: Verkada's 5 "___ Software Engineering Intern" roles (Backend/
Embedded/Frontend/Mobile/Security) were all counted as pure CS since the titles explicitly say
"Software Engineering," including Embedded — a different reader might draw that line elsewhere.

Funnel: **176 tagged internship → 76 US + CS-adjacent (broad, Decision 10's actual scope) → 38
US + pure CS (narrower reading).** Which number is "right" depends on which scope the hub is
optimizing for — this is presented as a breakdown, not a recommendation to narrow Decision 10.

## Reclassify sweep results (2026-08-27, Decisions 16–19 applied)

Full `reclassify --extract` over 1,817 actives: 1,623 kept, 194 delisted (~10.7%), 0 errors;
every delist has its paired `seen_listings` key (resurrection invariant held). cs_field filled
on 95% of keeps (swe 573, ml_ai 249, quant 179, data 155, hardware 105, devops 98, other 91,
null 83, security 39, it 34, product 17). Location facets: 92% ≥1 country; 665/728 US rows
have a state. Grad dates: 243 stated windows, 109/109 fall-window class-year derivations
correct (e.g. Databricks `2027-09..2028-06 → 2028..2028` — the Decision 17 motivating case).

Delists split into the two intended categories: service-side IT (Decision 16 targets, e.g.
"IT Service Desk Intern") and experienced roles previously false-kept ("Research Scientist"
anchoring to the `research` type — an unpredicted bonus of the prompt revision).

**Measured asymmetry: reclassify bypasses the accept-router tier** (it calls the model
directly), so router-protected titles are exposed to pure model judgment. Cost this sweep:
2 of 194 delists had router-protected titles — Neuralink "Electrical Engineer Intern, Implant
Embedded Systems" (likely false delist) and ThreatLocker "Jr Cyber Hero Intern" (likely
correct; product-support branding). All 7 previously-documented router-saved canaries (DRW,
Epic ×3, Truveta, Zscaler) survived. At 1/194 error rate, no structural guard added —
accepted; revisit if future sweeps show more.
