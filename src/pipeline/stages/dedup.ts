import type { NormalizedListing } from "../types.js";

// ─── FIRST-DRAFT-MINE (deferred) ── TEMPORARY single-source pass-through ──
//
// This is NOT the real dedup algorithm — it just returns the batch unchanged. With only
// Greenhouse wired there are no cross-source duplicates to find, so there is genuinely
// nothing to check yet; this exists only to unblock end-to-end runs.
//
// The real algorithm (Decision 9) is still yours to write when a second source is wired:
// link cross-source duplicates via an array column on the canonical row, suppress a
// duplicate from writing only while its canonical is ACTIVE, and resurrect it on the next
// cycle once the canonical goes inactive. KEY INVARIANT: only suppress against a
// *currently-active* canonical.
export async function dedup(
  listings: NormalizedListing[],
): Promise<NormalizedListing[]> {
  return listings;
}
