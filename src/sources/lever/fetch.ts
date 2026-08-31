import type { RawJob, FetchResult } from "../../pipeline/types.js";

const BASE = "https://api.lever.co/v0/postings";
const TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 100; // documented max per github.com/lever/postings-api
// Hard ceiling on pages per board (50k jobs) so a misbehaving server that never returns a
// short page can't loop this forever — no real company board comes close. Not a rate-limit
// policy (that's the still-GATED decision at the orchestrator/crawl level); just a sane
// per-call safety bound, same spirit as Greenhouse's TIMEOUT_MS.
const MAX_PAGES = 500;

// Thrown for every failure mode below so callers can inspect `boardToken`/`status`, matching
// GreenhouseFetchError's shape.
export class LeverFetchError extends Error {
  constructor(
    message: string,
    public readonly boardToken: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LeverFetchError";
  }
}

async function fetchPage(
  company: string,
  skip: number,
): Promise<{ jobs: unknown[]; etag: string | null }> {
  const url = `${BASE}/${encodeURIComponent(company)}?mode=json&limit=${PAGE_LIMIT}&skip=${skip}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LeverFetchError(
        `Lever fetch timed out after ${TIMEOUT_MS}ms for board "${company}" (skip=${skip})`,
        company,
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new LeverFetchError(
      `Lever fetch network error for board "${company}" (skip=${skip}): ${reason}`,
      company,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new LeverFetchError(
      `Lever fetch failed for board "${company}" (skip=${skip}): ${res.status} ${res.statusText}`,
      company,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LeverFetchError(
      `Lever returned non-JSON response for board "${company}" (skip=${skip})`,
      company,
      res.status,
    );
  }

  // Unlike Greenhouse's { jobs: [...] } wrapper, Lever's response is a BARE array — verified
  // against a live board (Palantir, 2026-08-31); the public docs never state this explicitly,
  // and research/ats-field-reference.md previously (wrongly) described an offset/total
  // envelope that doesn't exist. A non-array body means the shape isn't what we expect, not
  // "zero jobs" — treat it as a fetch failure so a malformed page can't silently look like an
  // empty/final page and truncate the board.
  if (!Array.isArray(body)) {
    throw new LeverFetchError(
      `Lever response for board "${company}" (skip=${skip}) was not a JSON array`,
      company,
      res.status,
    );
  }

  return { jobs: body, etag: res.headers.get("etag") };
}

// Fetch all live postings for one Lever company, paginating skip/limit to completion.
//
// Conditional fetch (Decision 23): Lever DOES send a weak ETag per page (confirmed live —
// undocumented, likely just a generic web-server content hash, not a designed API feature),
// and a matching If-None-Match on that exact page 304s. But that ETag is scoped to ONE page
// (one skip/limit query), and a multi-page board has no single request — and therefore no
// single ETag — that represents "the whole board." So `priorEtag` is accepted for interface
// symmetry with fetchGreenhouse but deliberately never sent, and this always returns
// `etag: null`: persisting a page-scoped etag as if it covered the whole board would be
// actively wrong once cached, not just unused. `supportsFreshness` stays false in the
// orchestrator until a real whole-board freshness signal exists for paginated sources.
//
// FREE-tier scope only: plain GETs + pagination + edge-case handling. NO retry/backoff
// (WALKTHROUGH-REQUIRED) and NO rate-limit throttling (DECIDE-WITH-ME) are baked in here —
// those apply at the orchestrator/crawl level once decided, same as Greenhouse.
export async function fetchLever(
  company: string,
  priorEtag: string | null = null,
): Promise<FetchResult> {
  const jobs: RawJob[] = [];
  let skip = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { jobs: pageJobs } = await fetchPage(company, skip);
    jobs.push(...pageJobs);

    if (pageJobs.length < PAGE_LIMIT) {
      return { kind: "ok", jobs, etag: null };
    }
    skip += PAGE_LIMIT;
  }

  throw new LeverFetchError(
    `Lever board "${company}" did not terminate pagination within ${MAX_PAGES} pages ` +
      `(${MAX_PAGES * PAGE_LIMIT} jobs) — treating as a fetch failure rather than looping forever`,
    company,
  );
}
