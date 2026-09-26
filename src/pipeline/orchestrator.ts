import type { Source } from "@prisma/client";
import type {
  FetchResult,
  NormalizedListing,
  NormalizeContext,
  RawJob,
} from "./types.js";
import { prisma } from "../db.js";
import { fetchGreenhouse } from "../sources/greenhouse/fetch.js";
import { normalizeGreenhouse } from "../sources/greenhouse/normalize.js";
import { fetchLever } from "../sources/lever/fetch.js";
import { normalizeLever } from "../sources/lever/normalize.js";
import { fetchAshby } from "../sources/ashby/fetch.js";
import { normalizeAshby } from "../sources/ashby/normalize.js";
import { fetchSimplify } from "../sources/simplify/fetch.js";
import { normalizeSimplify } from "../sources/simplify/normalize.js";
import { dedup } from "./stages/dedup.js";
import { partitionBySeen } from "./stages/partition.js";
import { splitPreclassified } from "./stages/preclassified.js";
import { filterInternships } from "./stages/filter.js";
import { extract } from "./stages/extract.js";
import { persist } from "./stages/persist.js";
import { delistStaleForBoard, delistStaleForSource } from "./stages/delist.js";
import { ATS_MIN_INTERVAL_MS, createRateGate, pauseAfter429 } from "./rate-limit.js";

const SOURCES: Array<{
  source: Source;
  fetch: (token: string, priorEtag?: string | null) => Promise<FetchResult>;
  normalize: (raw: RawJob, ctx: NormalizeContext) => NormalizedListing | null;
  // Delisting (Decision 22) trusts a successful fetch to mean "the WHOLE board," not a page of
  // it — true for Greenhouse AND Ashby (both single-response, no pagination; Ashby verified
  // live 2026-09-08, see src/sources/ashby/fetch.ts). Lever stays false: its fetch paginates,
  // and its per-page ETag can't represent the whole board (see src/sources/lever/fetch.ts).
  supportsFreshness: boolean;
  // How a successful crawl's absence-delist is scoped (Decision 38). Default "company": one
  // board = one company, the Decision 22 anchor. "source": one crawl IS the source's whole
  // universe (the simplify file spans hundreds of companies, so only the source can scope
  // it) — sound only while the source has exactly ONE active target; delistStaleForSource
  // enforces that.
  delistScope?: "company" | "source";
}> = [
  // simplify first: one cheap fetch with thousands of pre-classified listings and no AI
  // tail — it persists in minutes, before the hours-long ATS walk. Arrival order vs. the
  // ATSs doesn't affect correctness either way: dedup's alias pass catches simplify copies
  // of existing ATS rows, and persist's retire pass catches ATS copies of existing simplify
  // rows (Decision 39).
  { source: "simplify", fetch: fetchSimplify, normalize: normalizeSimplify, supportsFreshness: true, delistScope: "source" },
  { source: "greenhouse", fetch: fetchGreenhouse, normalize: normalizeGreenhouse, supportsFreshness: true },
  { source: "lever", fetch: fetchLever, normalize: normalizeLever, supportsFreshness: false },
  { source: "ashby", fetch: fetchAshby, normalize: normalizeAshby, supportsFreshness: true },
];

// Boards per flush of the shared tail (FEATURES.md P1 "incremental persist for the AI tail",
// unblocked now that dedup v1 / Decision 15 exists — see runPipeline below for why chunking is
// safe against it). Small default: the AI tail is the slow part, so a crash loses at most this
// many boards' worth of unpersisted classify/extract work instead of the whole run.
const BOARD_BATCH_SIZE = Number(process.env.BOARD_BATCH_SIZE ?? 10);

// Pipeline shape (Decision 9 + Decision 12): per-source fetch -> normalize, then shared
// stages dedup -> partition -> filter -> extract -> persist. `limit` caps boards per source
// (for a small first run); omit for a full refresh. `full` disables conditional fetches
// (Decision 23) so every board re-downloads even if its etag says unchanged.
//
// Runs the shared tail in BOARD_BATCH_SIZE-board chunks rather than once over the whole crawl
// (FEATURES.md P1, deferred until dedup v1 existed — Decision 15, 2026-08-25). A crash mid-run
// (OOM, kill, Ctrl-C, or a classify call that exhausts its retries — see model/ollama.ts) now
// only loses the CURRENT chunk; every prior chunk is already in the DB. This is safe against
// dedup: a duplicate that lands in a LATER chunk than its sibling no longer gets caught by
// dedup()'s in-batch grouping (the siblings are in different batches now), but it's still caught
// by dedup()'s OTHER path — the DB lookup against already-ACTIVE `listings` rows — because the
// earlier chunk already persisted its canonical before this chunk's dedup() call runs. Same
// outcome, different one of dedup's two existing branches. The alternative (accumulate
// everything, flush once) was the status quo; rejected because it makes a large crawl entirely
// non-durable — hours of classify calls lost to one late failure.
export async function runPipeline(
  opts: { limit?: number; full?: boolean; source?: string } = {},
): Promise<void> {
  let batch: NormalizedListing[] = [];
  // ETags whose listings ride in `batch`, held back until that batch is durably persisted.
  // INVARIANT (crash-window fix, 2026-09-09): an etag may only be persisted AFTER every
  // listing from the response it validates is in the DB. Written eagerly (the old way), a
  // crash between a board's fetch and its flush left the etag stored with its listings
  // lost — and the next run's 304 would skip right past them until the board's content
  // happened to change. Failure directions are asymmetric: losing an etag costs one
  // re-download; storing one early can silently lose listings. `lastCrawledAt`/`lastError`
  // still write eagerly — crawl health doesn't gate future ingestion, so it has no window.
  let pendingEtags: Array<{ targetId: number; etag: string | null }> = [];
  let boardsSinceFlush = 0;
  let totalKept = 0;
  let totalRejected = 0;

  async function flush(): Promise<void> {
    // Etags pending with an EMPTY batch are safe to store now: their boards contributed
    // zero normalized listings, so there's nothing unpersisted for a 304 to skip past.
    async function persistPendingEtags(): Promise<void> {
      const toWrite = pendingEtags;
      pendingEtags = [];
      for (const { targetId, etag } of toWrite) {
        await prisma.crawlTarget.update({ where: { id: targetId }, data: { etag } });
      }
    }

    // The whole flush body is contained (2026-09-17): flush() runs OUTSIDE the per-board
    // try/catch below, so before this guard existed, one throw anywhere in the shared tail
    // propagated out of runPipeline() — discarding the batch's already-computed AI work AND
    // aborting every board not yet crawled this run, while the batch's boards kept their
    // eagerly-written clean crawl health (lastCrawledAt set, lastError null). That silent
    // "crawled fine, zero rows" signature is exactly what the first-clean-run audit observed
    // on the AIFT board. One batch's tail failure now costs that batch only.
    if (batch.length === 0) {
      boardsSinceFlush = 0;
      try {
        await persistPendingEtags();
      } catch (err) {
        // A lost etag costs one re-download next run (the safe direction) — never the run.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[orchestrator] etag write failed (etags dropped, boards re-fetch): ${reason}`);
      }
      return;
    }
    try {
      const normalized = batch;
      batch = [];
      boardsSinceFlush = 0;

      console.log(`[orchestrator] flushing batch of ${normalized.length} normalized listings...`);

      // Shared tail (Decision 9 + Decision 12): dedup → partition-by-seen → filter (regex
      // accept-router + regex reject-router + AI classify) → extract (AI, keeps only) → persist.
      const deduped = await dedup(normalized);
      const { unseen, seenKeeps, seenRejects } = await partitionBySeen(deduped);
      // Pre-classified bypass (Decision 38): a curated feed's unseen listings skip both AI
      // stages — the source's verdict is already the enriched row. Split BEFORE filter so
      // the AI tail's cost and logs only cover listings that actually need a model.
      const { pre, rest } = splitPreclassified(unseen);
      console.log(
        `Partition: ${unseen.length} new (${pre.length} pre-classified, ${rest.length} → AI), ` +
          `${seenKeeps.length} seen-keeps, ${seenRejects.length} seen-rejects.`,
      );
      const { keeps, newRejects, titleDropped, yoeDropped } = await filterInternships(rest);
      // The two drop counts are logged but never persisted: those listings stay "unseen" on
      // purpose, so widening either regex re-evaluates them next run (see reject-router.ts).
      console.log(
        `Filter: ${keeps.length} kept, ${newRejects.length} model-rejected, ` +
          `${titleDropped} title-dropped, ${yoeDropped} experience-dropped.`,
      );
      const enriched = await extract(keeps);
      const { keepsWritten, keepsFailed } = await persist({
        keeps: [...enriched, ...pre],
        newRejects,
        seenKeeps,
        seenRejects,
      });
      // Only now — with this batch's listings durable — do the batch's etags get stored.
      // If persist() had thrown, the etags stay unwritten and the next run re-downloads:
      // the safe direction.
      await persistPendingEtags();
      totalKept += keepsWritten;
      totalRejected += newRejects.length;
      console.log(
        `Persisted batch: ${keepsWritten} new listings` +
          (keepsFailed > 0 ? ` (${keepsFailed} FAILED writes)` : "") +
          `, ${newRejects.length} new rejects, ` +
          `${seenKeeps.length} refreshed, ${seenRejects.length} reject bumps.`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[orchestrator] BATCH LOST — shared tail failed, this batch's boards persist nothing ` +
          `this run: ${reason}`,
      );
      // Drop the failed batch's queued etags WITHOUT writing them — the invariant above:
      // these boards' listings never reached the DB, so storing their etags would make the
      // next run 304 straight past the lost listings. Dropped, the next run re-downloads
      // and re-evaluates the same boards: the self-healing direction.
      pendingEtags = [];
    }
  }

  // --source filters to one ATS (same untyped-string + SOURCES.filter pattern as
  // src/discovery/orchestrator.ts) — lets a stalled/slow source (e.g. ashby) be targeted
  // without re-walking sources ahead of it that etag/304 revalidation already makes cheap.
  const sources = opts.source ? SOURCES.filter((s) => s.source === opts.source) : SOURCES;

  for (const src of sources) {
    // crawl_targets (Decision 11) is discovery's output; refresh only reads rows
    // discovery still considers active. isActive=false is soft-deactivation, not deletion.
    const targets = await prisma.crawlTarget.findMany({
      where: { source: src.source, isActive: true },
      take: opts.limit, // undefined = no cap
    });

    // Request pacing (Decision 27): one gate per source = one per API host. Paces board
    // fetches only — a 304 revalidation is still a request to the host, so it's paced too.
    const gate = createRateGate(ATS_MIN_INTERVAL_MS);

    for (const target of targets) {
      // One board's fetch/normalize failure shouldn't abort every other board in the
      // run — log and skip it. This is error isolation, not retry: no re-attempt happens.
      try {
        await gate.wait();
        // Conditional fetch (Decision 23): hand back the stored validator; `--full` forces a
        // re-download by withholding it (e.g. after a normalize bug fix, when the stored rows
        // need rebuilding from bodies the etag would otherwise skip).
        const result = await src.fetch(target.token, opts.full ? null : target.etag);

        if (result.kind === "not_modified") {
          // A 304 is a SUCCESSFUL crawl of an UNCHANGED board: same listing set as last time,
          // by server assertion. So — crawl health updates, the board's active listings get
          // their lastSeenAt sighting bump (scoped by the Decision 22 company cache; the same
          // update persist() would have produced for each seenKeep, minus the content sync,
          // which is exactly what "unchanged" makes unnecessary)... and NO delist call, not
          // because delisting would be wrong but because nothing can be absent from an
          // unchanged set. The board's seen_listings reject keys do NOT get bumped (that
          // table has no company column to scope by) — the future reject-pruning logic must
          // treat seen_listings.lastSeenAt as a lower bound, not an exact last sighting.
          await prisma.crawlTarget.update({
            where: { id: target.id },
            data: { lastCrawledAt: new Date(), lastError: null },
          });
          if (src.delistScope === "source") {
            // Source-scoped boards never resolve a company (many companies per crawl), so
            // their 304 sighting bump is scoped the same way their delist is: by source.
            await prisma.listing.updateMany({
              where: { source: src.source, isListed: true },
              data: { lastSeenAt: new Date() },
            });
          } else if (target.company) {
            await prisma.listing.updateMany({
              where: { source: src.source, company: target.company, isListed: true },
              data: { lastSeenAt: new Date() },
            });
          }
        } else {
          const boardListings: NormalizedListing[] = [];
          // company: target.company ?? target.token — Greenhouse's normalize ignores this
          // (its payload carries company_name directly); Lever/Ashby's payloads never state a
          // company at all (one board = one company), so they read it from here: the learned
          // name from a prior crawl if resolved (Decision 22's cache), else the raw slug on a
          // board's first-ever crawl.
          for (const job of result.jobs) {
            // normalize() returns null for a job it can't safely map (e.g. missing
            // company_name) — drop just that job, not the whole board.
            const listing = src.normalize(job, { company: target.company ?? target.token });
            if (listing) {
              batch.push(listing);
              boardListings.push(listing);
            }
          }
          // Crawl health writes eagerly; the etag is QUEUED and only persisted after the
          // flush that contains this board's listings (see pendingEtags above). Queued even
          // when null so a source that stops sending validators has its stale one cleared.
          await prisma.crawlTarget.update({
            where: { id: target.id },
            data: { lastCrawledAt: new Date(), lastError: null },
          });
          pendingEtags.push({ targetId: target.id, etag: result.etag });

          // Staleness/delisting (Decision 22): runs HERE, right after a confirmed-successful
          // fetch, independent of the batch/flush cycle below — it only needs this board's raw
          // sourceExternalIds, not the dedup/filter/classify/extract verdict on them, so there's
          // no reason to wait for a flush (or for the AI tail to even succeed) before acting on it.
          // Gated on supportsFreshness so a source whose fetch might only be a partial page (not
          // yet true for any wired source) can't have a real listing wrongly read as "absent."
          if (src.supportsFreshness) {
            if (src.delistScope === "source") {
              // Source-scoped absence delist (Decision 38). The count is queried fresh, NOT
              // taken from this run's (possibly --limit-capped) target list — the guard
              // must see every active target the source has, or a capped run could delist
              // rows a second uncrawled target still vouches for.
              const activeTargetCount = await prisma.crawlTarget.count({
                where: { source: src.source, isActive: true },
              });
              const { delistedCount } = await delistStaleForSource(
                src.source,
                boardListings,
                activeTargetCount,
              );
              if (delistedCount > 0) {
                console.log(
                  `[delist] ${src.source}/${target.token}: ${delistedCount} listing(s) delisted ` +
                    `(absent from a successful crawl)`,
                );
              }
            } else {
              const { delistedCount, resolvedCompany } = await delistStaleForBoard(
                src.source,
                boardListings,
                target.company,
              );
              if (delistedCount > 0) {
                console.log(
                  `[delist] ${src.source}/${target.token}: ${delistedCount} listing(s) delisted ` +
                    `(absent from a successful crawl)`,
                );
              }
              // Only a FRESH resolution (derived from this run's own response) overwrites the
              // cache — a fallback to the old cached value on an empty-response run isn't new
              // information about this board, so it isn't worth a write.
              if (resolvedCompany && resolvedCompany !== target.company) {
                await prisma.crawlTarget.update({
                  where: { id: target.id },
                  data: { company: resolvedCompany },
                });
              }
            }
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`Skipping ${src.source} board "${target.token}": ${reason}`);
        await prisma.crawlTarget.update({
          where: { id: target.id },
          data: { lastError: reason },
        });
        // 429 = the host pushed back: skip this board like any other error, but also pause
        // the whole source's loop before continuing (Decision 27) — yield, don't power
        // through. Duck-typed status, same as validate.ts.
        if ((err as { status?: number })?.status === 429) {
          await pauseAfter429(src.source);
        }
      }

      // Counts boards processed (attempted), not boards that yielded listings — a run of
      // all-empty/failed boards should still flush on schedule rather than never.
      boardsSinceFlush++;
      if (boardsSinceFlush >= BOARD_BATCH_SIZE) {
        await flush();
      }
    }

    // Flush at every source boundary, not just every N boards. Matters most for simplify
    // (one board, thousands of listings, no AI tail): without this its batch would wait in
    // the chunk for up to 9 ATS boards' worth of slow classify/extract work — and one of
    // THOSE boards' tail failure would throw away simplify's already-free listings too.
    await flush();
  }

  await flush(); // remainder: fewer than BOARD_BATCH_SIZE boards since the last flush

  console.log(`Run complete: ${totalKept} total new listings, ${totalRejected} total new rejects.`);
}
