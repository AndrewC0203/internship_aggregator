import type { EnrichedListing } from "../types.js";
import { prisma } from "../../db.js";

// Upsert each listing on the natural key (source, sourceExternalId): firstSeenAt only
// stamps on create (defaults to now() in the schema, so it's omitted here); lastSeenAt
// refreshes on every run so a listing's "still live" signal stays current; isListed is
// forced true on both branches since only listings the crawl actually returned reach
// this stage (dedup/filter suppression already happened upstream).
export async function persist(listings: EnrichedListing[]): Promise<void> {
  for (const listing of listings) {
    await prisma.listing.upsert({
      where: {
        source_sourceExternalId: {
          source: listing.source,
          sourceExternalId: listing.sourceExternalId,
        },
      },
      create: { ...listing, isListed: true },
      update: { ...listing, lastSeenAt: new Date(), isListed: true },
    });
  }
}
