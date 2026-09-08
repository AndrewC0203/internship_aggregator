import type { DiscoveryOptions, DiscoverySource } from "./types.js";
import { fetchLever } from "../sources/lever/fetch.js";
import { cdxUrls, fetchCrawlIds } from "./cdx.js";

// Lever board discovery via the Common Crawl URL index (Decision 26), mirroring the
// Greenhouse approach (Decision 11) with one twist: `jobs.lever.co` started blocking CCBot
// via a Cloudflare-managed robots.txt in late Oct 2025, so crawls from CC-MAIN-2025-47
// onward contain ONLY robots.txt captures. Crawls up to CC-MAIN-2025-43 are rich
// (~1,600 unique tokens each). Instead of pinning a crawl id in code (goes stale silently),
// discovery walks BACKWARD through crawls, newest first, and uses the first one that yields
// real tokens — self-healing if Lever ever unblocks CCBot. Staleness of the mined list is
// fine by design: every candidate is validated against Lever's live API before it becomes a
// crawl target. Measurements: research/lever-discovery-common-crawl.md.
//
// Politeness note: this never crawls the blocked host — it reads Common Crawl's archive
// from when crawling was permitted, and validation hits api.lever.co, the documented public
// postings API, which the robots block does not cover.

// jobs.eu.lever.co exists (EU-hosted boards, still CCBot-crawlable) but is deliberately
// excluded: fetchLever only speaks api.lever.co, so EU tokens would just 404 in validation.
// Add it alongside api.eu.lever.co support if EU coverage is ever wanted (~74 boards).
const LEVER_HOSTS = ["jobs.lever.co"];
// First path segments that are never a board token (host-level well-known files).
const RESERVED_SEGMENTS = new Set(["robots.txt", "favicon.ico", "sitemap.xml"]);
// How many crawls back to search before giving up. The CCBot block landed ~10 crawls before
// this was written; 24 (~2 years of crawls) leaves generous headroom as the good crawls age
// while still bounding requests to Common Crawl (a dead crawl costs ~2 tiny requests).
const MAX_CRAWLS_TO_WALK = 24;
// A crawl "has signal" once it yields this many unique tokens. Robots-only crawls yield 0
// and healthy ones ~1,600, so anything between works; 25 keeps a trace-contaminated crawl
// from masking a rich older one.
const MIN_TOKENS_FOR_SIGNAL = 25;

// ── Pure slug parsing (unit-tested in lever.test.ts) ────────────────────────────────────

// Extract a board token from one captured Lever URL (jobs.lever.co/{token}[/{postingId}]),
// or null if the URL isn't a board page. Lowercased so casing variants dedupe. Kept
// permissive on charset — real tokens contain dots (e.g. "close.io") — because live-API
// validation is the actual junk filter, same posture as Greenhouse.
export function extractLeverToken(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null; // malformed URL — skip, don't throw (CDX data is dirty)
  }

  if (!LEVER_HOSTS.includes(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const first = segments[0];
  if (first === undefined) return null; // host root, no token
  if (RESERVED_SEGMENTS.has(first)) return null;

  return first.toLowerCase();
}

// ── Crawl walk-back ─────────────────────────────────────────────────────────────────────

// Mine one crawl for unique tokens, stopping early at `targetCount` (capped runs).
async function mineCrawl(crawlId: string, targetCount?: number): Promise<string[]> {
  const tokens = new Set<string>();
  for (const host of LEVER_HOSTS) {
    for await (const url of cdxUrls(crawlId, host)) {
      const token = extractLeverToken(url);
      if (token) tokens.add(token);
      if (targetCount && tokens.size >= targetCount) return [...tokens];
    }
  }
  return [...tokens];
}

// Walk crawl ids newest-first and return the first crawl's tokens that reach the signal
// threshold (or `targetCount`, if a capped run asks for less than the threshold). If NO
// crawl reaches it, return the largest yield seen — best-effort beats returning nothing
// when a handful of tokens exist. `mine` is injectable so tests run without the network.
export async function mineFirstCrawlWithSignal(
  crawlIds: string[],
  targetCount: number | undefined,
  mine: (crawlId: string, targetCount?: number) => Promise<string[]> = mineCrawl,
): Promise<string[]> {
  const needed = Math.min(MIN_TOKENS_FOR_SIGNAL, targetCount ?? Infinity);
  let best: string[] = [];
  for (const crawlId of crawlIds.slice(0, MAX_CRAWLS_TO_WALK)) {
    const tokens = await mine(crawlId, targetCount);
    if (tokens.length >= needed) {
      console.error(`  [lever] using crawl ${crawlId} (${tokens.length} tokens)`);
      return tokens;
    }
    console.error(`  [lever] crawl ${crawlId}: ${tokens.length} tokens — below signal, walking back`);
    if (tokens.length > best.length) best = tokens;
  }
  return best;
}

async function discoverCandidates(opts: DiscoveryOptions): Promise<string[]> {
  // An explicit --crawl pins the crawl: the operator knows best, no walk-back.
  if (opts.crawlId) return mineCrawl(opts.crawlId, opts.targetCount);
  return mineFirstCrawlWithSignal(await fetchCrawlIds(), opts.targetCount);
}

export const leverDiscovery: DiscoverySource = {
  source: "lever",
  discoverCandidates,
  // Reuse the existing hardened board fetcher for validation.
  fetchBoard: fetchLever,
};
