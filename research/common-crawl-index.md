# Common Crawl URL Index (CDX) — API notes for board discovery

Verified 2026-07-24 against the live endpoint. Supports Decision 11 (Common Crawl board
discovery). This is raw API research; the settled approach lives in DECISIONS.md 11.

## Endpoints

- **Crawl list:** `GET https://index.commoncrawl.org/collinfo.json`
  Returns an array of crawls, **newest first**. Each: `{ id, name, "cdx-api", from, to, ... }`.
  Latest observed: `CC-MAIN-2026-25` (June 2026). Pick `crawls[0].id` for "latest".

- **URL index (CDX) per crawl:**
  `GET https://index.commoncrawl.org/{crawlId}-index?url={pattern}&output=json`
  - `url=boards.greenhouse.io/*` matches every captured URL under that host.
  - `output=json` → **NDJSON** (one JSON object per line), NOT a JSON array. Parse line by line.
  - `fields=url` → restrict output to just the `url` field: `{"url": "https://boards.greenhouse.io/gitlab"}`.

## Pagination

- Add `&showNumPages=true` → `{"pages": N, "pageSize": ..., "blocks": ...}`. Read `.pages`.
- Then fetch each page `&page=0` … `&page=N-1`. Fetch pages **sequentially** — CC's index
  is a free public service; do not parallelize against it. (This politeness constraint is
  fixed toward CC and is unrelated to the GATED ATS rate-limit decision.)

## Gotchas (why the code is shaped the way it is)

- **`collapse=urlkey` is unreliable here** — returned an nginx `502 Bad Gateway` on
  2026-07-24 while the same query without it succeeded. We do NOT use `collapse`; dedup is
  done client-side after slug extraction (we have to dedupe anyway).
- Results are dirty: the same board appears many times (once per captured page), and rows
  include deep paths like `/{token}/jobs/4923909002`. Slug extraction takes the first path
  segment; dedup collapses the repeats. Example seen: `0x`, `0x/jobs/4923909002`.
- Two hosts are both in use: `boards.greenhouse.io` (legacy) and `job-boards.greenhouse.io`
  (current). Query both and merge.
- The index is a snapshot from the crawl window (`from`/`to`), so tokens can be stale
  (dead boards) or missing (boards created after the crawl). Staleness is handled by the
  live-API validation pass, not here.

## Observed yield & reliability (measured 2026-07-24, crawl CC-MAIN-2026-25)

- **~3,775 unique Greenhouse slugs** discovered across both hosts in ~12.5s (no validation).
- **Endpoint is flaky:** paging returned intermittent `502`/`503`/`504` — one measurement
  run took 3 attempts before completing. **Handled (2026-07-24):** the CDX layer
  (`cdxGetText`) now retries transient failures — no HTTP status (network/timeout), `429`, or
  any `5xx` — with exponential backoff (1s/2s/4s/8s, up to 4 retries); `4xx` like 404 is
  fatal (no retry). If a request still fails after retries, discovery **skips and continues**
  rather than aborting: a failed page is skipped (a few slugs lost), a failed page-count
  skips the whole host, and only a failed `collinfo.json` (no crawl id) is fatal. Verified
  live: a real 502 was caught, retried, and the run completed. Rationale: monthly cadence
  makes latency cheap and backfills any skipped pages next run; completeness is already
  best-effort. (Retry lives only in the CDX layer, intentionally NOT shared with the ATS
  board fetcher, which may want different retry logic.)
- **Dirty slugs are negligible:** only ~0.1% (2 of 3,774) contain percent-encoding, and one
  of those (`%7byour_company%7d` = `{your_company}`) is a template placeholder, not a real
  board. Decided NOT to URL-decode/trim: the fix would rescue ~1 real board (`%20forbes` =
  `forbes`) at the cost of decode+trim+re-dedup logic. Validation drops both as 404s anyway.

## Two-host embed form

Some boards embed via `boards.greenhouse.io/embed/job_board?for={token}` — the token is in
the `for` query param, not the path. `embed` as a first path segment is reserved, not a token.
