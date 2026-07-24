# ATS public API rate limits — Greenhouse, Lever, Ashby

Context for the (open, GATED) rate-limiting decision. No decision made yet — log in
DECISIONS.md when settled.

## Facts established

- All three public job-listing endpoints are unauthenticated and require no API key:
  - Greenhouse: `boards-api.greenhouse.io/v1/boards/{board_token}/jobs`
  - Lever: `api.lever.co/v0/postings/{site}?mode=json`
  - Ashby: `api.ashbyhq.com/posting-api/job-board/{jobBoardName}`
- None of the three publish a numeric rate limit for these endpoints. Each has a published
  limit somewhere in its docs, but always for a *different, unrelated* authenticated API:
  - Greenhouse: 75 req/30s — applies to Harvest API (employer-side), not the public boards.
  - Lever: 2 req/sec — applies to the apply-POST endpoint, not GET postings. (10 req/sec,
    burst 20, is the separate authenticated Data/Hire API.)
  - Ashby: 15 req/min — applies to `report.generate`/`report.synchronous` only.
- **No cap on number of distinct companies/boards queried is documented by any of the
  three.** All published/observed limits are throughput limits (how fast you hit one
  target), not a ceiling on how many distinct targets you track. Not finding a cap isn't
  proof none exists — just that it's undocumented and unobserved.
- Lever's postings-api README explicitly states postings "may be scraped by third
  parties" — the most permissive stance of the three.
- Ashby is the only one with anecdotal throttling evidence: third-party scrapers report
  429/403 under aggressive polling, with ~500–600ms delay between requests (~100 req/min)
  cited informally as safe. No equivalent reports found for Greenhouse or Lever.
- Sequential daily crawling (current orchestrator) is naturally gentle; this only becomes
  a live concern with concurrency or high-volume discovery sweeps (ties into
  [[greenhouse-board-discovery]]).

## Summary table

| ATS | Public endpoint | Documented rate limit | Anecdotal throttling signal |
|---|---|---|---|
| Greenhouse | boards-api.greenhouse.io | None | None found |
| Lever | api.lever.co/v0/postings | None | None found |
| Ashby | api.ashbyhq.com/posting-api | None | 429/403 reported by scrapers; ~100 req/min informal safe rate |

## Sources

- Greenhouse Job Board API: https://developers.greenhouse.io/job-board.html
- Greenhouse Harvest rate limiting: https://harvestdocs.greenhouse.io/docs/api-rate-limiting
- Lever Postings API: https://github.com/lever/postings-api
- Lever Data API: https://hire.lever.co/developer/documentation
- Ashby Public Job Posting API: https://developers.ashbyhq.com/docs/public-job-posting-api
- Ashby retries (webhooks, not API throttling): https://developers.ashbyhq.com/docs/retries
