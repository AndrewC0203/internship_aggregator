# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user today is the project's author: a CS student doing their own internship/co-op/
new-grad/fellowship/research search under a live recruiting deadline. Single-user, no accounts
— confirmed by the schema (no `User`/auth model exists). Opening the hub to other CS students
is a known future direction, not a current requirement; do not design multi-user features
(accounts, saved searches, sharing) until that's explicitly greenlit.

## Product Purpose

A CS opportunities hub: aggregates internships, co-ops, fellowships, new-grad roles, research
positions, and part-time roles from company ATS boards (Greenhouse live; Lever and Ashby
planned), normalizes them into one schema, dedups, filters to CS-relevant and experience-
appropriate roles at write time, and stores them for search.

Success = thousands of active listings, <5% duplicate rate, a reliable daily refresh, and the
author being able to whiteboard every component for 30 minutes (CLAUDE.md).

## Positioning

Two mechanisms a generic board (LinkedIn, Handshake, a scraped-listing aggregator) can't
truthfully copy today:

1. **Write-time CS-relevance + experience-level filtering** (Decisions 10 and 14) — the hub
   drops non-CS and non-early-career roles before they're ever stored, instead of dumping raw
   ATS output and filtering at read time.
2. **Reach beyond already-visible postings** — discovery crawls ATS boards directly (via Common
   Crawl board discovery) rather than relying on companies that already have LinkedIn/Handshake
   visibility, surfacing smaller or less-obvious employers alongside Fortune-500 listings that
   are already posted everywhere.

Phase 3 ("ONE differentiator," CLAUDE.md) is still open — this is the current direction, not a
finalized, shipped feature. Don't treat it as settled beyond what Decisions 10/14 have shipped.

## Operating Context

- **Discovery** (`npm run discover`): Common Crawl-based ATS board discovery, upserts candidate
  boards into `crawl_targets`.
- **Refresh** (`npm run refresh`): the daily pipeline — fetch → normalize → dedup →
  partition-by-seen → filter (regex routers + local model) → extract (local model) → persist.
  Requires `ollama serve` running locally.
- **Reclassify** (`npm run reclassify`): re-runs the current classify/extract prompt against
  existing listings after a prompt change, without a full re-crawl.
- Runs today on the author's local machine (24GB M4 Pro); Decision 4 anticipates moving to a
  server later. Local LLM classification (Qwen2.5 via Ollama) means no data egress and no
  per-call cost, at the expense of local throughput/thermal limits.

## Capabilities and Constraints

- Confirmed: unified `Listing` schema across sources; Greenhouse adapter shipped and normalizing
  live data; Lever/Ashby adapters planned; write-time dedup; CS-relevance + years-of-experience
  write-time filtering (Decisions 10, 14); local LLM classify/extract; soft-delete via
  `is_listed` (stale listings kept for dedup history, not hard-deleted).
- **Not yet built:** the search API and minimal UI that Phase 1 (CLAUDE.md) calls for — this
  project is currently pipeline-only, no Fastify routes and no frontend exist yet.
- **No accounts/auth** — single-user by design for now (see Users).
- Constraint: ATS rate-limit posture currently caps discovery at 163 boards — the top blocker
  per `research/first-clean-run-audit.md`, gating everything downstream.
- Constraint: local model throughput is bounded by the 24GB M4 Pro (see
  `research/local-model-performance.md`).
- Undecided: UI/frontend stack — no framework chosen yet; ask when that build starts.
- Terminology: `opportunity_type` values are `internship`, `co_op`, `fellowship`, `new_grad`,
  `research`, `part_time` (Decision 10) — coexists with the raw ATS `employment_type` field.

## Brand Commitments

None yet. No product name beyond the repo name `internship_aggregator`, no established voice or
visual identity to preserve.

## Evidence on Hand

- `research/first-clean-run-audit.md` — first clean-run audit: listing counts, duplicate rate,
  market-supply measurements.
- `research/local-model-performance.md`, `research/local-model-classification.md` — local model
  throughput/sizing measurements on the author's hardware.
- `research/ats-rate-limits.md`, `research/ats-api-comparison.md`, `research/ats-field-reference.md`
  — per-source ATS research backing the adapters.
- No testimonials, case studies, press, or user-facing screenshots exist. Do not fabricate any
  of these for future design work.

## Product Principles

1. Filter at write time, not read time — reduce stored noise instead of storing everything and
   categorizing later (Decision 10).
2. Local-first processing — Ollama + a single Postgres/Redis service, no data egress, no
   per-call cost, defensible on a solo timeline (Decisions 1–4, 12).
3. Differentiate on relevance and reach, not raw volume — CS-appropriate, experience-appropriate
   roles, including ones not already saturating generic boards.
4. Presentable beats complete — under a live recruiting deadline, a working, explainable
   end-to-end slice outranks a half-built later phase.

## Accessibility & Inclusion

No product-specific requirement established; standard web accessibility practice applies when
UI work begins.
