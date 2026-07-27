import type { Source } from "@prisma/client";
import type { EnrichedListing, ListingKey } from "../types.js";
import { prisma } from "../../db.js";

export interface PersistInput {
  keeps: EnrichedListing[]; // new keeps → upsert the full classified+extracted row into listings
  newRejects: ListingKey[]; // new rejects → record just the key in seen_listings
  seenKeeps: ListingKey[]; // already in listings → bump lastSeenAt/isListed (no AI ran)
  seenRejects: ListingKey[]; // already in seen_listings → bump lastSeenAt (no AI ran)
}

// Group keys by source for the bulk updateMany bumps (composite IN isn't ergonomic in Prisma).
function groupBySource(keys: ListingKey[]): Map<Source, string[]> {
  const m = new Map<Source, string[]>();
  for (const k of keys) {
    const ids = m.get(k.source) ?? [];
    ids.push(k.sourceExternalId);
    m.set(k.source, ids);
  }
  return m;
}

// Persist stage (Decision 12). Four idempotent writes:
//   - new keeps    : upsert the full classified+extracted row into `listings`
//   - new rejects  : record just the key in `seen_listings` (skip-memory; never re-classified)
//   - seen keeps   : bump lastSeenAt/isListed on the existing `listings` row (no AI ran)
//   - seen rejects : bump lastSeenAt on the existing `seen_listings` row
//
// firstSeenAt only stamps on create (schema default, so omitted). lastSeenAt refreshes on
// every sighting so the "still live" signal stays current; isListed is forced true because
// anything reaching persist was actually returned by the crawl this run.
export async function persist(input: PersistInput): Promise<void> {
  const now = new Date();

  // New keeps — full-row upsert.
  for (const listing of input.keeps) {
    await prisma.listing.upsert({
      where: {
        source_sourceExternalId: {
          source: listing.source,
          sourceExternalId: listing.sourceExternalId,
        },
      },
      create: { ...listing, isListed: true },
      update: { ...listing, lastSeenAt: now, isListed: true },
    });
  }

  // New rejects — key-only insert. All are partition-confirmed new, so createMany is safe;
  // skipDuplicates guards against a same-run race or a cross-board external-id collision.
  if (input.newRejects.length > 0) {
    await prisma.seenListing.createMany({
      data: input.newRejects.map((k) => ({
        source: k.source,
        sourceExternalId: k.sourceExternalId,
        lastSeenAt: now,
      })),
      skipDuplicates: true,
    });
  }

  // Already-seen keeps — bump the freshness signal without touching classified fields.
  for (const [source, ids] of groupBySource(input.seenKeeps)) {
    await prisma.listing.updateMany({
      where: { source, sourceExternalId: { in: ids } },
      data: { lastSeenAt: now, isListed: true },
    });
  }

  // Already-seen rejects — bump so a future stale-key prune can tell live rejects from dead ones.
  for (const [source, ids] of groupBySource(input.seenRejects)) {
    await prisma.seenListing.updateMany({
      where: { source, sourceExternalId: { in: ids } },
      data: { lastSeenAt: now },
    });
  }
}
