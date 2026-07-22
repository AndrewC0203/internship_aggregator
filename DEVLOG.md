# DEVLOG

## July 20, 2026

### Goal for Today

No goal for this date is recorded anywhere in the DEVLOG — there is no prior entry to pull
it from, so it can't be reconstructed from source data.

### What I Did

No commits landed in the Git repository between 2026-07-20T00:00:00-04:00 and
2026-07-20T23:59:59-04:00 (`git log --since/--until` for that window returns nothing). The
closest surrounding commits are "Finalized db schema in finalized_decisions" / merge on
2026-07-18, and "Scaffold Prisma + initial listings schema and migrations" on 2026-07-21 —
so July 19–20 was a two-day gap with no repo activity. No meaningful work occurred on this
date.

### What I Learned

No claude-mem data is available for this date. The `claude-mem-exports` branch does not
exist yet on the remote at all (not just missing the July 20 file) — the nightly export job
referenced in the PM protocol appears to have never run or never been set up, so there is
currently no claude-mem source for any date, not only this one.

### Progress on Goal

Not Completed — no goal was recorded for this date in DEVLOG, and no Git or claude-mem
evidence of work exists for it either.

## July 21, 2026

### Goal for Today

No goal for this date is recorded anywhere accessible to this process — DEVLOG entries
don't capture the "Goal for Today" from the prior morning's brief, and this run has no
memory of the chat turn where that brief was delivered, so it can't be reconstructed from
source data. (See the process note under Progress on Goal below.)

### What I Did

Two substantive commits landed. First, the Prisma scaffold: `prisma/schema.prisma` defines
the `Listing` model and five enums (Source, EmploymentType, WorkplaceType, CompInterval,
CitizenshipStatus) matching the schema agreed in `finalized_decisions/schema.md`, with an
init migration plus a follow-up migration fixing `comp_min`/`comp_max` to `Decimal(12,2)`.
Prisma was pinned to v6 and TypeScript to 5.9.3 (v7's prebuilt binary doesn't run on
arm64), `tsconfig.json` was added (NodeNext module resolution), and `.gitignore` now
excludes `node_modules`/`.env`/`dist`/logs. This is captured as Decision 8 in DECISIONS.md.

Second, the ingestion pipeline skeleton: a staged architecture — per-source `fetch` +
pure `normalize` for Greenhouse, Lever, and Ashby, feeding shared stages (`dedup` ->
`filterInternships` -> `extract` -> `persist`) wired by a single orchestrator. Every
source and stage file was created as a stub that throws "not implemented" — none of the
actual fetch, normalize, dedup, filter, extract, or persist logic exists yet. Shared types
(`NormalizedListing`, `EnrichedListing`) were defined, along with a singleton
`PrismaClient` (`src/db.ts`) and a smoke-test entrypoint (`src/index.ts`) that connects to
Postgres and counts rows. This design — including the dedup write-handling approach
(link duplicates rather than delete them; suppress a duplicate's write only while its
canonical listing is active, so a still-live role resurfaces once its canonical goes
stale) — is captured as Decision 9 in DECISIONS.md, with the architecture also written up
in `finalized_decisions/pipeline.md`.

A third, minor commit reformatted the July 20 DEVLOG entry (added blank lines after
headers) — no content change.

Net: real architectural and schema progress, but everything built today is scaffolding —
correctly typed, wired, and stubbed out, with zero business logic implemented yet.

### What I Learned

No claude-mem data is available for this date. The `claude-mem-exports` branch still does
not exist on the remote — same gap flagged in yesterday's entry — so the nightly export
job does not appear to be running yet. Nothing below is inferred from commit messages or
code comments in place of claude-mem; per protocol, this section only reports what
claude-mem actually contains, and today it contains nothing.

### Progress on Goal

Not Completed / Not assessable — no goal was recorded for this date in any source this
process can read. Process note: the DEVLOG protocol currently has no durable place to
record the "Goal for Today" stated in a morning brief, so the following day's run can't
read it back to score progress against it. Recommend the goal be written into DEVLOG.md
(or another repo file) at the time it's set, so it persists for the next day's PM run.
Separately from that gap, Git shows the day was clearly productive: the Prisma/DB layer
and the pipeline's module structure are both now in place.
