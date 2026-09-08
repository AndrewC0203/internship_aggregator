# Lever board discovery via Common Crawl — viability measurements

Date: 2026-09-08. Backs DECISIONS.md Decision 26. Question: does Common Crawl index
`jobs.lever.co` well enough to mirror the Greenhouse discovery approach (Decision 11)?

## Headline finding: Lever blocks CCBot — but only since late Oct 2025

`https://jobs.lever.co/robots.txt` now carries a **Cloudflare-managed content block**
(`# BEGIN Cloudflare Managed content`) that disallows `CCBot`, `GPTBot`, `ClaudeBot`,
`Amazonbot`, and other AI-associated crawlers wholesale. Common Crawl respects robots.txt,
so every crawl since the block contains ONLY robots.txt captures for the host — zero board
pages. This looks like Cloudflare's blanket AI-crawler managed ruleset, not a
Lever-specific anti-scraping decision (their documented public postings API at
`api.lever.co/v0/postings/{company}` remains open and is a different host).

## Unique board tokens per crawl (page-0 sweep of `jobs.lever.co/*`, robots.txt excluded)

| Crawl | Captures | Unique tokens |
|---|---|---|
| CC-MAIN-2026-34 (latest) | 62 | **0** |
| CC-MAIN-2026-30 | 78 | 0 |
| CC-MAIN-2026-21 | 70 | 0 |
| CC-MAIN-2026-12 | 79 | 0 |
| CC-MAIN-2026-04 | 89 | 0 |
| CC-MAIN-2025-51 | 82 | 0 |
| CC-MAIN-2025-47 | — | 0 |
| **CC-MAIN-2025-43** | 13,058 | **1,586** |
| CC-MAIN-2025-38 | 12,769 | 1,803 |
| CC-MAIN-2025-33 | 12,075 | 1,435 |
| CC-MAIN-2024-33 | 13,906 | 1,889 |

The cliff between 2025-43 and 2025-47 dates the block to ~late Oct 2025. Crawls before it
are rich and stable (~1,400–1,900 tokens each; CC-MAIN-2025-43 has 2 CDX pages, so the full
count is somewhat higher than the page-0 figure).

## Consequences for the design

1. **"Use latest crawl" (Greenhouse's default) yields zero for Lever.** Discovery must walk
   backward through crawls, newest first, and use the first with real tokens
   (`mineFirstCrawlWithSignal` in `src/discovery/lever.ts`). Walk-back beats pinning
   CC-MAIN-2025-43 in code: pinning goes stale silently, walk-back self-heals if Lever ever
   unblocks CCBot. A dead crawl costs ~2 tiny CDX requests to rule out.
2. **The token supply is frozen at Oct 2025.** Companies adopting Lever after that are
   invisible to this mechanism. The P2 supplementary source (community GitHub lists,
   FEATURES.md) is the intended gap-filler, not more CC mining.
3. **Staleness is already handled.** Every candidate is validated against the live API
   before becoming a crawl target (Decision 11's design) — dead 2025 boards just drop.
   Smoke run (2026-09-08, `--limit 15`): 15 candidates → 5 valid, 10 dropped, 0 errors.
   A 33% survival rate on an 11-month-old snapshot is consistent with expectations; expect
   several hundred live boards from the full ~1,600.

## Related findings

- **Greenhouse is half-affected by the same block.** `boards.greenhouse.io` (legacy host):
  0 captures in CC-MAIN-2026-34. `job-boards.greenhouse.io` (current host): 13,463
  captures / 748 unique tokens. Greenhouse discovery keeps working via the current host —
  no action needed, host list left as-is (the legacy host self-heals if unblocked).
- **`jobs.eu.lever.co` exists and is still crawlable** (982 captures / 74 tokens in
  CC-MAIN-2026-34 — EU-hosted boards, mostly EU companies). Deliberately excluded:
  `fetchLever` only speaks `api.lever.co`, so EU tokens would 404 in validation. Revisit
  only if EU coverage is wanted (needs `api.eu.lever.co` support end-to-end).
- **Lever tokens can contain dots** (e.g. `close.io`) — the extractor stays permissive on
  charset and lets live-API validation drop junk (`acme)`, `1840%26company`), same posture
  as Greenhouse.

## Method

Direct CDX queries against `index.commoncrawl.org` (`showNumPages` + `fields=url` page
fetches), unique first-path-segment counting, robots.txt fetched from the live host.
Requests were sequential; probing all listed crawls totalled ~20 requests.
