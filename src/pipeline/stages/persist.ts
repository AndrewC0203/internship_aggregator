import type { EnrichedListing } from "../types.js";

// FREE — safe to implement from the agreed schema.
// TODO: upsert each listing on the natural key (source, sourceExternalId) via
// prisma.listing.upsert — set first_seen_at on create, refresh last_seen_at on both
// create and update, and set is_listed = true. (Dedup suppression happens upstream.)
export async function persist(listings: EnrichedListing[]): Promise<void> {
  throw new Error("persist not implemented");
}
