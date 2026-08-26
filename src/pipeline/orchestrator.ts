import type { Source } from "@prisma/client";
import type {
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
import { dedup } from "./stages/dedup.js";
import { partitionBySeen } from "./stages/partition.js";
import { filterInternships } from "./stages/filter.js";
import { extract } from "./stages/extract.js";
import { persist } from "./stages/persist.js";

const SOURCES: Array<{
  source: Source;
  fetch: (token: string) => Promise<RawJob[]>;
  normalize: (raw: RawJob, ctx: NormalizeContext) => NormalizedListing | null;
}> = [
  { source: "greenhouse", fetch: fetchGreenhouse, normalize: normalizeGreenhouse },
  { source: "lever", fetch: fetchLever, normalize: normalizeLever },
  { source: "ashby", fetch: fetchAshby, normalize: normalizeAshby },
];

// Boards per flush of the shared tail (FEATURES.md P1 "incremental persist for the AI tail",
// unblocked now that dedup v1 / Decision 15 exists — see runPipeline below for why chunking is
// safe against it). Small default: the AI tail is the slow part, so a crash loses at most this
// many boards' worth of unpersisted classify/extract work instead of the whole run.
const BOARD_BATCH_SIZE = Number(process.env.BOARD_BATCH_SIZE ?? 10);

// Pipeline shape (Decision 9 + Decision 12): per-source fetch -> normalize, then shared
// stages dedup -> partition -> filter -> extract -> persist. `limit` caps boards per source
// (for a small first run); omit for a full refresh.
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
export async function runPipeline(opts: { limit?: number } = {}): Promise<void> {
  let batch: NormalizedListing[] = [];
  let boardsSinceFlush = 0;
  let totalKept = 0;
  let totalRejected = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) {
      boardsSinceFlush = 0;
      return;
    }
    const normalized = batch;
    batch = [];
    boardsSinceFlush = 0;

    console.log(`[orchestrator] flushing batch of ${normalized.length} normalized listings...`);

    // Shared tail (Decision 9 + Decision 12): dedup → partition-by-seen → filter (regex
    // accept-router + regex reject-router + AI classify) → extract (AI, keeps only) → persist.
    const deduped = await dedup(normalized);
    const { unseen, seenKeeps, seenRejects } = await partitionBySeen(deduped);
    console.log(
      `Partition: ${unseen.length} new (→ AI), ${seenKeeps.length} seen-keeps, ${seenRejects.length} seen-rejects.`,
    );
    const { keeps, newRejects, titleDropped, yoeDropped } = await filterInternships(unseen);
    // The two drop counts are logged but never persisted: those listings stay "unseen" on
    // purpose, so widening either regex re-evaluates them next run (see reject-router.ts).
    console.log(
      `Filter: ${keeps.length} kept, ${newRejects.length} model-rejected, ` +
        `${titleDropped} title-dropped, ${yoeDropped} experience-dropped.`,
    );
    const enriched = await extract(keeps);
    await persist({ keeps: enriched, newRejects, seenKeeps, seenRejects });
    totalKept += enriched.length;
    totalRejected += newRejects.length;
    console.log(
      `Persisted batch: ${enriched.length} new listings, ${newRejects.length} new rejects, ` +
        `${seenKeeps.length} refreshed, ${seenRejects.length} reject bumps.`,
    );
  }

  for (const src of SOURCES) {
    // crawl_targets (Decision 11) is discovery's output; refresh only reads rows
    // discovery still considers active. isActive=false is soft-deactivation, not deletion.
    const targets = await prisma.crawlTarget.findMany({
      where: { source: src.source, isActive: true },
      take: opts.limit, // undefined = no cap
    });

    for (const target of targets) {
      // One board's fetch/normalize failure shouldn't abort every other board in the
      // run — log and skip it. This is error isolation, not retry: no re-attempt happens.
      try {
        const raw = await src.fetch(target.token);
        for (const job of raw) {
          // normalize() returns null for a job it can't safely map (e.g. missing
          // company_name) — drop just that job, not the whole board.
          const listing = src.normalize(job, {});
          if (listing) batch.push(listing);
        }
        await prisma.crawlTarget.update({
          where: { id: target.id },
          data: { lastCrawledAt: new Date(), lastError: null },
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`Skipping ${src.source} board "${target.token}": ${reason}`);
        await prisma.crawlTarget.update({
          where: { id: target.id },
          data: { lastError: reason },
        });
      }

      // Counts boards processed (attempted), not boards that yielded listings — a run of
      // all-empty/failed boards should still flush on schedule rather than never.
      boardsSinceFlush++;
      if (boardsSinceFlush >= BOARD_BATCH_SIZE) {
        await flush();
      }
    }
  }

  await flush(); // remainder: fewer than BOARD_BATCH_SIZE boards since the last flush

  console.log(`Run complete: ${totalKept} total new listings, ${totalRejected} total new rejects.`);
}
