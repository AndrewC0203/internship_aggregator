import type { Source } from "@prisma/client";
import type { NormalizedListing } from "../types.js";
import { prisma } from "../../db.js";

// Staleness/delisting stage (Decision 22).
//
// CORE RULE: a listing is stale when its board was crawled SUCCESSFULLY (this function is only
// ever called from a code path that already confirmed that) and the listing's sourceExternalId
// did not appear in that crawl's normalized output. Absence from a FAILED or skipped crawl proves
// nothing about the listing — the orchestrator enforces that by only calling this after a
// successful fetch, never from the catch branch.
//
// Zero grace period, by design: one successful-crawl-without-it is enough to delist. A grace
// window (N missed crawls / N days) was considered and rejected — see DECISIONS.md Decision 22.
//
// Delist-never-delete (Decision 9 posture): this only ever flips `isListed` to false. It never
// touches `seen_listings` — that table is reject-memory (Decision 12/18), and a staleness-delist
// is not a classifier verdict. Leaving `seen_listings` untouched is exactly what makes reversal
// free: if the listing reappears in a later successful crawl, partitionBySeen finds it via the
// (isListed-agnostic) `listings` lookup, routes it as a seenKeep, and persist() flips
// `isListed` back to true — no special-casing needed anywhere.
export interface DelistRepo {
  delistMissing(params: {
    source: Source;
    company: string;
    seenExternalIds: string[];
  }): Promise<number>;
  // Decision 38 variant: same absence rule, scoped by SOURCE alone. Only sound when one
  // crawl covers the source's entire listing universe — see delistStaleForSource's guard.
  delistMissingBySource(params: { source: Source; seenExternalIds: string[] }): Promise<number>;
}

export const prismaDelistRepo: DelistRepo = {
  async delistMissing({ source, company, seenExternalIds }) {
    const result = await prisma.listing.updateMany({
      where: {
        source,
        company,
        isListed: true,
        sourceExternalId: { notIn: seenExternalIds },
      },
      data: { isListed: false },
    });
    return result.count;
  },

  async delistMissingBySource({ source, seenExternalIds }) {
    const result = await prisma.listing.updateMany({
      where: {
        source,
        isListed: true,
        sourceExternalId: { notIn: seenExternalIds },
      },
      data: { isListed: false },
    });
    return result.count;
  },
};

// A board's company is derived FRESH from this crawl's own normalized output, never guessed from
// the token (Decision 11 already rejected token->company guessing for the live pipeline; the same
// reasoning applies here). Returns null — "don't know, don't act" — for the two cases where a
// single confident value doesn't exist: no listings this crawl (nothing to derive from), or more
// than one distinct company string in one board's response (ambiguous; unresolved beats a
// coin-flip, same posture as the Decision 19 location parser).
export function deriveBoardCompany(boardListings: NormalizedListing[]): string | null {
  const companies = new Set(boardListings.map((l) => l.company.trim()).filter(Boolean));
  return companies.size === 1 ? [...companies][0] : null;
}

export interface DelistResult {
  delistedCount: number;
  // The company this run's delist check actually used — null if none was resolvable (fresh or
  // cached), meaning no delist action was taken. The caller (orchestrator) uses a non-null,
  // freshly-DERIVED value to update CrawlTarget.company; a cached-fallback value is not written
  // back, since it didn't come from this crawl.
  resolvedCompany: string | null;
}

// Orchestrates one board's delist check. `cachedCompany` is CrawlTarget.company from a PRIOR
// successful crawl — the fallback anchor for the case this run's board returned zero jobs (a
// company pulling their whole board is a real, common staleness signal; with nothing in an empty
// response to derive company from, there's no way to scope the delist query without a cache).
export async function delistStaleForBoard(
  source: Source,
  boardListings: NormalizedListing[],
  cachedCompany: string | null,
  repo: DelistRepo = prismaDelistRepo,
): Promise<DelistResult> {
  const freshCompany = deriveBoardCompany(boardListings);

  // Ambiguous (>=2 distinct companies in one board's response) is a DIRTY signal, not an empty
  // one — something is wrong with this crawl's data, so falling back to a stale cached company
  // would mean guessing which of several unrelated things to trust. That's a strictly worse bet
  // than a genuinely empty response (a clean "nothing here" the cache exists to handle). Hard
  // no-op regardless of cache; only a truly empty crawl (boardListings.length === 0) falls
  // through to the cache below.
  if (boardListings.length > 0 && freshCompany === null) {
    return { delistedCount: 0, resolvedCompany: null };
  }

  const company = freshCompany ?? cachedCompany;
  if (!company) {
    return { delistedCount: 0, resolvedCompany: null };
  }

  const seenExternalIds = boardListings.map((l) => l.sourceExternalId);
  const delistedCount = await repo.delistMissing({ source, company, seenExternalIds });

  return { delistedCount, resolvedCompany: freshCompany };
}

// Source-scoped staleness check (Decision 38) for a source whose one crawl IS its whole
// listing universe — the simplify file spans hundreds of companies, so the company anchor
// above cannot scope it, but the source itself can. Same core rule as delistStaleForBoard:
// only ever called after a confirmed-successful fetch; absence from that fetch delists,
// zero grace period; reversal is free via the seenKeep resurrect path.
//
// `activeTargetCount` is the soundness guard: with two active targets per source (say a
// second Simplify repo), each crawl sees only ITS file's actives, and a source-wide absence
// delist would let one repo's crawl delist the other's rows. Listings carry no board
// discriminator today, so >1 target makes this a hard no-op — the caller must pass the
// source's ACTIVE crawl_targets count, not the count it happened to iterate.
export async function delistStaleForSource(
  source: Source,
  boardListings: NormalizedListing[],
  activeTargetCount: number,
  repo: DelistRepo = prismaDelistRepo,
): Promise<{ delistedCount: number }> {
  if (activeTargetCount !== 1) {
    console.error(
      `[delist] ${source}: source-scoped delist skipped — ${activeTargetCount} active targets ` +
        `(sound only with exactly 1; add a board discriminator to listings before adding more)`,
    );
    return { delistedCount: 0 };
  }
  const seenExternalIds = boardListings.map((l) => l.sourceExternalId);
  const delistedCount = await repo.delistMissingBySource({ source, seenExternalIds });
  return { delistedCount };
}
