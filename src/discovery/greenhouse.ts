import type { DiscoveryOptions, DiscoverySource } from "./types.js";
import { fetchGreenhouse } from "../sources/greenhouse/fetch.js";
import { cdxUrls, fetchLatestCrawlId } from "./cdx.js";

// Greenhouse board discovery via the Common Crawl URL index (Decision 11).
// Shared CDX plumbing (retry, paging) lives in cdx.ts.

// Both hosts are in use: `boards.` (legacy) and `job-boards.` (current). Query both.
// NOTE (2026-09): a Cloudflare-managed robots.txt now blocks CCBot on `boards.` — recent
// crawls capture nothing there. `job-boards.` is still crawled, so discovery keeps working
// via the current host; keeping `boards.` in the list is harmless (empty yield) and
// self-heals if the block is ever lifted. See research/lever-discovery-common-crawl.md.
const GREENHOUSE_HOSTS = ["boards.greenhouse.io", "job-boards.greenhouse.io"];
// First path segments that are never a board token.
const RESERVED_SEGMENTS = new Set(["embed"]);

// ── Pure slug parsing (unit-tested in greenhouse.test.ts) ────────────────────────────────

// Extract a board token from one captured Greenhouse URL, or null if the URL isn't a board
// (host root, reserved segment, wrong host, malformed). Tokens are lowercased so the same
// board captured with different casing dedupes to one.
export function extractGreenhouseToken(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null; // malformed URL — skip, don't throw (CDX data is dirty)
  }

  if (!GREENHOUSE_HOSTS.includes(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const first = segments[0];
  if (first === undefined) return null; // host root, no token

  // Embed form: /embed/job_board?for={token} — the token is in the query, not the path.
  if (RESERVED_SEGMENTS.has(first)) {
    const forParam = url.searchParams.get("for");
    return forParam ? forParam.toLowerCase() : null;
  }

  return first.toLowerCase();
}

// Extract every distinct board token from a list of captured URLs (dedupe + drop nulls).
export function extractGreenhouseTokens(urls: Iterable<string>): string[] {
  const tokens = new Set<string>();
  for (const url of urls) {
    const token = extractGreenhouseToken(url);
    if (token) tokens.add(token);
  }
  return [...tokens];
}

// Mine Common Crawl for candidate Greenhouse board tokens. Stops early once `targetCount`
// unique tokens are collected (set by a capped --limit run) to avoid paging the full index.
async function discoverCandidates(opts: DiscoveryOptions): Promise<string[]> {
  const crawlId = opts.crawlId ?? (await fetchLatestCrawlId());
  const tokens = new Set<string>();
  for (const host of GREENHOUSE_HOSTS) {
    for await (const url of cdxUrls(crawlId, host)) {
      const token = extractGreenhouseToken(url);
      if (token) tokens.add(token);
      if (opts.targetCount && tokens.size >= opts.targetCount) return [...tokens];
    }
  }
  return [...tokens];
}

export const greenhouseDiscovery: DiscoverySource = {
  source: "greenhouse",
  discoverCandidates,
  // Reuse the existing hardened board fetcher for validation.
  fetchBoard: fetchGreenhouse,
};
