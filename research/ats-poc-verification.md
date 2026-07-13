# ATS API Proof-of-Concept — Verification Results

**Date:** 2026-07-13
**Purpose:** Verify that the three target ATS platforms (Greenhouse, Lever, Ashby) actually
return real SWE internship postings from their public APIs before we commit to building
adapters against them. This is a feasibility check, not an implementation.

**Method:** Live `curl` / HTTP GET against each platform's public job-board API. Every posting
below was confirmed in an actual API response — none are guessed or recalled.

---

## Endpoint patterns confirmed working

| ATS | Endpoint | Auth | Shape |
|---|---|---|---|
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{token}/jobs` (`?content=true` for descriptions; `/jobs/{id}` for one job) | none | `{ jobs: [...] }` |
| Lever | `https://api.lever.co/v0/postings/{slug}?mode=json` | none | bare JSON array `[...]` |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` | none | `{ jobs: [...] }` |

All three are unauthenticated public endpoints. No API key needed for read-only board access.

---

## Greenhouse — 5 verified

| Company | Board token | Job title | Job ID | Location |
|---|---|---|---|---|
| Stripe | `stripe` | Software Engineer, Intern | 8031833 | Bengaluru |
| Nuro | `nuro` | Software Engineer, AI Platform - Intern | 7351061 | Mountain View, CA |
| Neuralink | `neuralink` | Software Engineer Intern, BCI Applications | 6594422003 | South San Francisco, CA |
| Instacart | `instacart` | Machine Learning Engineer, PhD Intern (Fall) | 5917202 | US - Remote |
| Roblox | `roblox` | Senior ML Engineer, Account Identity - PhD Early Career | 7473686 | San Mateo, CA |

Rows 1–3 are clean SWE intern postings. Row 4 is an ML PhD intern. Row 5 is the weakest fit
(early-career, not a true intern) — included only as a "closely similar" fallback.

## Ashby — 5 verified

| Company | Slug | Job title | Job ID | Location |
|---|---|---|---|---|
| Ramp | `ramp` | Software Engineer Internship, Android | `67fadb77-…` | New York, NY |
| Notion | `notion` | Software Engineer Intern (Fall 2026) | `5b15697c-…` | San Francisco, CA |
| Replit | `replit` | Software Engineering Intern (Summer 2026) | `12737078-…` | Foster City, CA |
| Cohere | `cohere` | Software Engineer Intern (Fall / Winter 2026) | `8c035d3d-…` | Canada |
| Perplexity | `perplexity` | Internship - Search Backend Infra Engineer | `be94e89b-…` | London |

Cleanest results of the three. `applyUrl` is simply `jobUrl` + `/application`.

## Lever — 3 verified (NOT 5)

| Company | Slug | Job title | Job ID | Location | Commitment |
|---|---|---|---|---|---|
| Palantir | `palantir` | Forward Deployed Software Engineer, Internship - Commercial | `4d29249a-…` | New York, NY | Internship |
| Palantir | `palantir` | Forward Deployed Infrastructure Engineer, Internship - US Gov | `3db7e40a-…` | Washington, D.C. | Internship |
| Binance | `binance` | Binance Accelerator Program - Frontend Engineer (current students) | `f539d94a-…` | Asia | Accelerator |
| Zoox | `zoox` | Part-Time Student Worker – Manufacturing SW Engineer | `02f4bebd-…` | Hayward, CA | Contract |

**We could not find 5 distinct companies on Lever with a SWE intern posting.** ~130 candidate
slugs were probed; only Palantir had a deep intern bench. Weaker adjacent hits: Shield AI
(Electrical Engineering co-op), Veeva (Technical Consultant intern) — neither is SWE.

---

## Findings that affect design decisions

### 1. Company discovery is the real problem, not fetching
There is **no global "list all boards" endpoint** on any of the three platforms. Every API
call requires you to already know the company's board token/slug. The POC found companies by
*guessing* slugs (usually company-name-lowercased), which is not a scalable ingestion
strategy. **How we build and maintain the company→ATS-slug list is an unsolved, GATED
question** and is arguably the core engineering problem of Phase 1.

Guess hit-rate was poor: on Lever, the large majority of guessed slugs 404'd.

### 2. Naive `intern` substring matching is broken
Matching on the substring `intern` produces false positives:
- "**Intern**al Tools", "**Intern**al Communications"
- "**Intern**ational ..."
- "Database Engine **Intern**als"

Must exclude `internal` / `international`. Confirmed independently on both Greenhouse and
Ashby. This is direct input to the classification logic.

Conversely, real internships hide behind non-obvious titles that a strict `intern` filter
*misses*: "Binance Accelerator Program (for current students)", "Part-Time Student Worker",
"Spring Co-op". Title matching alone is insufficient — Lever's `categories.commitment` field
("Internship") is a stronger signal than the title.

### 3. Seasonality is real
Probed in mid-July 2026. Summer-2026 internships are largely closed; live postings skew
Fall 2026 / Summer 2027. Listing volume will vary a lot by month — relevant to the
freshness/quality scoring work and to setting expectations on the "thousands of active
listings" success metric.

### 4. Field shapes differ meaningfully (input to normalized schema)
- **Greenhouse:** `location` is a nested object (`location.name`). `absolute_url` is
  inconsistent across companies — some point to the company's own careers site (Stripe, Nuro),
  others to `boards.greenhouse.io` (Neuralink). The **`gh_jid` query param is the stable join
  key** across both the API and the public link — a good source-native dedup identifier.
- **Lever:** flat `text` for title; metadata nested under `categories`
  (`location`, `team`, `commitment`). Has a `createdAt` epoch-ms timestamp — useful for freshness.
- **Ashby:** flat `title`, `location`; both `jobUrl` and `applyUrl` provided.

Each platform expresses title, location, and commitment differently. Normalizing these three
is exactly the Phase 1 schema problem.

### 5. Volume sanity check
Boards are large where they exist (Palantir 276 postings, gopuff 814, Veeva 795, Binance 274,
OpenAI 728 on Ashby). Hitting "thousands of active listings" is plausible **if** company
discovery is solved — a few hundred good companies is enough.

---

## Verdict

All three APIs work, are public, unauthenticated, and return the fields we need.
**The POC succeeded: we can find real SWE internships from all three platforms.**

The binding constraint is not API access — it is **knowing which companies to ask about**.
