import type { RawJob, NormalizedListing } from "../../pipeline/types.js";

// Pure function: Greenhouse raw payload -> NormalizedListing.
// Keep free of I/O so it's unit-testable against fixture JSON.
// TODO: map fields per finalized_decisions/schema.md + research/ats-field-reference.md.
export function normalizeGreenhouse(raw: RawJob): NormalizedListing {
  throw new Error("normalizeGreenhouse not implemented");
}
