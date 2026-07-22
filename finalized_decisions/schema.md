# Database Schema — `listings`

Finalized data model for the internship aggregator. One row per source listing.
Full rationale and alternatives considered: see DECISIONS.md → Decision 5 (and
Decisions 6 & 7 for description storage and deadline handling).

**Model:** single normalized flat table. ATS-specific richness is intentionally
flattened/dropped; fields a source doesn't provide are AI-inferred/extracted at ingest.

---

## Columns

### Identity / provenance

| Column | Type | Null? | Notes |
|---|---|---|---|
| `id` | integer (IDENTITY) | no | Surrogate **primary key**. No business meaning; used for FKs/URLs. |
| `source` | enum/text | no | `greenhouse` \| `lever` \| `ashby` \| (extensible for other sources). |
| `source_external_id` | text | no | The ATS's native id. Stored as text to unify Greenhouse integer ids with Lever/Ashby UUIDs. |

**Natural key:** `UNIQUE (source, source_external_id)` — the target of refresh upserts, so a listing is never re-inserted across runs. (Distinct from `id`; identifies "same listing across refreshes," not "same role across sources" — that's dedup's job.)

### Content

| Column | Type | Null? | Notes |
|---|---|---|---|
| `company` | text | no | Inline string; no separate companies table in v1. |
| `title` | text | no | Job title. |
| `description_html` | text | no | Canonical; for display. Requires sanitization before rendering (stored-XSS). See Decision 6. |
| `description_plain` | text | no | Derived from HTML at ingest; for classification/search. See Decision 6. |
| `location` | text | yes | Single primary location; multi-location intentionally dropped in v1. |
| `department` | text | yes | Greenhouse hierarchy flattened to a single string. |
| `employment_type` | enum | yes | `full_time` \| `part_time` \| `intern` \| `contract` \| `temporary`. Provided by Lever/Ashby, **inferred** for Greenhouse. |
| `workplace_type` | enum | yes | `onsite` \| `remote` \| `hybrid`. Provided by Lever/Ashby, **inferred** for Greenhouse. |
| `comp_min` | numeric | yes | Compensation lower bound. |
| `comp_max` | numeric | yes | Compensation upper bound. |
| `comp_currency` | text | yes | ISO 4217 (e.g. `USD`). |
| `comp_interval` | enum | yes | `hourly` \| `monthly` \| `yearly` \| `one_time`. Required to interpret comp_min/max. |
| `grad_year_min` | integer | yes | **AI-extracted**. |
| `grad_year_max` | integer | yes | **AI-extracted**. Range supports "graduating 2026 or 2027". |
| `citizenship_status` | enum | yes | `us_citizen_required` \| `no_sponsorship` \| `sponsorship_available` \| `unknown`. **AI-extracted**. Filter is P1. |
| `opportunity_type` | enum | yes | `internship` \| `co_op` \| `fellowship` \| `new_grad` \| `research` \| `part_time`. **AI-classified** (Decision 10). Coexists with `employment_type` (raw ATS); intern/part_time overlap intentional. |

### Dates / lifecycle

| Column | Type | Null? | Notes |
|---|---|---|---|
| `published_at` | timestamptz | yes | Source publish date. Lever `createdAt` (epoch-ms) converted. |
| `application_deadline` | timestamptz | yes | Structured (Greenhouse) or AI-extracted (Lever/Ashby + Greenhouse fallback). See Decision 7. |
| `first_seen_at` | timestamptz | no | When we first ingested the listing. |
| `last_seen_at` | timestamptz | no | Updated every refresh the listing still appears. |
| `is_listed` | boolean | no | Derived from `last_seen_at`. Soft-delete: a stale listing flips to `false`; the row is kept for history/dedup memory rather than hard-deleted. |

### Links

| Column | Type | Null? | Notes |
|---|---|---|---|
| `url` | text | no | Hosted/apply URL. |

---

## Key points to remember

- **Two keys, two jobs:** surrogate `id` is the PK (FKs/URLs); `(source, source_external_id)` is the natural key (upsert target, dedup-across-refreshes).
- **AI-extracted/inferred fields:** `employment_type` & `workplace_type` (Greenhouse only), `grad_year_min/max`, `citizenship_status`, and some `application_deadline`s. Same local-model pipeline — no second extraction path. Accuracy risk accepted for coverage.
- **No raw payload stored:** re-deriving a field later (e.g. after fixing an extraction bug) requires re-fetching from source, not reprocessing a blob.
- **Deferred to FIRST-DRAFT-MINE components (not in schema):** the staleness threshold + removal logic that consume `first_seen_at`/`last_seen_at`, and the dedup algorithm that groups listings into logical roles.
- **Flattened/dropped richness:** Ashby multi-tier comp → single min/max/currency/interval; Greenhouse dept hierarchy → one string; multiple locations → one primary.
