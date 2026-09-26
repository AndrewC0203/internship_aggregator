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

// Sources whose normalize() seeds duplicateKeys with ALIASES — cross-source identity
// assertions parsed from the listing's own URL (Decision 39). Only these sources get the
// alias forward pass, and only their rows are candidates for retire-at-persist. Append here
// when another curated feed lands; everything else in this file stays source-agnostic.
const ALIAS_SOURCES: Source[] = ["simplify"];
const ALIAS_SOURCE_SET = new Set<Source>(ALIAS_SOURCES);

// A feed listing's aliases: the cross-source entries in its duplicateKeys. Same-source
// entries are string-key suppressed siblings, never aliases.
function aliasesOf(l: { source: Source; duplicateKeys: ListingKey[] }): ListingKey[] {
  return l.duplicateKeys.filter((k) => k.source !== l.source);
}

// Split out from dedup() so tests can inject an in-memory fake instead of needing a live
// Postgres — same "no DB/network in unit tests" bar the rest of the pipeline holds (see
// filter.test.ts). The real implementation below is what runPipeline() actually uses.
export interface DedupRepo {
  findActiveByKeys(keys: DedupKeyParts[]): Promise<ExistingCanonical[]>;
  mergeDuplicateKeys(target: ListingKey, keysToAdd: ListingKey[]): Promise<void>;
  // Decision 39 additions. findActiveByNaturalKeys: which of these (source, externalId)
  // pairs are currently-ACTIVE rows (the alias pass's target lookup). findActiveCarriersOf:
  // active ALIAS_SOURCES rows whose duplicateKeys contain one of these keys (the retire
  // pass's reverse lookup). retireCarrier: delist the carrier and fold its keys into the
  // canonical that superseded it.
  findActiveByNaturalKeys(keys: ListingKey[]): Promise<ListingKey[]>;
  findActiveCarriersOf(
    keys: ListingKey[],
  ): Promise<Array<{ source: Source; sourceExternalId: string; duplicateKeys: ListingKey[] }>>;
  retireCarrier(
    carrier: ListingKey,
    canonical: ListingKey,
    keysToFold: ListingKey[],
  ): Promise<void>;
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

  // Chunked because the simplify board arrives as ONE batch (~870 alias-bearing listings at
  // time of writing) and a single OR of that many pairs makes Postgres planning miserable.
  // Each pair hits the (source, source_external_id) unique index.
  async findActiveByNaturalKeys(keys) {
    const out: ListingKey[] = [];
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const rows = await prisma.listing.findMany({
        where: {
          isListed: true,
          OR: chunk.map((k) => ({ source: k.source, sourceExternalId: k.sourceExternalId })),
        },
        select: { source: true, sourceExternalId: true },
      });
      out.push(...rows);
    }
    return out;
  },

  // Fetches ALL active alias-source rows with a non-empty duplicateKeys and matches in
  // memory: Prisma can't express "jsonb array contains one of N keys", and the candidate set
  // is small and skinny (~4.6k simplify rows × 3 columns, measured). Revisit with a GIN
  // index + raw containment SQL if alias sources ever grow past tens of thousands of rows.
  async findActiveCarriersOf(keys) {
    if (keys.length === 0) return [];
    const rows = await prisma.listing.findMany({
      where: {
        isListed: true,
        source: { in: ALIAS_SOURCES },
        NOT: { duplicateKeys: { equals: [] } },
      },
      select: { source: true, sourceExternalId: true, duplicateKeys: true },
    });
    const wanted = new Set(keys.map(keyOf));
    return rows
      .map((r) => ({ ...r, duplicateKeys: parseDuplicateKeys(r.duplicateKeys) }))
      .filter((r) => r.duplicateKeys.some((k) => wanted.has(keyOf(k))));
  },

  // Fold BEFORE delist: a crash between the two leaves both rows active and linked, and the
  // next run's retire pass simply fires again (the carrier still aliases a persisted row).
  // Delist-first would instead briefly lose the duplicate link — the harder residue to spot.
  // Non-transactional for the same Decision 4 single-instance reason as mergeDuplicateKeys.
  async retireCarrier(carrier, canonical, keysToFold) {
    await this.mergeDuplicateKeys(canonical, keysToFold);
    await prisma.listing.update({
      where: { source_sourceExternalId: carrier },
      data: { isListed: false },
    });
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

  return aliasPass(result, repo);
}

// Alias forward pass (Decision 39), running AFTER the string-key pass on its survivors. A
// feed listing carrying an alias — the natural key of the same posting on its home ATS,
// parsed from its URL by normalize() — is a provable cross-source duplicate whenever that
// key's row is present. Two places the target can be:
//   (a) in THIS batch (mixed flush): fold the feed copy into the in-memory ATS listing —
//       persist's normal write carries the merged keys, no DB call needed;
//   (b) already ACTIVE in `listings`: fold via mergeDuplicateKeys, same as a string-key
//       suppression.
// Either way the feed copy is dropped from the returned batch. Running pre-partition is
// load-bearing: a feed copy whose ATS row is active must be suppressed EVERY run, or
// partitionBySeen would route it as a seenKeep and persist() would resurrect its retired row
// (isListed forced true) right next to the ATS canonical.
//
// The reverse arrival order — feed copy persisted first, ATS copy crawled later — is NOT
// handled here. dedup runs before filter, and delisting the feed row for an ATS copy the
// classifier might still reject would lose the posting outright. That direction lives in
// retireAliasCarriers below, called from persist() once the ATS copy has actually landed.
async function aliasPass(
  batch: NormalizedListing[],
  repo: DedupRepo,
): Promise<NormalizedListing[]> {
  const feed = batch.filter((l) => ALIAS_SOURCE_SET.has(l.source) && aliasesOf(l).length > 0);
  if (feed.length === 0) return batch;

  const naturalKeyOf = (l: NormalizedListing): ListingKey => ({
    source: l.source,
    sourceExternalId: l.sourceExternalId,
  });
  const byNaturalKey = new Map(batch.map((l) => [keyOf(naturalKeyOf(l)), l]));
  const suppressed = new Set<string>();

  // (a) in-batch targets first — cheaper, and it keeps the DB lookup below smaller.
  const needDbCheck: NormalizedListing[] = [];
  for (const copy of feed) {
    const target = aliasesOf(copy)
      .map((a) => byNaturalKey.get(keyOf(a)))
      .find((t) => t !== undefined && t !== copy);
    if (!target) {
      needDbCheck.push(copy);
      continue;
    }
    const copyKey = naturalKeyOf(copy);
    target.duplicateKeys = unionKeys(
      target.duplicateKeys,
      [copyKey],
      // The copy's other keys ride along — minus the target's own key (the alias itself).
      copy.duplicateKeys.filter((k) => keyOf(k) !== keyOf(naturalKeyOf(target))),
    );
    suppressed.add(keyOf(copyKey));
  }

  // (b) already-active targets, one batched lookup for all remaining feed copies.
  if (needDbCheck.length > 0) {
    const wanted = unionKeys(...needDbCheck.map((c) => aliasesOf(c)));
    const active = new Set((await repo.findActiveByNaturalKeys(wanted)).map(keyOf));
    for (const copy of needDbCheck) {
      const hit = aliasesOf(copy).find((a) => active.has(keyOf(a)));
      if (!hit) continue;
      const copyKey = naturalKeyOf(copy);
      await repo.mergeDuplicateKeys(
        hit,
        unionKeys([copyKey], copy.duplicateKeys.filter((k) => keyOf(k) !== keyOf(hit))),
      );
      suppressed.add(keyOf(copyKey));
    }
  }

  return suppressed.size === 0
    ? batch
    : batch.filter((l) => !suppressed.has(keyOf(naturalKeyOf(l))));
}

// Retire pass (Decision 39's reverse direction), called from persist() with the natural keys
// it just durably wrote (keeps + seenKeeps). If any of those rows is aliased by an ACTIVE
// feed carrier — the feed copy landed first, and the richer ATS copy has now arrived — the
// carrier is delisted and its keys fold into the ATS row, which becomes the canonical. Only
// at persist time is this safe: the ATS copy provably exists as a row (the classifier kept
// it), so retiring the carrier can never lose the posting. Running on seenKeeps too (not
// just fresh keeps) makes it self-healing — a crash after the ATS upsert but before the
// retire is retried on the next sighting.
export async function retireAliasCarriers(
  persistedKeys: ListingKey[],
  repo: DedupRepo = prismaDedupRepo,
): Promise<number> {
  // Aliases only ever point AT ATS rows, so persisted feed rows can't be targets — and
  // skipping them means a pure-feed flush (the simplify board itself) never pays the
  // carrier lookup.
  const targets = persistedKeys.filter((k) => !ALIAS_SOURCE_SET.has(k.source));
  if (targets.length === 0) return 0;

  const persisted = new Set(targets.map(keyOf));
  const carriers = await repo.findActiveCarriersOf(targets);

  let retired = 0;
  for (const carrier of carriers) {
    const carrierKey: ListingKey = {
      source: carrier.source,
      sourceExternalId: carrier.sourceExternalId,
    };
    if (persisted.has(keyOf(carrierKey))) continue; // never a carrier of itself
    // The canonical is the persisted row this carrier ALIASES — a cross-source entry only.
    // A same-source entry is a string-key suppressed sibling, and retiring a canonical over
    // one of those would delist a legitimately distinct row.
    const canonical = aliasesOf(carrier).find((k) => persisted.has(keyOf(k)));
    if (!canonical) continue;
    await repo.retireCarrier(
      carrierKey,
      canonical,
      unionKeys([carrierKey], carrier.duplicateKeys.filter((k) => keyOf(k) !== keyOf(canonical))),
    );
    retired++;
  }
  return retired;
}
