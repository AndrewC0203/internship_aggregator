# ATS API Comparison: Greenhouse, Lever, Ashby

## Overview: Three Different Perspectives

Each ATS models jobs differently. Your schema must normalize these three views into one consistent data model.

---

## 1. Pagination Strategy

| System | Type | Implementation | Total Count | Notes |
|--------|------|---|---|---|
| **Lever** | Offset-based | `?offset=N&limit=M` | Yes, `total` field | Simple, stateless |
| **Greenhouse** | Link-based (RFC 5988) | Follow `Link` headers | No explicit total | Must parse HTTP headers |
| **Ashby** | Cursor-based (opaque) | `?cursor=token` | No, iterate until `moreDataAvailable=false` | Opaque tokens |

**Schema Impact**: Your ingestion layer must handle three pagination strategies. Consider a common abstraction (e.g., `async iterable` that yields pages regardless of strategy).

---

## 2. Job vs Posting Concepts

| System | Model | Structure | Application Link |
|--------|-------|-----------|---|
| **Lever** | Single `posting` object | One job = one record | Direct in `applyUrl` |
| **Greenhouse** | `job` + `job_board_post` (two objects) | One job can have 1+ postings | Harvest: no direct link; Job Board: yes |
| **Ashby** | `job` + `jobPosting` (parent-child) | One job can have multiple postings | Child jobPosting has `applyUrl` |

**Normalized Model Question**: 
- Do you store "job" and "posting" as separate entities or collapse them?
- Lever doesn't distinguish; Greenhouse & Ashby do.
- Impact: Foreign key relationships, deduplication logic, refresh strategy.

---

## 3. Location Modeling

| System | Primary | Secondary | Hierarchy | Notes |
|--------|---------|-----------|-----------|-------|
| **Lever** | `location` (string) | `allLocations[]` (array of strings) | Flat | No structured address |
| **Greenhouse** | `offices[]` (array) | N/A (all in one array) | Parent-child via `parent_id` | Offices hierarchical, structured address |
| **Ashby** | `location` (string) | `secondaryLocations[]` (array) | Flat | Structured `postalAddress` object |

**Normalized Model Question**:
- Store locations as strings or structured `{city, state, country}` tuples?
- Do you need hierarchical office structure (Greenhouse use case)?
- How do you deduplicate "San Francisco, CA" vs "San Francisco, California"?

---

## 4. Compensation

| System | Availability | Structure | Granularity |
|--------|---|---|---|
| **Lever** | Optional nested | `salaryRange` object: `{currency, interval, min, max}` | Single range, single interval |
| **Greenhouse** | Custom field | Can be in custom_fields as structured data; may be text | Custom field format (user-defined) |
| **Ashby** | Optional, queryable | `compensationTiers[]`: multiple tiers, each with components (salary, equity, bonus, commission) | Multi-tier, multi-component |

**Normalized Model Question**:
- Do you expose compensation at all?
- If yes, what's your target structure? (simple range? full Ashby-style tiers?)
- Greenhouse custom fields may not have structured compensation.

---

## 5. Departments & Teams

| System | Departments | Teams | Hierarchy | Linked How |
|--------|---|---|---|---|
| **Lever** | `categories.department` (string) | `categories.team` (string) | Flat | Flat strings in categories object |
| **Greenhouse** | `departments[]` (array of objects) | Via hiring team | Hierarchical parent-child | Array of department objects on job |
| **Ashby** | `department` (string) | `team` (string) | Flat | Flat strings on posting |

**Normalized Model Question**:
- Will you store departments as strings or objects?
- Greenhouse has hierarchy; Lever & Ashby don't. Do you flatten or preserve?
- Do you create a department/team lookup table or inline as strings?

---

## 6. Job Status & Lifecycle

| System | Status Field | Values | Lifecycle Signals |
|--------|---|---|---|
| **Lever** | Implicit (active postings only) | N/A | `createdAt`, position in list implies active |
| **Greenhouse** | `status` | `open`, `closed`, `draft`, `archived` | `opened_at`, `closed_at`, `closed_reason` |
| **Ashby** | `isListed` (boolean) | True/false | `publishedAt`; separate unlisted postings |

**Normalized Model Question**:
- How do you distinguish active/inactive jobs?
- Lever shows only active; Greenhouse tracks explicit status; Ashby has `isListed` flag.
- Do you refresh based on status or presence?

---

## 7. Identifier Strategy

| System | Primary Key | Secondary IDs | External References |
|---|---|---|---|
| **Lever** | `id` (string UUID) | None | Can map by custom job URLs |
| **Greenhouse** | `id` (integer) | `requisition_id` (text), Job Board: separate `id` | Links: `internal_job_id` |
| **Ashby** | `id` (UUID) | None directly; `jobId` on posting | `jobBoardId` optional |

**Deduplication Question**:
- Lever: one ID space
- Greenhouse: Harvest job ID vs Job Board post ID (need join)
- Ashby: job ID vs jobPosting ID (need join)
- How do you link the same "role" across multiple ATS systems?

---

## 8. Custom Fields & Extensibility

| System | Custom Fields | Availability | Access Method |
|---|---|---|---|
| **Lever** | Not documented | Unknown | N/A |
| **Greenhouse** | Yes, via `custom_fields` and `keyed_custom_fields` | Required for some customers | Dual format: GET (key-value), POST/PATCH (typed objects with `id` or `name_key`) |
| **Ashby** | Yes, via `customField.list` + `expand` param | Optional expansion | Must query separately; stored on parent `job`, not `jobPosting` |

**Extensibility Question**:
- Will you store custom fields?
- If yes, flatten them or store as JSONB?
- Greenhouse requires format translation (GET vs POST); Ashby requires separate query.

---

## 9. Description & Content

| System | Format | Fields | HTML Handling |
|---|---|---|---|
| **Lever** | HTML + plaintext | `opening`, `openingPlain`, `description`, `descriptionPlain`, `lists[]` | Multiple variants provided |
| **Greenhouse** | HTML (custom fields may text) | `team_and_responsibilities`, `how_to_sell_this_job`, notes (HTML) | Embedded HTML; no plaintext variant |
| **Ashby** | HTML + plaintext | `descriptionHtml`, `descriptionPlain`, optional `descriptionParts` | Both formats provided |

**Storage Question**:
- Store HTML, plaintext, or both?
- How do you extract key content (required skills, salary) from free-form HTML?

---

## 10. Metadata & Structured Data

| System | SEO | Application Form | Compliance |
|---|---|---|---|
| **Lever** | None documented | Implicit via apply flow | None |
| **Greenhouse** | Demographic questions, data compliance, pay input ranges | Customizable via `questions[]` | `data_compliance[]` (GDPR, retention) |
| **Ashby** | `linkedData` (Schema.org jobPosting) | `applicationFormDefinition` | None visible |

**Question**: Will you expose compliance metadata or application form schema to users?

---

## 11. Rate Limiting & Pagination Efficiency

| System | Limit | Window | Resumability |
|---|---|---|---|
| **Lever** | 10 req/sec sustained, 20/sec burst | Per IP | Stateless offset |
| **Greenhouse** | Per 10-second window | Per API key | Must follow `Link` headers; stateful |
| **Ashby** | 1000 req/min | Per API key | Cursor tokens are opaque; must store for resumption |

**Infrastructure Question**:
- How do you track rate limit state?
- Ashby cursors need storage for resumable syncs; Greenhouse requires header parsing.

---

## The Core Normalization Challenge

Your unified schema must bridge these three models. Key decisions ahead:

1. **Job vs Posting**: Do you split the concept or merge?
2. **IDs**: How do you uniquely identify a role across all three systems?
3. **Locations**: Strings or structured objects? Hierarchical?
4. **Compensation**: Present and structured, or optional and custom?
5. **Custom Fields**: Ignored, stored as JSON, or extracted to top-level fields?
6. **Status**: How do you track freshness and liveness across three different status models?
7. **Pagination**: Abstract to a common interface or handle per-ATS?

---

## Recommendations for Next Steps

**Before designing the schema:**

- Clarify what fields are *core* (must have for search/display) vs *optional* (nice-to-have)
- Decide: are you building for multi-ATS comparison (show all three views) or a unified job index?
- Decide: is "same role posted on Greenhouse and Lever" one record or two?
- Sample real data from each ATS to see field coverage in practice

**Then present options:**

1. **Minimal normalized schema** — Only core fields (title, location, dept, salary, link, source), drop Ashby tiers and Greenhouse hierarchy
2. **ATS-agnostic but flexible** — One job record, store ATS-specific fields as JSONB blobs on the side
3. **Data lake then transform** — Ingest raw JSON per ATS, normalize in a separate layer (staging table → reporting table)
