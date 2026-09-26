# Simplify GitHub repo as a source — measurements (2026-09-25)

Backs Decision 38 (Simplify source, classification bypass amending Decision 10) and
Decision 39 (alias-key cross-source dedup amending Decision 15). Post-ingest outcomes
(2026-09-25, same day): 4,639 fetched → 3,760 persisted with 0 model calls; 524 feed
copies folded into ATS rows by the alias pass; 0.00% dup rate across 10,066 active rows. Measured against the live DB and the repo's machine-readable
listings file — not the README markdown table:

    https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json

13 MB JSON, one fetch, ETag-capable host (Decision 23 conditional fetch applies unchanged).

## Data shape

Fields per entry: `id` (UUID), `company_name`, `title`, `locations` (array), `url` (direct
ATS application link), `category`, `terms`, `sponsorship`, `degrees`, `date_posted` /
`date_updated` (unix seconds), `active`, `is_visible`, `source`.

**No description field exists** — this is why the AI classify/extract tail has nothing to
read for this source, and why Decision A (trust curation vs. title-only model pass) arises.

## Corpus size and reach

| Measurement | Value |
|---|---|
| Total entries | 17,168 |
| Active + visible | **4,639** |
| DB active listings at time of measurement | 6,298 (gh 2,135 / lever 1,400 / ashby 2,763) |
| Corpus growth if ingested | **+74%** |

URL host distribution of the active set — the value case:

| Host | Entries |
|---|---|
| Workday (uncrawlable today) | 1,789 |
| Other non-ATS hosts (uncrawlable today) | 1,978 |
| Greenhouse | 472 |
| Ashby | 292 |
| Lever | 108 |

81% of active entries live on hosts the crawler cannot reach — that reach, not volume, is
the argument for the source.

## Category / metadata distributions (active set)

- `category`: AI/ML/Data 1,687+11; Software 1,572+25; Hardware 824+1; Product 266+1;
  Quant 252 — all within Decision 10's CS-adjacent scope; maps deterministically to
  `cs_field`.
- `sponsorship`: "Other" 4,618 (99.5%); only 21 entries carry a real signal
  (5 "U.S. Citizenship is Required", 12 "Does Not Offer Sponsorship", 4 "Offers
  Sponsorship") → thin but free `citizenship_status` mapping.
- Multi-location entries: 673 (needs the array → semicolon-joined string convention the
  Decision 19 parser already handles).
- `terms` is noisy (entries from "Spring 2016" through "Spring 2029"; modal value
  Summer 2027 at 2,229) — not mapped to any column in v1.

## Cross-source duplicate exposure (drives Decision B)

| Measurement | Value |
|---|---|
| Active entries on GH/Lever/Ashby boards **already in `crawl_targets`** | **603** (257 boards) |
| Exact URL matches against active DB rows (query strings kept) | 280 — all Greenhouse |
| Caught by the current Decision 15 key (company, title, location) | **15** |
| Matching on company+title alone (case-insensitive) | 83 |
| Active entries on GH/Lever/Ashby boards **not** in `crawl_targets` | 242 (115 boards) → free discovery feed (follow-up, Decision 11 mechanism) |

Method notes:

- Lever/Ashby produced 0 exact URL matches only because Simplify appends `/apply` (Lever)
  and `/application` (Ashby) to the canonical posting URL — a canonicalizer or ID-parse
  closes that gap; the 280 is therefore a floor, ~603 the realistic exposure as boards get
  crawled.
- The decisive structural fact: **Simplify URLs embed the target ATS's own job ID** — the
  numeric GH id in `/jobs/<id>`, the Lever posting UUID, the Ashby posting UUID — which are
  exactly the `sourceExternalId` values our normalizers store (verified in
  `src/sources/*/normalize.ts`). Cross-source identity is provable by parsing, no fuzzy
  matching needed. This is the basis for the alias-key dedup option.
- The 15-of-603 catch rate confirms Decision 15's accepted tradeoff ("a second source with
  differently-formatted locations could reopen this") has now materialized: Simplify writes
  "Alpharetta, GA" where ATS payloads write fuller forms, so the exact-string key misses
  cross-source pairs almost entirely.
- Doing nothing would add roughly 600 user-visible duplicate pairs (~5%+ on its own),
  against the <5% success metric.

Stale-context note found while measuring: `crawl_targets` holds 6,573 rows — the "capped at
163 boards" figure in older notes/memory no longer describes the DB.
