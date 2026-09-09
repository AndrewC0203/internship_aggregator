import type { DiscoveryOptions, DiscoverySource } from "./types.js";
import { fetchAshby } from "../sources/ashby/fetch.js";
import { cdxUrls, fetchLatestCrawlId } from "./cdx.js";

// Ashby board discovery via the Common Crawl URL index, mirroring Greenhouse (Decision 11).
// Unlike Lever, jobs.ashbyhq.com does NOT block CCBot (robots.txt disallows only /meeting/,
// /b/, /api/ — checked 2026-09-08), so the latest crawl is rich and no walk-back is needed.
// If Ashby ever Cloudflare-blocks CCBot the way Lever and boards.greenhouse.io did, switch
// this to lever.ts's mineFirstCrawlWithSignal walk-back — that's the self-healing variant.
const ASHBY_HOSTS = ["jobs.ashbyhq.com"];
// First path segments that are never a board token: robots.txt-disallowed app routes plus
// host-level well-known files. Kept minimal on purpose — live-API validation is the actual
// junk filter, same posture as Greenhouse/Lever.
const RESERVED_SEGMENTS = new Set([
  "api",
  "meeting",
  "b",
  "robots.txt",
  "favicon.ico",
  "sitemap.xml",
]);

// ── Pure slug parsing (unit-tested in ashby.test.ts) ────────────────────────────────────

// Extract a board token from one captured Ashby URL (jobs.ashbyhq.com/{org}[/{postingId}
// [/application]]), or null if the URL isn't a board page. Lowercased so casing variants
// dedupe.
export function extractAshbyToken(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null; // malformed URL — skip, don't throw (CDX data is dirty)
  }

  if (!ASHBY_HOSTS.includes(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const first = segments[0];
  if (first === undefined) return null; // host root, no token
  if (RESERVED_SEGMENTS.has(first)) return null;

  return first.toLowerCase();
}

// Mine Common Crawl for candidate Ashby board tokens. Stops early once `targetCount`
// unique tokens are collected (set by a capped --limit run) to avoid paging the full index.
async function discoverCandidates(opts: DiscoveryOptions): Promise<string[]> {
  const crawlId = opts.crawlId ?? (await fetchLatestCrawlId());
  const tokens = new Set<string>();
  for (const host of ASHBY_HOSTS) {
    for await (const url of cdxUrls(crawlId, host)) {
      const token = extractAshbyToken(url);
      if (token) tokens.add(token);
      if (opts.targetCount && tokens.size >= opts.targetCount) return [...tokens];
    }
  }
  return [...tokens];
}

export const ashbyDiscovery: DiscoverySource = {
  source: "ashby",
  discoverCandidates,
  // Reuse the hardened board fetcher for validation.
  fetchBoard: fetchAshby,
};
