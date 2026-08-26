import type { Source, Prisma } from "@prisma/client";
import type { EnrichedListing, NormalizedListing, ListingKey } from "../types.js";
import { prisma } from "../../db.js";

export interface PersistInput {
  keeps: EnrichedListing[]; // new keeps → upsert the full classified+extracted row into listings
  newRejects: ListingKey[]; // new rejects → record just the key in seen_listings
  seenKeeps: NormalizedListing[]; // already in listings → refresh SOURCE fields (no AI ran)
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
//   - seen keeps   : refresh SOURCE fields + lastSeenAt on the existing `listings` row, WITHOUT
//                    touching the AI columns (opportunityType / gradYear* / citizenship). The
//                    reject-memory optimization skips AI *inference*, not content sync — a
//                    company that edits a deadline/title/location must still propagate.
//   - seen rejects : bump lastSeenAt on the existing `seen_listings` row
//
// firstSeenAt only stamps on create (schema default, so omitted). lastSeenAt refreshes on
// every sighting so the "still live" signal stays current; isListed is forced true because
// anything reaching persist was actually returned by the crawl this run.
export async function persist(input: PersistInput): Promise<void> {
  const now = new Date();

  // New keeps — full-row upsert (source + AI fields).
  for (const listing of input.keeps) {
    await prisma.listing.upsert({
      where: {
        source_sourceExternalId: {
          source: listing.source,
          sourceExternalId: listing.sourceExternalId,
        },
      },
      // duplicateKeys cast: see the same note in dedup.ts — Prisma's Json input type wants an
      // index signature that ListingKey[] deliberately doesn't have.
      create: {
        ...listing,
        isListed: true,
        duplicateKeys: listing.duplicateKeys as unknown as Prisma.InputJsonValue,
      },
      update: {
        ...listing,
        lastSeenAt: now,
        isListed: true,
        duplicateKeys: listing.duplicateKeys as unknown as Prisma.InputJsonValue,
      },
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

  // Seen keeps — refresh source-derived fields (spreading a NormalizedListing naturally omits
  // the AI columns, so `update` leaves opportunityType/gradYear*/citizenship untouched). Per-row
  // because each listing's content differs; these are cheap writes with no AI behind them.
  for (const listing of input.seenKeeps) {
    await prisma.listing.update({
      where: {
        source_sourceExternalId: {
          source: listing.source,
          sourceExternalId: listing.sourceExternalId,
        },
      },
      data: {
        ...listing,
        lastSeenAt: now,
        isListed: true,
        duplicateKeys: listing.duplicateKeys as unknown as Prisma.InputJsonValue,
      },
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
