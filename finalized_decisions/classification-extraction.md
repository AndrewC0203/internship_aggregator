# Classification & extraction — finalized spec

Settled result of **DECISIONS.md Decision 12** (rationale + options live there; this doc is
the build target — don't duplicate the reasoning, point back to it). Amends Decision 10 and
refines the filter/extract stages of the Decision 9 pipeline. Model reasoning:
`research/local-model-classification.md`.

## Pipeline placement

Current shared tail (`src/pipeline/orchestrator.ts`): `dedup → filter → extract → persist`.
Finalized shape adds a partition step and splits the AI work:

```
normalize
  → dedup                         (FIRST-DRAFT-MINE — user's; exact ordering vs partition is theirs)
  → partition-by-seen             (NEW; skip listings already processed)
  → filter  = regex accept-router + AI classify pass   (Pass 1)
  → extract = AI extract pass on survivors              (Pass 2)
  → persist = keeps → listings, rejects → seen_listing
```

### partition-by-seen (new stage)
For the batch of normalized listings, drop any whose `(source, external_id)` is already known:
- present in `listings` (a prior keep), OR
- present in `seen_listing` (a prior reject).
Only the remainder continues. This is what makes "only the initial run is expensive" true.
Implemented as a set-membership check against both tables by natural key.

### filter — Pass 1 (regex accept-router, then AI classify)
1. **Regex accept-router (cheap, high-precision).** Accept a listing outright only if its
   title matches a **CS token AND an intern/co-op token** together, e.g.
   `(software|data|ml|machine learning|security|hardware|firmware|quant|swe|...)` AND
   `(intern|internship|co-?op)`. Accepted → `opportunity_type = internship` (or `co_op` for a
   co-op token), CS-relevance = true, **skip the AI classify call** (still goes to Pass 2 for
   extraction). Deliberately false-negative-heavy: anything not clearly matching falls through.
   MUST NOT accept on an intern token alone (would admit "Marketing Intern" — non-CS).
2. **AI classify** the rest with the local model → `{ cs_relevant: bool,
   opportunity_type: enum|null }`. `cs_relevant = false` OR out-of-scope type → **reject**.
   Otherwise → keep with the classified `opportunity_type`.

### extract — Pass 2 (AI, survivors only)
For each keep, extract `{ grad_year_min, grad_year_max, citizenship_status, application_deadline }`
from `description_plain`. Return **null on uncertainty** (existing Decision 7 / FEATURES rule —
don't guess a grad year off a salary/zip, or a deadline off a program end-date). For
Greenhouse, the structured `application_deadline` (where present) takes precedence over the
extracted one (Decision 7).

### persist
- Keeps → upsert into `listings` on `(source, source_external_id)` (existing persist behavior).
- Rejects → upsert their key into `seen_listing`.

## Model

- Runtime: **Ollama**, local (Mac now, server later — Decision 4 path).
- Model: **Qwen2.5-14B-Instruct (Q4_K_M)** primary; **Qwen2.5-7B-Instruct** throughput
  fallback for the initial sweep.
- **Enforce JSON output** (Ollama `format` with a JSON schema) for both passes — never rely on
  free-text parsing.

## `seen_listings` table (key-only)

Prisma model `SeenListing`, table `seen_listings` (migration `add_seen_listing`, applied
2026-07-27). Holds **rejects only** (keeps are recorded by their presence in `listings`).
Key-only — no description hash, so a reject is never re-evaluated.

| column | type | notes |
|---|---|---|
| `source` | enum (greenhouse\|lever\|ashby\|other) | part of composite PK |
| `source_external_id` | text | part of composite PK |
| `last_seen_at` | timestamptz | bumped each refresh the reject reappears (bookkeeping for a future prune) |

- `@@id([source, sourceExternalId])` — the composite PK *is* the whole row; no surrogate id.
- No other columns, no extra indexes yet.
- Pruning/GC policy for stale reject keys is **deferred and FIRST-DRAFT-MINE** (freshness-adjacent,
  like `CrawlTarget` pruning) — the column stores the timestamp a future policy will read.

## What this changes vs. the stubs

- `src/pipeline/stages/filter.ts` — implement regex accept-router + AI classify (was a GATED stub).
- `src/pipeline/stages/extract.ts` — implement the AI extract pass (was a GATED stub).
- `src/pipeline/orchestrator.ts` — insert the partition-by-seen stage before filter.
- `src/pipeline/stages/persist.ts` — also write rejects to `seen_listing`.
- Prisma: add the `seen_listing` model + migration.

## Explicitly NOT in scope here

- Seniority reject-router (considered, not adopted).
- Description-hash re-check of rejects (key-only chosen).
- Cloud/Haiku fallback (local-only chosen).
- `seen_listing` pruning policy (FIRST-DRAFT-MINE, deferred).
- Dedup internals (FIRST-DRAFT-MINE — user's).
