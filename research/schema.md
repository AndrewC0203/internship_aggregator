# Database Schema Diagram

Visual companion to [finalized_decisions/schema.md](../finalized_decisions/schema.md)
(the `listings` column-level spec) and [data-flow.md](data-flow.md) (how rows get
here). Source of truth is always `prisma/schema.prisma` — this is a rendering of it,
not a second spec. Full rationale for any field lives in `DECISIONS.md`; this doc only
notes what isn't obvious from the name.

## Entity relationship diagram

There are no Postgres foreign keys between these three tables — each is written by a
different pipeline stage and joined only implicitly, by the shared `(source,
source_external_id)` natural key. The dashed lines below mark that logical
relationship, not an enforced constraint.

```mermaid
erDiagram
    LISTINGS {
        int id PK "surrogate key, no business meaning"
        enum source
        string source_external_id "ATS-native id, stored as text to unify Greenhouse ints + Lever/Ashby UUIDs"
        string company
        string title
        string description_html "canonical, needs sanitization before render"
        string description_plain "derived at ingest, feeds classify/extract/regex tiers"
        string location "nullable, single primary location only"
        string department
        enum employment_type "raw ATS value; inferred for Greenhouse"
        enum workplace_type "inferred for Greenhouse"
        decimal comp_min
        decimal comp_max
        string comp_currency "ISO 4217"
        enum comp_interval
        int grad_year_min "AI-extracted"
        int grad_year_max "AI-extracted"
        enum citizenship_status "AI-extracted"
        enum opportunity_type "AI-classified; our category, distinct from employment_type"
        timestamptz published_at
        timestamptz application_deadline "structured (Greenhouse) or AI-extracted fallback"
        timestamptz first_seen_at "stamped once, on create"
        timestamptz last_seen_at "bumped every refresh the row still appears"
        bool is_listed "soft-delete flag; row kept for dedup/history"
        string url
        json duplicate_keys "array of {source, sourceExternalId} suppressed into this row"
    }

    CRAWL_TARGETS {
        int id PK "surrogate key"
        enum source
        string token "board slug, e.g. gitlab; only field discovery derives from Common Crawl"
        bool is_active "soft-deactivation; pruning threshold still FIRST-DRAFT-MINE"
        timestamptz last_seen_in_discovery_at "written by discover, not refresh"
        timestamptz last_crawled_at "written by refresh, not discovery; null until first crawl"
        string last_error "nullable; last transient fetch failure, cleared on success"
    }

    SEEN_LISTINGS {
        enum source PK
        string source_external_id PK "composite PK with source; no surrogate id"
        timestamptz last_seen_at "bookkeeping for a future stale-key prune"
    }

    CRAWL_TARGETS ||..o{ LISTINGS : "token feeds fetch() that produces"
    LISTINGS |o..o{ SEEN_LISTINGS : "same natural key space, mutually exclusive membership"
```

## Reading the diagram

- **`LISTINGS` is the only table a user-facing query ever reads.** The other two exist
  purely to make the daily refresh idempotent and cheap — `crawl_targets` is discovery's
  output (Decision 11), `seen_listings` is the classifier's skip-memory (Decision 12).
- **`CRAWL_TARGETS → LISTINGS` isn't a row-level relation.** One target's board fetch
  produces zero-to-many raw jobs, each of which normalizes into at most one `Listing`
  row. There's no `crawl_target_id` column on `listings` — the link is "this token was
  crawled, its jobs became these rows," not a stored foreign key.
- **`LISTINGS` and `SEEN_LISTINGS` partition the same key space, never overlap.** A
  given `(source, source_external_id)` lives in exactly one of the two: a keep goes to
  `listings`, a model-rejected listing's key goes to `seen_listings`. `partitionBySeen()`
  (see data-flow.md) is what enforces this at read time — nothing enforces it as a DB
  constraint, since the two are separate tables by design (Decision 12: rejects never
  carry a full row, so non-CS content never reaches the product table).
- **`duplicate_keys` is the one denormalized column.** It's a JSON array, not a join
  table, because dedup.ts only ever reads/writes it as a whole and it's small (single
  digits observed, max 6) — see Decision 15 for why a join table would be ceremony here.
- **Two "seen" timestamps mean two different things.** `crawl_targets.last_seen_in_discovery_at`
  is about the *board* still existing on Common Crawl; `listings.last_seen_at` /
  `seen_listings.last_seen_at` are about the *listing* still being returned by a live
  crawl. Don't conflate them — a board can still be active discovery-wise while every
  job it ever posted has gone stale.
- **Every enum mirrors a Prisma enum 1:1** (`Source`, `EmploymentType`, `WorkplaceType`,
  `CompInterval`, `CitizenshipStatus`, `OpportunityType` in `prisma/schema.prisma`) —
  check there first if a value looks unfamiliar, rather than assuming this doc is stale.
