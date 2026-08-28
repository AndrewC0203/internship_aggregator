# Greenhouse Job Board API — conditional request support (measured 2026-08-28)

Backs DECISIONS.md Decision 23. Measured live against `boards-api.greenhouse.io` before
building the ETag path.

## Findings

- `GET /v1/boards/{token}/jobs?content=true` returns a weak validator on every 200:
  `etag: W/"..."`, plus `cache-control: max-age=0, private, must-revalidate`.
- The ETag is stable across back-to-back requests for an unchanged board (two consecutive
  HEAD/GET requests to the gitlab board returned the identical `W/"03ed6d43..."`).
- `If-None-Match: <etag>` is honored: replay returned **HTTP 304, 0 bytes, 0.128s**.
- Payload cost of a full fetch, gitlab board (218 jobs): **3,483,666 bytes in 0.394s**
  with `content=true`; 153,532 bytes in 0.186s without content.
- Round trip re-verified through the implemented fetcher (`fetchGreenhouse`): unconditional
  fetch → `kind: "ok"`, 218 jobs, etag captured; refetch with that etag → `kind: "not_modified"`.

## Implication

At 3,187 active boards, a mostly-unchanged daily sweep costs ~0.13s/board instead of
~0.4–1.5s and ~40x less transfer — the sequential sweep drops from ~30–90 min toward
~10–15 min without touching the (still-open, GATED) rate-limit posture: 304 revalidation
*reduces* load on Greenhouse. Weak-validator risk and the `--full` override are covered in
Decision 23's tradeoffs.
