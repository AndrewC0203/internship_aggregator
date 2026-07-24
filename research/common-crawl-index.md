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

## Two-host embed form

Some boards embed via `boards.greenhouse.io/embed/job_board?for={token}` — the token is in
the `for` query param, not the path. `embed` as a first path segment is reserved, not a token.
