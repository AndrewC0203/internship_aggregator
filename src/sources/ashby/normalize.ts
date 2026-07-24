import type {
  RawJob,
  NormalizedListing,
  NormalizeContext,
} from "../../pipeline/types.js";

// Pure function: Ashby raw payload -> NormalizedListing.
// Keep free of I/O so it's unit-testable against fixture JSON.
// TODO: map fields per finalized_decisions/schema.md + research/ats-field-reference.md.
export function normalizeAshby(
  raw: RawJob,
  ctx: NormalizeContext,
): NormalizedListing {
  throw new Error("normalizeAshby not implemented");
}
