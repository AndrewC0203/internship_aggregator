import type { DiscoveryOptions, DiscoverySource } from "./types.js";
import { fetchGreenhouse } from "../sources/greenhouse/fetch.js";

// Greenhouse board discovery via the Common Crawl URL index (Decision 11).
// See research/common-crawl-index.md for the CDX API contract this relies on.

const CDX_BASE = "https://index.commoncrawl.org";
const COLLINFO_URL = `${CDX_BASE}/collinfo.json`;
// Both hosts are in use: `boards.` (legacy) and `job-boards.` (current). Query both.
const GREENHOUSE_HOSTS = ["boards.greenhouse.io", "job-boards.greenhouse.io"];
// First path segments that are never a board token.
const RESERVED_SEGMENTS = new Set(["embed"]);
const CDX_TIMEOUT_MS = 30_000;

// Thrown for Common Crawl request failures (network/timeout/non-2xx/non-JSON). Separate
// from GreenhouseFetchError — this is about the discovery source, not the board API.
export class DiscoveryFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DiscoveryFetchError";
  }
}

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

// ── Common Crawl CDX querying ─────────────────────────────────────────────────────────────

// Fetch a URL from the CDX service with a timeout that also covers reading the body (the
// body read is inside the guard, unlike the board fetcher — CDX pages can be large).
async function cdxGetText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CDX_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new DiscoveryFetchError(
        `Common Crawl CDX request failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    return await res.text();
  } catch (err) {
    if (err instanceof DiscoveryFetchError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new DiscoveryFetchError(`Common Crawl CDX request timed out after ${CDX_TIMEOUT_MS}ms`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new DiscoveryFetchError(`Common Crawl CDX network error: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function cdxGetJson<T>(url: string): Promise<T> {
  const text = await cdxGetText(url);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DiscoveryFetchError(`Common Crawl CDX returned non-JSON for ${url}`);
  }
}

// Newest crawl id (collinfo.json is ordered newest-first).
async function fetchLatestCrawlId(): Promise<string> {
  const crawls = await cdxGetJson<Array<{ id?: string }>>(COLLINFO_URL);
  const latest = crawls[0]?.id;
  if (!latest) {
    throw new DiscoveryFetchError("Common Crawl collinfo.json returned no crawls");
  }
  return latest;
}

function cdxHostQuery(crawlId: string, host: string, extra: string): string {
  const pattern = encodeURIComponent(`${host}/*`);
  return `${CDX_BASE}/${crawlId}-index?url=${pattern}&output=json${extra}`;
}

// How many CDX pages exist for this host in this crawl.
async function cdxNumPages(crawlId: string, host: string): Promise<number> {
  const body = await cdxGetJson<{ pages?: number }>(
    cdxHostQuery(crawlId, host, "&showNumPages=true"),
  );
  return typeof body.pages === "number" ? body.pages : 0;
}

// Yield every captured URL for a host, one page at a time. An async generator (rather than
// returning a big array) lets the caller stop paging early once it has enough candidates —
// polite to Common Crawl and fast for capped runs. Pages are fetched SEQUENTIALLY on
// purpose (free public service; never parallelize against it).
async function* cdxUrls(crawlId: string, host: string): AsyncGenerator<string> {
  const pages = await cdxNumPages(crawlId, host);
  for (let page = 0; page < pages; page++) {
    const text = await cdxGetText(cdxHostQuery(crawlId, host, `&fields=url&page=${page}`));
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { url?: string };
        if (obj.url) yield obj.url;
      } catch {
        // Skip a malformed NDJSON line rather than failing the whole page.
      }
    }
  }
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
