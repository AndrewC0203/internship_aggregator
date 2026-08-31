# ATS Field Reference — Greenhouse, Lever, Ashby

Complete field dictionaries per ATS, for use when designing the unified schema
(Decision 5). Only the **public-facing endpoints** are listed in full detail —
see the note on internal-vs-public in `ats-api-comparison.md` for why the
internal/Harvest-style objects are mostly out of reach for a third-party
aggregator.

---

## Greenhouse

### Job Board API (public) — `job_board_post` object

This is what you'll actually be pulling as an aggregator.

| Field | Type | Notes |
|---|---|---|
| `id` | integer | Public post ID |
| `internal_job_id` | integer \| null | FK to Harvest `job.id`; null for "prospect" posts |
| `title` | string | |
| `company_name` | string | |
| `first_published` | timestamp (ISO-8601) | |
| `updated_at` | timestamp | |
| `application_deadline` | timestamp \| null | |
| `requisition_id` | string \| null | External req reference |
| `language` | string | Language code |
| `absolute_url` | string | Direct link to posting |
| `include_ai_disclaimer` | boolean | |
| `ai_disclaimer` | string \| null | HTML |
| `ai_opt_out_request_url` | string \| null | |
| `metadata` | array | Custom fields as key-value pairs |
| `content` | string | HTML job description (only with `?content=true`) |
| `location.name` | string | Nested object, single field |
| `departments[]` | array\<object\> | Only with `?content=true` — see below |
| `offices[]` | array\<object\> | Only with `?content=true` — see below |
| `questions[]` | array\<object\> | Only with `?questions=true` — application form fields |
| `location_questions[]` | array\<object\> | Address capture fields, same shape as `questions[]` |
| `pay_input_ranges[]` | array\<object\> | See below |
| `demographic_questions` | object | EEOC-style questions, see below |
| `data_compliance[]` | array\<object\> | GDPR/consent metadata |

**`departments[]` item** (also appears on Harvest `job`):
`id`, `name`, `parent_id` (nullable), `child_ids[]`, `external_id`

**`offices[]` item**:
`id`, `name`, `location.name`, `primary_contact_user_id`, `parent_id` (nullable), `child_ids[]`, `external_id`

**`questions[]` / `location_questions[]` item**:
`required` (bool), `label`, `fields[]` — each field has `name`, `type` (`input_text` | `input_file` | `textarea` | `multi_value_single_select` | `multi_value_multi_select` | `input_hidden`), `values[]` (`{value, label}`)

**`pay_input_ranges[]` item**:
`min_cents`, `max_cents`, `currency_type`, `title`, `blurb`

**`demographic_questions` object**:
`header`, `description` (HTML), `questions[]` — each has `id`, `label`, `required`, `type`, `answer_options[]` (`{id, label, free_form}`)

**`data_compliance[]` item**:
`type` (e.g. `"gdpr"`), `requires_consent`, `requires_processing_consent`, `requires_retention_consent`, `retention_period` (days)

### Harvest API (internal, requires company's own auth) — `job` object

Listed for completeness; you likely won't have access to this per-company.

| Field | Type | Notes |
|---|---|---|
| `id` | integer | |
| `name` | string | |
| `requisition_id` | string \| null | |
| `status` | enum | `open` \| `closed` \| `draft` \| `archived` |
| `notes` | string | HTML, internal hiring plan |
| `confidential` | boolean | |
| `created_at` / `opened_at` / `closed_at` / `updated_at` | timestamp | |
| `is_template` | boolean | |
| `copied_from_id` | integer \| null | |
| `anywhere` | boolean | Remote flag |
| `team_and_responsibilities` | string | |
| `how_to_sell_this_job` | string | |
| `custom_fields` | object | Flat key-value on GET |
| `keyed_custom_fields` | object | Typed, with field metadata |
| `departments[]` | array\<object\> | Same shape as above |
| `offices[]` | array\<object\> | Same shape as above |
| `hiring_team.hiring_managers[]` | array\<object\> | `id, first_name, last_name, name, employee_id` |
| `hiring_team.recruiters[]` | array\<object\> | Same + `responsible` (bool) |
| `hiring_team.coordinators[]` | array\<object\> | Same shape as recruiters |
| `hiring_team.sourcers[]` | array\<object\> | Same shape as hiring_managers |
| `openings[]` | array\<object\> | See below |

**`openings[]` item** (capacity slots under one job):
`id`, `opening_id` (nullable), `status` (`open`\|`closed`), `opened_at`, `closed_at` (nullable), `application_id` (nullable), `close_reason` (`{id, name}` \| null), `custom_fields`, `keyed_custom_fields`

### Pagination / rate limit fields (not job data, but relevant to ingestion)
- `Link` HTTP header (`rel="next"`, `"last"`, `"prev"`)
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers

---

## Lever

### Posting object — `GET /v0/postings/{company}`

Single object, no internal/public split.

| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID) | |
| `text` | string | Job title |
| `categories.team` | string | |
| `categories.department` | string | |
| `categories.location` | string | Primary location |
| `categories.commitment` | string | e.g. `"Full-time"`, `"Internship"` |
| `categories.allLocations[]` | array\<string\> | All locations, primary included |
| `country` | string \| null | ISO 3166-1 alpha-2 |
| `opening` | string (HTML) | Opening paragraph, styled |
| `openingPlain` | string | Opening, plaintext |
| `description` | string (HTML) | Full description |
| `descriptionPlain` | string | Full description, plaintext |
| `descriptionBody` | string (HTML) | Body excluding opening |
| `descriptionBodyPlain` | string | Body, plaintext |
| `lists[]` | array\<object\> | Structured sections — `{text, content}` (heading + HTML body) |
| `additional` | string (HTML) \| null | Optional closing content |
| `additionalPlain` | string \| null | |
| `hostedUrl` | string (URL) | Lever-hosted job page |
| `applyUrl` | string (URL) | Application form URL |
| `workplaceType` | enum | `unspecified` \| `on-site` \| `remote` \| `hybrid` |
| `salaryRange` | object \| null | `{currency, interval, min, max}` |
| `salaryDescription` | string (HTML) \| null | |
| `salaryDescriptionPlain` | string \| null | |
| `createdAt` | integer | Epoch **milliseconds** |

### Pagination / filter query params
**Corrected 2026-08-31 against a live capture (Palantir board)** — the docs (and this file,
previously) are wrong/incomplete on the response envelope:
`limit` (max 100), `skip` (NOT `offset` — the public API uses `skip`, unlike the separate
authenticated v1 API's `offset`), `team`, `location`, `commitment` (all exact-match filters).
The response is a **bare JSON array of posting objects**, not an object wrapper — there is no
`total`/`hasNext`/count field anywhere in the response. Paginate by requesting `limit`-sized
pages and stopping when a page returns fewer than `limit` items.

### Conditional requests
Undocumented, but real: a live capture showed Lever sending a weak `ETag` per response, and a
matching `If-None-Match` genuinely 304s. It's scoped to ONE request (one exact `skip`/`limit`
query), though — likely a generic web-server content hash, not a designed API feature. A
multi-page board has no single request, and therefore no single ETag, that represents "the
whole board is unchanged," so this doesn't give paginated sources the same whole-board
conditional-fetch shortcut Greenhouse's single-response board API has (see Decision 23). See
`src/sources/lever/fetch.ts` for how the adapter treats this.

### Known gaps
No documented custom fields on the public Postings API. No explicit job status field — inactive/archived postings are simply excluded from the response. `categories.commitment` and `workplaceType` are free text the posting company chooses in their own Lever admin, not a closed enum — a live sample used `"Fixed-Term"` and `"Scholarship"` for non-full-time roles, neither of which is documented anywhere.

---

## Ashby

### `jobPosting` object — public posting-api and `jobPosting.list`/`jobPosting.info`

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `title` | string | |
| `location` | string | Primary location, e.g. `"Houston, TX"` |
| `secondaryLocations[]` | array\<object\> | Each: `{location, address: {postalAddress: {addressLocality, addressRegion, addressCountry}}}` |
| `department` | string \| null | |
| `team` | string \| null | |
| `isRemote` | boolean | |
| `isListed` | boolean | Whether publicly listed |
| `workplaceType` | enum | `OnSite` \| `Remote` \| `Hybrid` |
| `employmentType` | enum | `FullTime` \| `PartTime` \| `Intern` \| `Contract` \| `Temporary` |
| `descriptionHtml` | string | |
| `descriptionPlain` | string | |
| `descriptionParts` | object \| null | Segmented description content |
| `publishedAt` | ISO-8601 timestamp | |
| `address.postalAddress.addressLocality` | string | City |
| `address.postalAddress.addressRegion` | string | State/province |
| `address.postalAddress.addressCountry` | string | Country code |
| `jobUrl` | string (URL) | Public posting page |
| `applyUrl` | string (URL) | Application form |
| `linkedData` | object \| null | Schema.org JobPosting structured data (SEO) |
| `applicationFormDefinition` | object \| null | Custom application form config |
| `jobId` | UUID | FK to internal `job.id` |

### Compensation (opt-in via `includeCompensation=true`)

| Field | Type | Notes |
|---|---|---|
| `compensationTierSummary` | string | Human-readable, e.g. `"$81K–$87K • 0.5%–1.75% • Offers Bonus"` |
| `scrapeableCompensationSalarySummary` | string | Salary-only summary |
| `compensationTiers[]` | array\<object\> | See below |

**`compensationTiers[]` item**:
`id`, `tierSummary`, `title`, `additionalInformation`, `components[]` — each component: `id`, `summary`, `compensationType` (`salary`\|`commission`\|`equity`\|`bonus`), `interval` (`annual`\|`hourly`\|`one_time`), `currencyCode` (ISO 4217), `minValue`, `maxValue`

### Custom fields
Not inline on `jobPosting` — fetched separately via `customField.list`, attached to the parent `job`, not the posting. Requires `expand` param on `jobPosting.info`.

### Pagination
Cursor-based: `results[]`, `moreDataAvailable` (bool), `nextCursor` (opaque token). No total count.

### Request filter params
`location`, `department` (both case-sensitive exact match), `listedOnly`, `includeUnpublishedJobPostings`, `jobBoardId`, `cursor`, `includeCompensation`

### Response envelope quirk
All responses wrap in `{success: bool, results: [...], errorInfo?: {...}}`. Even 4xx-equivalent errors return HTTP 200 with `success: false` — don't rely on HTTP status alone for error handling.

---

## Quick cross-reference: field presence by category

| Category | Greenhouse (public) | Lever | Ashby |
|---|---|---|---|
| Title | `title` | `text` | `title` |
| Description (HTML) | `content` | `description` | `descriptionHtml` |
| Description (plain) | — (HTML only) | `descriptionPlain` | `descriptionPlain` |
| Location (string) | `location.name` | `categories.location` | `location` |
| Location (structured) | `offices[]` (hierarchical) | — | `address.postalAddress` |
| Multi-location | — | `categories.allLocations[]` | `secondaryLocations[]` |
| Department | `departments[]` (hierarchical objects) | `categories.department` (string) | `department` (string) |
| Team | — | `categories.team` (string) | `team` (string) |
| Employment type | — (not on public post) | `categories.commitment` | `employmentType` |
| Remote flag | — | `workplaceType` | `isRemote` + `workplaceType` |
| Compensation | `pay_input_ranges[]` | `salaryRange` | `compensationTiers[]` (richest) |
| Posted/published date | `first_published` | `createdAt` (epoch ms) | `publishedAt` |
| Updated date | `updated_at` | — | — |
| Application deadline | `application_deadline` | — | — |
| Apply URL | `absolute_url` (posting page; apply is embedded) | `applyUrl` | `applyUrl` |
| Custom fields | `metadata[]` | — (undocumented) | via separate `customField.list` |
| Status/active flag | implicit (post exists = active) | implicit (post exists = active) | `isListed` (explicit) |
| Internal-only fields | `notes`, `hiring_team`, `confidential`, `openings[]` (Harvest API only, requires per-company auth) | none documented | custom fields, hiring team (internal `job`, requires auth) |

This table is the fastest way to see where the three ATSes actually overlap
(title, description, location, some notion of department) versus where
they diverge (compensation granularity, structured vs. flat location,
explicit vs. implicit status) — which is exactly the surface area Decision 5
needs to resolve.
