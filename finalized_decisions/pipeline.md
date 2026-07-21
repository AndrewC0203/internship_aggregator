# Ingestion Pipeline — Architecture

Finalized structure for the ingestion pipeline. Rationale and alternatives: see
DECISIONS.md → Decision 9 (don't duplicate it here).

## Shape

```
per-source:   fetch ─▶ normalize ─┐
              (Greenhouse)         │
              fetch ─▶ normalize ─┼─▶ dedup ─▶ filter ─▶ extract ─▶ persist
              (Lever)              │  (shared, orchestrated stages)
              fetch ─▶ normalize ─┘
              (Ashby)
```

- **fetch** (per source) — HTTP + pagination for one ATS. Rate limiting (GATED) and
  retry/backoff (FIRST-DRAFT-MINE) are *not* baked in yet — separate decisions.
- **normalize** (per source, pure function) — raw payload → `NormalizedListing`. No I/O,
  so it's unit-testable against fixture JSON. Field mapping per
  `finalized_decisions/schema.md` + `research/ats-field-reference.md`.
- **dedup** (shared, FIRST-DRAFT-MINE) — links cross-source duplicates; does not delete.
  See "Dedup" below.
- **filter** (shared, GATED classification) — keep internships only. Cheap regex pass
  first, then AI model on survivors. (Regex must not be a lossy hard gate — it would drop
  co-ops / "Summer Analyst" roles.)
- **extract** (shared, GATED classification) — AI model pulls `grad_year_*` and
  `citizenship_status` from `description_plain` (needs the body, not just the title).
- **persist** (shared, FREE) — upsert on the natural key `(source, source_external_id)`,
  refreshing `last_seen_at`.

## Dedup write handling (Decision 9)

- **Link, don't delete.** Duplicates are recorded, not silently dropped.
- **Storage:** an array column on the canonical row holding each suppressed duplicate's
  `(source, external_id)`. (Exact array representation + migration: TBD when dedup is built.)
- **Suppress-while-active, resurrect-on-death:** a duplicate isn't written while its
  canonical is active. When the canonical goes inactive (stale `last_seen_at` →
  `is_listed = false`), the next cycle writes the duplicate, so a still-live role reappears.
- **KEY INVARIANT:** only suppress a duplicate against a *currently-active* canonical. If
  the canonical is inactive, write the duplicate — otherwise a live role never resurfaces.
- **Accepted costs:** ≤1 refresh-cycle visibility gap after a canonical dies; only one
  source's apply URL surfaced at a time.

## Tier map (who writes what)

| Stage | Tier | Status |
|---|---|---|
| fetch | FREE (client) — but rate-limit GATED, retry/backoff FIRST-DRAFT-MINE | stub |
| normalize | FREE (mapping from agreed schema) | stub |
| dedup | FIRST-DRAFT-MINE | stub — you write v1 |
| filter | GATED (classification) | stub — approach undecided |
| extract | GATED (classification) | stub — approach undecided |
| persist | FREE | stub |
| orchestrator | FREE (wiring) | scaffolded |

## Open sub-decisions

- Dup array-column representation + migration (when dedup is built)
- Company/board list source: hardcoded config vs. DB table
- Rate limiting approach (GATED); retry/backoff (FIRST-DRAFT-MINE)
- Classification/extraction approach for filter + extract (GATED)
