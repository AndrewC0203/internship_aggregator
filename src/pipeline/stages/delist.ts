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
