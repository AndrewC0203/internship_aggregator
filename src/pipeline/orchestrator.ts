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

// Pipeline shape (Decision 9 + Decision 12): per-source fetch -> normalize, then shared
// stages dedup -> partition -> filter -> extract -> persist. `limit` caps boards per source
// (for a small first run); omit for a full refresh.
export async function runPipeline(opts: { limit?: number } = {}): Promise<void> {
  const normalized: NormalizedListing[] = [];

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
          if (listing) normalized.push(listing);
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
    }
  }

  console.log(`Fetched + normalized ${normalized.length} raw listings.`);

  // Shared tail (Decision 9 + Decision 12): dedup (your first-draft) → partition-by-seen →
  // filter (regex accept-router + regex reject-router + AI classify) → extract (AI, keeps
  // only) → persist.
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
  console.log(
    `Persisted: ${enriched.length} new listings, ${newRejects.length} new rejects, ` +
      `${seenKeeps.length} refreshed, ${seenRejects.length} reject bumps.`,
  );
}
