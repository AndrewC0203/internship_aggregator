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

## July 22, 2026

### Goal for Today

No goal for this date is recorded anywhere accessible to this process — same recurring
gap noted in the July 21 entry: the morning brief's "Goal for Today" isn't persisted
anywhere this process can read back the next day.

### What I Did

No engineering commits landed in the Git repository between 2026-07-22T00:00:00-04:00 and
2026-07-22T23:59:59-04:00. The only commit timestamped in that window
(`3019065`) is this PM automation's own push of the July 21 DEVLOG entry — not
engineering work on the project. Checked `git branch -a` / `git ls-remote` for any
unmerged work on other branches (`claude/research-ats-apis`, `data-ingestion`) that might
belong to this window: both point to commits already on `main` from July 18 and July 21
respectively, so there is nothing outstanding elsewhere either. No meaningful engineering
work occurred on this date — this is the second zero-commit day in the last three (also
July 20).

### What I Learned

No claude-mem data is available for this date. The `claude-mem-exports` branch still does
not exist on the remote at all — this is now the third consecutive day this has been
flagged. This is no longer a one-off "laptop was off overnight" situation; the nightly
export job described in the PM protocol does not appear to have ever been set up. Worth
checking directly rather than assuming it will start appearing.

### Progress on Goal

Not Completed / Not assessable — no goal was recorded for this date, and separately, no
Git or claude-mem evidence of any work exists for it either.

## July 23, 2026

### Goal for Today

No goal for this date is recorded anywhere accessible to this process — same recurring
gap noted in the July 21 and July 22 entries: the morning brief's "Goal for Today" isn't
persisted anywhere this process can read back the next day.

### What I Did

No engineering commits landed in the Git repository between 2026-07-23T00:00:00-04:00 and
2026-07-23T23:59:59-04:00. The only commit timestamped in that window (`012d50f`) is this
PM automation's own push of the July 22 DEVLOG entry — not engineering work on the
project. Checked `git ls-remote` for unmerged work on other branches
(`claude/research-ats-apis`, `data-ingestion`): both still point to commits already
merged into `main` (July 18 and July 21 respectively), so there is nothing outstanding
elsewhere. No meaningful engineering work occurred on this date — this is the third
zero-commit day out of the last four calendar days (July 20, July 22, and now July 23;
only July 21 had real work in that span).

### What I Learned

No claude-mem data is available for this date. The `claude-mem-exports` branch still does
not exist on the remote at all — this is now the fourth consecutive day this has been
flagged (July 20, 21, 22, 23). This is not a transient "laptop was off overnight" gap; the
nightly export job described in the PM protocol does not appear to have ever been set up
or run successfully. Recommend checking the export job directly rather than waiting for
it to start appearing on its own.

### Progress on Goal

Not Completed / Not assessable — no goal was recorded for this date, and separately, no
Git or claude-mem evidence of any work exists for it either.

## July 24, 2026

### Goal for Today

No goal for this date is recorded anywhere accessible to this process — same recurring gap
noted in the July 21–23 entries: the morning brief's "Goal for Today" isn't persisted
anywhere this process can read back the next day.

### What I Did

A substantial, well-tested feature day, all on the `data-ingestion` branch and merged to
`main` via PR #2. Implemented the Common Crawl Greenhouse board-discovery subsystem end to
end (Decision 11): a `CrawlTarget` Prisma model + migration; per-source discovery modules
(`src/discovery/`) with Greenhouse fully implemented (CDX index query via an async
generator with early-stop, a pure slug parser, validation that reuses `fetchGreenhouse`,
and an orchestrator that upserts survivors) and Lever/Ashby left as fail-loud stubs; a
`npm run discover --crawl --limit` CLI; and research notes on the Common Crawl CDX API
contract and Greenhouse board discovery. Verified live (`discover --limit 5` kept 4/dropped
1, idempotent re-run produced no duplicate rows) with 10/10 tests and a clean `tsc`.

Two follow-up commits hardened this same day. First, a robust `validateToken` test suite
(13 cases covering every failure shape — real `GreenhouseFetchError` 404, plain status
object, 500/403/timeout/network, non-Error/null throws — plus two contract tests guarding
the no-retry tier boundary); no production code changed. Second, retry/backoff for the CDX
layer: Common Crawl's CDX endpoint intermittently 502/503/504s under load, which previously
aborted the whole discovery sweep. `withCdxRetry` now retries transient failures
(no-status/429/5xx) with exponential backoff (1s/2s/4s/8s, 4 retries) and treats 4xx as
fatal; after retries are exhausted, discovery skips-and-continues (a failed page is
skipped, a failed page-count skips that host, only a failed collinfo is fatal) instead of
aborting the run. 9 new tests; a real 502 was caught and retried in a live run. Full suite
now 32/32.

Separately, an unrelated commit (`ce85346`, "test new gh user in cursor bug") modified
`DEVLOG.md` directly and deleted the "What I Learned" narrative from the July 23 entry
above — see the flag under What I Learned below; that deletion has been reverted as part of
today's update since the original content was still recoverable from Git history.

Net: the discovery subsystem — the thing that was blocking the pipeline from having any
targets to crawl — is now implemented, tested, and hardened against the exact failure mode
(CDX 5xx) it hit on a live run the same day.

### What I Learned

No claude-mem data is available for this date. The `claude-mem-exports` branch still does
not exist on the remote at all (confirmed directly via `git ls-remote --heads origin`: only
`claude/research-ats-apis`, `data-ingestion`, and `main` exist — no `claude-mem-exports`
ref). This is now the fifth consecutive day this gap has been flagged (July 20–24). The
nightly export job described in the PM protocol does not appear to have ever been set up or
run successfully.

Flagging separately, not as a claude-mem finding: a same-day commit (`ce85346`, message
"test new gh user in cursor bug") deleted the paragraph above documenting this exact gap
from the July 23 entry, replacing it with two blank lines. It touched only `DEVLOG.md`, had
no relation to any engineering work from that day, and wasn't produced by this PM process.
The deleted text has been restored above from Git history rather than left missing. Given
the content deleted was specifically the flag about the missing export job, this is worth
your attention directly — confirm whether this was an intentional/accidental local edit
(e.g. an errant Cursor action, per the commit message) rather than something to wave off.

### Progress on Goal

Not assessable — no goal was recorded/persisted for this date (same recurring gap as
July 21–23). Separately, Git shows the day was clearly productive: the discovery subsystem
shipped end-to-end with tests and retry hardening, unblocking the crawl-target gap left
after Decision 11 was documented.
