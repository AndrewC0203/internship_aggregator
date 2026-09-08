// Shared Common Crawl CDX plumbing for all discovery sources (Decision 11 for Greenhouse,
// Decision 26 for Lever). See research/common-crawl-index.md for the CDX API contract.
// Extracted from greenhouse.ts when Lever discovery was added — one CDX client, N sources.

const CDX_BASE = "https://index.commoncrawl.org";
const COLLINFO_URL = `${CDX_BASE}/collinfo.json`;
const CDX_TIMEOUT_MS = 30_000;
// Common Crawl's CDX endpoint intermittently returns 502/503/504 under load. Since this is
// a monthly job, latency is cheap — retry transient failures with exponential backoff
// (1s, 2s, 4s, 8s) before giving up on a single request. Retry lives ONLY in the CDX layer
// (Decision: keep separate from the ATS board fetcher, which may want different logic).
const CDX_MAX_RETRIES = 4;
const CDX_RETRY_BASE_MS = 1_000;

// Thrown for Common Crawl request failures (network/timeout/non-2xx/non-JSON). Separate
// from the per-source fetch errors — this is about the discovery source, not the board API.
export class DiscoveryFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DiscoveryFetchError";
  }
}

// ── Transient-failure retry (CDX layer only) ────────────────────────────────────────────

// A CDX failure is worth retrying if it's transient: a network/timeout error (no HTTP
// status) or a server-side status (429 rate-limit, or any 5xx). A 4xx like 404 is a real
// "not there" answer — retrying won't change it, so it's fatal. Non-DiscoveryFetchError
// (an unexpected bug) is not retried either.
export function isRetryableCdxError(err: unknown): boolean {
  if (!(err instanceof DiscoveryFetchError)) return false;
  const { status } = err;
  return status === undefined || status === 429 || status >= 500;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Run `fn`, retrying transient failures with exponential backoff. Injectable delay/sleep so
// tests run instantly. Throws the last error once retries are exhausted or on a fatal error.
export async function withCdxRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts: { retries?: number; baseMs?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = opts.retries ?? CDX_MAX_RETRIES;
  const baseMs = opts.baseMs ?? CDX_RETRY_BASE_MS;
  const sleepFn = opts.sleepFn ?? sleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableCdxError(err) || attempt >= retries) throw err;
      const delay = baseMs * 2 ** attempt;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`  CDX ${label}: ${reason} — retry ${attempt + 1}/${retries} in ${delay}ms`);
      await sleepFn(delay);
    }
  }
}

// ── Common Crawl CDX querying ─────────────────────────────────────────────────────────────

// Fetch a URL from the CDX service, retrying transient failures. Each attempt gets a fresh
// timeout that also covers reading the body (body read is inside the guard — CDX pages can
// be large).
function cdxGetText(url: string): Promise<string> {
  return withCdxRetry(() => cdxGetTextOnce(url), `GET ${url}`);
}

async function cdxGetTextOnce(url: string): Promise<string> {
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

// All crawl ids, newest first (collinfo.json is ordered newest-first). Sources that need
// only the latest take [0]; sources that walk back through history (Lever, whose host
// blocks CCBot in recent crawls) iterate.
export async function fetchCrawlIds(): Promise<string[]> {
  const crawls = await cdxGetJson<Array<{ id?: string }>>(COLLINFO_URL);
  const ids = crawls.map((c) => c.id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) {
    throw new DiscoveryFetchError("Common Crawl collinfo.json returned no crawls");
  }
  return ids;
}

// Newest crawl id.
export async function fetchLatestCrawlId(): Promise<string> {
  return (await fetchCrawlIds())[0];
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
export async function* cdxUrls(crawlId: string, host: string): AsyncGenerator<string> {
  let pages: number;
  try {
    pages = await cdxNumPages(crawlId, host);
  } catch (err) {
    // Page count failed even after retries — without it we can't page this host, so skip
    // the whole host and continue with the others (skip-and-continue over aborting the run).
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`  CDX: skipping host ${host} — page count failed after retries: ${reason}`);
    return;
  }

  for (let page = 0; page < pages; page++) {
    let text: string;
    try {
      text = await cdxGetText(cdxHostQuery(crawlId, host, `&fields=url&page=${page}`));
    } catch (err) {
      // One page failed even after retries — skip it and keep the rest. A few missing slugs
      // beats discarding the whole sweep; the monthly cadence backfills them next run.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`  CDX: skipping ${host} page ${page}/${pages} after retries: ${reason}`);
      continue;
    }
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
