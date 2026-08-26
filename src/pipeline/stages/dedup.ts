import type { Source, Prisma } from "@prisma/client";
import type { NormalizedListing, ListingKey } from "../types.js";
import { prisma } from "../../db.js";

// Dedup stage (Decision 9 write handling, Decision 15 key + representation).
//
// KEY: (company, title, location) as an exact string match (only `.trim()`'d — no case
// folding, no location normalization). Measured on real data (research/first-clean-run-audit.md):
// this collapses the pure-noise cluster (6 identical Meridial reqs, all "United States of
// America") down to one row, while leaving every geographic variant alone (their location
// strings differ, so their keys differ). A (company, title)-only key would wrongly collapse
// those too. Location normalization ("USA" == "United States of America") is a separate,
// still-open decision (see the audit's Location Data Quality section) — deliberately NOT
// folded in here.
//
// INVARIANT (Decision 9): a listing is only suppressed against a CURRENTLY-ACTIVE canonical.
// The DB lookup below filters to `isListed: true`, so once a canonical goes inactive it simply
// stops showing up as a match — the next listing sharing its key is treated as brand new and
// gets its own row. That's the whole self-healing mechanism; no special-case code for it.
export interface DedupKeyParts {
  company: string;
  title: string;
  location: string | null;
}

export interface ExistingCanonical extends DedupKeyParts {
  source: Source;
  sourceExternalId: string;
  duplicateKeys: ListingKey[];
}

// Split out from dedup() so tests can inject an in-memory fake instead of needing a live
// Postgres — same "no DB/network in unit tests" bar the rest of the pipeline holds (see
// filter.test.ts). The real implementation below is what runPipeline() actually uses.
export interface DedupRepo {
  findActiveByKeys(keys: DedupKeyParts[]): Promise<ExistingCanonical[]>;
  mergeDuplicateKeys(target: ListingKey, keysToAdd: ListingKey[]): Promise<void>;
}

// Exported so the one-time backfill script (src/backfill-dedup.ts) can group already-persisted
// rows with the exact same rule dedup() uses for incoming ones — a fresh refresh only prevents
// NEW duplicates, it never retroactively merges rows that already have their own IDs in
// `listings`, so cleaning up the existing 21% needs this same key function applied once.
export function dedupKey(l: DedupKeyParts): string {
  return `${l.company.trim()}::${l.title.trim()}::${(l.location ?? "").trim()}`;
}

function keyOf(k: ListingKey): string {
  return `${k.source}::${k.sourceExternalId}`;
}

export function unionKeys(...groups: ListingKey[][]): ListingKey[] {
  const byKey = new Map<string, ListingKey>();
  for (const group of groups) {
    for (const k of group) byKey.set(keyOf(k), k);
  }
  return [...byKey.values()];
}

export function parseDuplicateKeys(value: unknown): ListingKey[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is ListingKey =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as ListingKey).source === "string" &&
      typeof (v as ListingKey).sourceExternalId === "string",
  );
}

export const prismaDedupRepo: DedupRepo = {
  async findActiveByKeys(keys) {
    if (keys.length === 0) return [];
    const rows = await prisma.listing.findMany({
      where: {
        isListed: true,
        OR: keys.map((k) => ({ company: k.company, title: k.title, location: k.location })),
      },
      select: {
        source: true,
        sourceExternalId: true,
        company: true,
        title: true,
        location: true,
        duplicateKeys: true,
      },
    });
    return rows.map((r) => ({ ...r, duplicateKeys: parseDuplicateKeys(r.duplicateKeys) }));
  },

  // Read-merge-write, not atomic. Safe under Decision 4 (single local service, refresh runs
  // sequentially) — there is no concurrent dedup() call that could race this. Would need a
  // transaction if the pipeline is ever run concurrently.
  async mergeDuplicateKeys(target, keysToAdd) {
    const row = await prisma.listing.findUniqueOrThrow({
      where: { source_sourceExternalId: target },
      select: { duplicateKeys: true },
    });
    const merged = unionKeys(parseDuplicateKeys(row.duplicateKeys), keysToAdd);
    await prisma.listing.update({
      where: { source_sourceExternalId: target },
      // Prisma's Json input type wants an index signature; ListingKey is a plain, deliberately
      // narrow interface used everywhere else as a typed key, so cast at this one boundary
      // rather than weakening that interface project-wide.
      data: { duplicateKeys: merged as unknown as Prisma.InputJsonValue, lastSeenAt: new Date() },
    });
  },
};

// Runs BEFORE partitionBySeen, on the in-memory normalized batch — so it must handle both
// flavours of duplicate in one pass:
//   (a) within THIS batch (e.g. 6 identical Meridial reqs fetched in the same crawl), and
//   (b) against a canonical that already has its own row in `listings` from a past refresh.
//
// One deterministic survivor per key wins (a) via a stable sort so re-runs on the same input
// pick the same canonical. A single batched lookup against `listings` resolves (b) for every
// group at once. Three outcomes per group:
//   - no active row owns this key yet -> the survivor proceeds as a (possibly brand new)
//     canonical, carrying its in-batch siblings' keys.
//   - the survivor IS the active row that owns this key (a seenKeep) -> merge in-batch
//     siblings into its existing history; persist()'s normal seenKeep update carries the
//     merged array through untouched.
//   - a DIFFERENT active row owns this key -> the survivor and its siblings are fully
//     suppressed (dropped from the returned batch); their keys are folded into that row
//     directly via mergeDuplicateKeys, which also bumps lastSeenAt so freshness reflects that
//     the role is still being posted even though no new row was written for it.
export async function dedup(
  listings: NormalizedListing[],
  repo: DedupRepo = prismaDedupRepo,
): Promise<NormalizedListing[]> {
  if (listings.length === 0) return [];

  const groups = new Map<string, NormalizedListing[]>();
  for (const l of listings) {
    const k = dedupKey(l);
    const arr = groups.get(k) ?? [];
    arr.push(l);
    groups.set(k, arr);
  }

  const survivors = [...groups.entries()].map(([key, group]) => {
    // Stable, deterministic pick — sourceExternalId order, not crawl/array order, so re-runs
    // on the same input converge on the same canonical instead of flapping.
    const [survivor, ...siblings] = [...group].sort((a, b) =>
      a.sourceExternalId.localeCompare(b.sourceExternalId),
    );
    return {
      key,
      listing: survivor,
      siblingKeys: siblings.map(
        (s): ListingKey => ({ source: s.source, sourceExternalId: s.sourceExternalId }),
      ),
    };
  });

  const existing = await repo.findActiveByKeys(
    survivors.map((s) => ({
      company: s.listing.company,
      title: s.listing.title,
      location: s.listing.location,
    })),
  );
  const existingByKey = new Map(existing.map((e) => [dedupKey(e), e]));

  const result: NormalizedListing[] = [];
  for (const { key, listing, siblingKeys } of survivors) {
    const canonical = existingByKey.get(key);

    if (!canonical) {
      result.push({ ...listing, duplicateKeys: unionKeys(listing.duplicateKeys, siblingKeys) });
      continue;
    }

    const isSelf =
      canonical.source === listing.source &&
      canonical.sourceExternalId === listing.sourceExternalId;

    if (isSelf) {
      result.push({
        ...listing,
        duplicateKeys: unionKeys(canonical.duplicateKeys, listing.duplicateKeys, siblingKeys),
      });
      continue;
    }

    await repo.mergeDuplicateKeys(
      { source: canonical.source, sourceExternalId: canonical.sourceExternalId },
      unionKeys(
        [{ source: listing.source, sourceExternalId: listing.sourceExternalId }],
        siblingKeys,
      ),
    );
  }

  return result;
}
