import type { Source } from "@prisma/client";
import type { NormalizedListing, ListingKey } from "../types.js";
import { prisma } from "../../db.js";

export interface PartitionResult {
  unseen: NormalizedListing[]; // never classified before → full AI pipeline
  seenKeeps: ListingKey[]; // already in `listings` → just bump lastSeenAt (no AI)
  seenRejects: ListingKey[]; // already in `seen_listings` → just bump lastSeenAt (no AI)
}

const keyOf = (k: { source: Source; sourceExternalId: string }) =>
  `${k.source}::${k.sourceExternalId}`;

// Partition-by-seen (Decision 12): split this run's listings into ones we've never classified
// (→ AI) vs. ones already recorded as a keep (in `listings`) or a reject (in `seen_listings`).
// Already-seen listings skip the AI entirely — they only need their lastSeenAt bumped so the
// freshness signal stays current. This is what makes the refresh cheap after the initial run:
// after the first sweep, almost everything falls into seenKeeps/seenRejects.
export async function partitionBySeen(
  listings: NormalizedListing[],
): Promise<PartitionResult> {
  // Composite (source, id) IN isn't ergonomic in Prisma, so query one source at a time with
  // an id list and build membership sets.
  const idsBySource = new Map<Source, string[]>();
  for (const l of listings) {
    const ids = idsBySource.get(l.source) ?? [];
    ids.push(l.sourceExternalId);
    idsBySource.set(l.source, ids);
  }

  const seenKeepSet = new Set<string>();
  const seenRejectSet = new Set<string>();

  for (const [source, ids] of idsBySource) {
    const [keeps, rejects] = await Promise.all([
      prisma.listing.findMany({
        where: { source, sourceExternalId: { in: ids } },
        select: { source: true, sourceExternalId: true },
      }),
      prisma.seenListing.findMany({
        where: { source, sourceExternalId: { in: ids } },
        select: { source: true, sourceExternalId: true },
      }),
    ]);
    for (const k of keeps) seenKeepSet.add(keyOf(k));
    for (const r of rejects) seenRejectSet.add(keyOf(r));
  }

  const unseen: NormalizedListing[] = [];
  const seenKeeps: ListingKey[] = [];
  const seenRejects: ListingKey[] = [];

  for (const l of listings) {
    const k = keyOf(l);
    const key: ListingKey = { source: l.source, sourceExternalId: l.sourceExternalId };
    if (seenKeepSet.has(k)) seenKeeps.push(key);
    else if (seenRejectSet.has(k)) seenRejects.push(key);
    else unseen.push(l);
  }

  return { unseen, seenKeeps, seenRejects };
}
