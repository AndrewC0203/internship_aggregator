import type { NormalizedListing, EnrichedListing } from "../types.js";

// ─── GATED (classification/extraction) ─── local AI model; approach not yet decided.
//
// Intended (Decision 9): pull gradYearMin/Max and citizenshipStatus out of each
// listing's description_plain (the BODY — these fields aren't in the title).
export async function extract(
  listings: NormalizedListing[],
): Promise<EnrichedListing[]> {
  throw new Error("extract not implemented (GATED — decide extraction approach)");
}
