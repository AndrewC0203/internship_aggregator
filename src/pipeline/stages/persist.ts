import type { Source, Prisma } from "@prisma/client";
import type { EnrichedListing, NormalizedListing, ListingKey } from "../types.js";
import { prisma } from "../../db.js";
import { resolveLocation } from "./location.js";

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
//
// Per-write failure isolation (2026-09-17), mirroring filter/extract's per-listing try/catch:
// one row that the DB refuses (bad enum, decimal overflow, transient error) must cost that
// row, not every write after it. A failed row lands in NO table — same "stays unseen" state
// as a titleDropped listing — so the next run re-evaluates it: transient failures self-heal,
// persistent ones re-log every run instead of silently vanishing.
export interface PersistResult {
  keepsWritten: number;
  keepsFailed: number;
}

export async function persist(input: PersistInput): Promise<PersistResult> {
  const now = new Date();
  const logFailure = (what: string, key: ListingKey, err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[persist] ${what} failed for ${key.source}/${key.sourceExternalId}: ${reason}`);
  };

  // Location facets (Decision 19) are computed HERE, at the single choke point every listing
  // write goes through, rather than in a pipeline stage — deliberately. The parser is pure and
  // ~free, and deriving at write time means the seenKeep path below recomputes them too, so a
  // company editing a posting's location can never leave stale facet arrays behind (the exact
  // drift-on-content-edit failure mode the duplicateKeys audit flagged).
  const locFacets = (listing: NormalizedListing) => {
    const loc = resolveLocation(listing.location);
    return { locCountries: loc.countries, locUsStates: loc.usStates };
  };

  // New keeps — full-row upsert (source + AI fields).
  let keepsWritten = 0;
  let keepsFailed = 0;
  for (const listing of input.keeps) {
    try {
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
          ...locFacets(listing),
          isListed: true,
          duplicateKeys: listing.duplicateKeys as unknown as Prisma.InputJsonValue,
        },
        update: {
          ...listing,
          ...locFacets(listing),
          lastSeenAt: now,
          isListed: true,
          duplicateKeys: listing.duplicateKeys as unknown as Prisma.InputJsonValue,
        },
      });
      keepsWritten++;
    } catch (err) {
      keepsFailed++;
      logFailure("keep upsert", listing, err);
    }
  }

  // New rejects — key-only insert. All are partition-confirmed new, so createMany is safe;
  // skipDuplicates guards against a same-run race or a cross-board external-id collision.
  // A failure here loses only skip-memory: the keys stay unseen and re-filter next run.
  if (input.newRejects.length > 0) {
    try {
      await prisma.seenListing.createMany({
        data: input.newRejects.map((k) => ({
          source: k.source,
          sourceExternalId: k.sourceExternalId,
          lastSeenAt: now,
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[persist] reject createMany failed (${input.newRejects.length} keys): ${reason}`);
    }
  }

  // Seen keeps — refresh source-derived fields (spreading a NormalizedListing naturally omits
  // the AI columns, so `update` leaves opportunityType/gradYear*/citizenship untouched). Per-row
  // because each listing's content differs; these are cheap writes with no AI behind them.
  for (const listing of input.seenKeeps) {
    try {
      await prisma.listing.update({
        where: {
          source_sourceExternalId: {
            source: listing.source,
            sourceExternalId: listing.sourceExternalId,
          },
        },
        data: {
          ...listing,
          ...locFacets(listing),
          lastSeenAt: now,
          isListed: true,
          duplicateKeys: listing.duplicateKeys as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      logFailure("seen-keep refresh", listing, err);
    }
  }

  // Already-seen rejects — bump so a future stale-key prune can tell live rejects from dead ones.
  for (const [source, ids] of groupBySource(input.seenRejects)) {
    try {
      await prisma.seenListing.updateMany({
        where: { source, sourceExternalId: { in: ids } },
        data: { lastSeenAt: now },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[persist] reject bump failed (${source}, ${ids.length} keys): ${reason}`);
    }
  }

  return { keepsWritten, keepsFailed };
}
