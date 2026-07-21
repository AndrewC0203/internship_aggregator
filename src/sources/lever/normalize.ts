import type { RawJob, NormalizedListing } from "../../pipeline/types.js";

// Pure function: Lever raw payload -> NormalizedListing.
// Keep free of I/O so it's unit-testable against fixture JSON.
// TODO: map fields per finalized_decisions/schema.md + research/ats-field-reference.md.
// Reminder: Lever createdAt is epoch milliseconds; convert to Date.
export function normalizeLever(raw: RawJob): NormalizedListing {
  throw new Error("normalizeLever not implemented");
}
