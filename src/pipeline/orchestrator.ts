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

// Pipeline shape (Decision 9): per-source fetch -> normalize, then shared stages
// dedup -> filter -> extract -> persist, in order.
export async function runPipeline(): Promise<void> {
  const normalized: NormalizedListing[] = [];

  for (const src of SOURCES) {
    // crawl_targets (Decision 11) is discovery's output; refresh only reads rows
    // discovery still considers active. isActive=false is soft-deactivation, not deletion.
    const targets = await prisma.crawlTarget.findMany({
      where: { source: src.source, isActive: true },
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

  const deduped = await dedup(normalized);
  const internships = await filterInternships(deduped);
  const enriched = await extract(internships);
  await persist(enriched);
}
