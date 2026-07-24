# Greenhouse board discovery — options & notes

Context for the (open, GATED) decision on how crawl targets are discovered and stored.
Companion to the target-storage question (hardcoded array vs config file vs DB table).
No decision made yet — log in DECISIONS.md when settled.

## Facts established

- No official directory of Greenhouse customers/board tokens exists; a token is the slug
  in `https://boards.greenhouse.io/{token}` (or `job-boards.greenhouse.io/{token}`).
- Board tokens are NOT predictable from company names (could be `stripe`, `stripeinc`, …),
  so dictionary brute force has terrible hit rate (~100k requests for a few hundred hits)
  and mass-404 sweeps are the most plausible way to get IP-blocked. Ruled out on
  cost/yield/risk grounds.
- Yield math: a large tech board (GitLab, 179 jobs) → ~5–20 CS-adjacent early-career
  roles; small startup boards often 0–2. "Thousands of active listings" implies several
  hundred boards across the three ATSes. A hand-picked 20–30 boards ≈ 100–300 listings
  (fine for Phase 1, below end-state metric).
- Sequential daily crawling (current orchestrator) is naturally gentle; rate limiting
  only becomes live with concurrency or high-volume discovery sweeps.

## Discovery sources considered

| Source | Cost | Yield/quality | Risks |
|---|---|---|---|
| Curated GitHub lists (e.g. SimplifyJobs Summer/New-Grad repos) | Near zero — parse greenhouse URLs out of the README/data | High relevance (already intern-focused), includes small/mid companies | Inherit list quality + repo format/continuity |
| Search engine `site:boards.greenhouse.io` | Manual: free. Automated: ToS violation or paid search API | Broad | Automation ToS; noisy |
| Common Crawl URL index | Real engineering (learn their index API, staleness filtering) | Most comprehensive; zero load on Greenhouse | Stale/dead boards mixed in (404 handling tolerates) |
| Manual curation | Slow | Highest precision | No discovery of unknowns |
| Dictionary brute force against the API | ~100k requests | Few hundred hits | IP block risk; ruled out |

## Key architectural framing

Discovery vs refresh are different jobs with different cadences:

- **Discovery** = find candidate tokens; expensive, low-frequency (weekly/monthly), may be sloppy.
- **Refresh** = daily crawl of known-good boards (the existing pipeline).
- A board enters the refresh set only after validation (200 + jobs present).
- This split couples to target storage: a hardcoded array can't absorb a discovery feed;
  a DB table can.

## Option space (open)

- **A.** Curated static list only (~20–100 boards) — cheapest; plateaus below listings metric.
- **B.** Seed from curated GitHub lists — near-zero effort, hundreds of relevant companies fast.
- **C.** Common Crawl discovery job + validated refresh set — most complete/defensible; most engineering; pushes storage toward DB table.
- **D.** Stage it: A/B now, C later as the Phase 3 differentiator.
