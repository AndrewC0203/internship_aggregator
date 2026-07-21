import type { NormalizedListing } from "../types.js";

// ─── FIRST-DRAFT-MINE ─── you write the first version of this; left as a stub.
//
// Contract (Decision 9): identify cross-source duplicates among this run's listings
// and LINK them (record the relationship) rather than delete. A duplicate is suppressed
// from writing only while its canonical is active.
//
// KEY INVARIANT: only suppress a duplicate against a *currently-active* canonical.
// If the canonical is inactive, the duplicate MUST pass through so a live role resurfaces.
export async function dedup(
  listings: NormalizedListing[],
): Promise<NormalizedListing[]> {
  throw new Error("dedup not implemented (FIRST-DRAFT-MINE — write your v1)");
}
