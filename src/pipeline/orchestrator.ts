import type {
  NormalizedListing,
  NormalizeContext,
  RawJob,
} from "./types.js";
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

// One crawl target: the board token/slug to fetch, plus the company name to stamp on
// its listings (payloads don't reliably carry it). The list of targets — where it comes
// from (config vs DB table) — is a deferred decision; empty placeholders for now.
interface Target {
  token: string;
  company: string;
}

const SOURCES: Array<{
  fetch: (token: string) => Promise<RawJob[]>;
  normalize: (raw: RawJob, ctx: NormalizeContext) => NormalizedListing;
  targets: Target[];
}> = [
  { fetch: fetchGreenhouse, normalize: normalizeGreenhouse, targets: [] },
  { fetch: fetchLever, normalize: normalizeLever, targets: [] },
  { fetch: fetchAshby, normalize: normalizeAshby, targets: [] },
];

// Pipeline shape (Decision 9): per-source fetch -> normalize, then shared stages
// dedup -> filter -> extract -> persist, in order.
export async function runPipeline(): Promise<void> {
  const normalized: NormalizedListing[] = [];
  for (const src of SOURCES) {
    for (const target of src.targets) {
      // One board's fetch/normalize failure shouldn't abort every other board in the
      // run — log and skip it. This is error isolation, not retry: no re-attempt happens.
      try {
        const raw = await src.fetch(target.token);
        for (const job of raw) {
          normalized.push(src.normalize(job, { company: target.company }));
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`Skipping ${target.company} (${target.token}): ${reason}`);
      }
    }
  }

  const deduped = await dedup(normalized);
  const internships = await filterInternships(deduped);
  const enriched = await extract(internships);
  await persist(enriched);
}
