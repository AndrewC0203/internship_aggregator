# Ashby source: posting-api contract + Common Crawl discovery (verified 2026-09-08)

Live verification behind the Ashby adapter (`src/sources/ashby/`) and discovery
(`src/discovery/ashby.ts`). Everything below was measured against the live API and the live
Common Crawl index, not docs — the Lever experience (research/ats-field-reference.md had
documented a response envelope that doesn't exist) made live capture the standing rule.

## Posting API contract

Endpoint: `GET https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true`

Boards sampled: Ramp (141 jobs, 2.5 MB), Notion (130), OpenAI (780), Cognition (91),
Linear (29). Fixture: `src/sources/ashby/__fixtures__/ashby.jobs.sample.json` (4 jobs,
mixed provenance, descriptions truncated).

| Property | Observed | Consequence |
|---|---|---|
| Envelope | `{ jobs: [...], apiVersion: 1 }` | Greenhouse-style wrapper, NOT Lever's bare array |
| Pagination | none — whole board in one response (OpenAI's 780 jobs in one body) | fetch is single-shot; "successful fetch = whole board" holds |
| ETag | `W/"job-board:<sha>"`, weak, **whole-board** | `If-None-Match` → genuine `304` (verified). Second real Decision 23 freshness source after Greenhouse; `supportsFreshness: true` |
| Unknown board | `404` + text body `Not Found` | maps to discovery's "empty" outcome via the duck-typed `status` |
| Without `includeCompensation` | `compensation` key absent entirely | normalize treats missing and hollow comp identically (all-null) |
| CORS/caching | `access-control-allow-origin: *`, `cache-control: public, max-age=60`, served via Cloudflare | public-by-design API; no auth, no key |

### Field observations (presence scan, Ramp's 141 jobs: every field 100% present, 0 nulls)

- `employmentType` is a real enum (unlike Lever's free-text `commitment`):
  `FullTime | PartTime | Intern | Contract | Temporary`. Observed across boards:
  FullTime, Temporary, Contract, Intern.
- `workplaceType`: `OnSite | Remote | Hybrid` — present on every sampled job.
  `isRemote` boolean kept as fallback only (`isRemote:false` → null, not "onsite" —
  it can't distinguish onsite from hybrid).
- `publishedAt` is ISO-8601 (Lever's `createdAt` is epoch **milliseconds** — different trap).
- `isListed` was `true` on all 1,171 sampled jobs — the public API appears to pre-filter —
  but normalize still drops `isListed:false` defensively; a dropped job is then treated as
  absent by the delist stage, which is the correct retirement path.
- No company field anywhere in the payload (one board = one company, same as Lever) →
  company comes from `NormalizeContext` (Decision 22's learned cache, else the slug).
- No application deadline field.

### Compensation shape (the subtle one)

`compensation.summaryComponents[]` aggregates across tiers. **Selection must key on
`compensationType === "Salary"`, never on `interval`**: OpenAI's equity component
(`EquityCashValue`) also carries `interval: "1 YEAR"` with null min/max — keying on
interval would surface a valueless equity row as the comp. Observed intervals:
`"1 YEAR"`, `"1 HOUR"` (hourly min/max are floats, e.g. 60.58 — fine for the
`Decimal(12,2)` columns). `"NONE"` appears on equity components.

Boards that never opted into public comp return a **hollow** object under
`includeCompensation=true` (`compensationTiers: []`, `summaryComponents: []`, null
summaries) — pinned in the fixture via Notion's intern posting.

## Common Crawl discovery

- `jobs.ashbyhq.com/robots.txt` disallows only `/meeting/`, `/b/`, `/api/` — **CCBot is not
  blocked** (unlike `jobs.lever.co` and `boards.greenhouse.io`). Latest-crawl mining works;
  no Lever-style walk-back needed. If that ever changes, switch to
  `mineFirstCrawlWithSignal` in `lever.ts` — noted in `src/discovery/ashby.ts`.
- Latest crawl at time of writing (CC-MAIN-2026-34): **6,139 captured URLs → 926 unique
  candidate tokens** across 2 CDX pages. That's the current discovery ceiling for Ashby.
- URL shapes: `/{org}`, `/{org}/{uuid}`, `/{org}/{uuid}/application`, heavily decorated
  with `utm_*`/`ref`/`embed=js` query params from downstream job boards (getro.com etc.).
  Token = first path segment, lowercased.
- Capped validation run (2026-09-08, `--limit 8`): 8 candidates → 7 valid, 1 dropped,
  0 errors — consistent with Greenhouse/Lever junk rates.

## What this unblocks

All three Phase-1 ATS sources are now real end-to-end (discovery → fetch → normalize →
shared tail). The GATED rate-limit decision still caps full sweeps; 926 more boards join
that queue.
