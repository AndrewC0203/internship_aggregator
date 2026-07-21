import type { NormalizedListing, RawJob } from "./types.js";
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

// Per-source fetch + pure normalize (Decision 9). `targets` is the list of
// company slugs / board tokens for that source — its source (config vs DB table)
// is a separate open decision; empty placeholder for now.
const SOURCES: Array<{
  fetch: (target: string) => Promise<RawJob[]>;
  normalize: (raw: RawJob) => NormalizedListing;
  targets: string[];
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
      const raw = await src.fetch(target);
      for (const job of raw) normalized.push(src.normalize(job));
    }
  }

  const deduped = await dedup(normalized);
  const internships = await filterInternships(deduped);
  const enriched = await extract(internships);
  await persist(enriched);
}
