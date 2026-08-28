import type { RawJob, FetchResult } from "../../pipeline/types.js";

const BASE = "https://boards-api.greenhouse.io/v1/boards";
const TIMEOUT_MS = 10_000;

// Thrown for every failure mode below so callers can inspect `boardToken`/`status`
// instead of parsing the message string.
export class GreenhouseFetchError extends Error {
  constructor(
    message: string,
    public readonly boardToken: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GreenhouseFetchError";
  }
}

// Fetch all live postings for one Greenhouse board.
//
// The public Job Board API returns the full jobs list in a single response (no
// pagination), and `?content=true` includes each job's HTML description + departments.
//
// Conditional fetch (Decision 23): pass `priorEtag` (the stored validator from the last
// successful full fetch) and it's sent as If-None-Match. Greenhouse answers 304 with an
// empty body when the board is unchanged — measured ~0.13s / 0 bytes vs ~0.4s / 3.5MB for
// a large board — and the caller skips the whole normalize/pipeline pass. A 304 is still a
// SUCCESSFUL crawl for freshness purposes: the server asserted the body is unchanged, so
// the listing set is exactly what it was last time.
//
// FREE-tier scope only: a plain GET with timeout + edge-case handling. NO retry/backoff
// (FIRST-DRAFT-MINE) and NO rate-limit throttling (GATED) are baked in here — add them
// at the orchestrator level once decided.
export async function fetchGreenhouse(
  boardToken: string,
  priorEtag: string | null = null,
): Promise<FetchResult> {
  const url = `${BASE}/${encodeURIComponent(boardToken)}/jobs?content=true`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(priorEtag ? { "If-None-Match": priorEtag } : {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GreenhouseFetchError(
        `Greenhouse fetch timed out after ${TIMEOUT_MS}ms for board "${boardToken}"`,
        boardToken,
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new GreenhouseFetchError(
      `Greenhouse fetch network error for board "${boardToken}": ${reason}`,
      boardToken,
    );
  } finally {
    clearTimeout(timeout);
  }

  // 304 sits outside res.ok but is the SUCCESS case of a conditional request, so it must be
  // checked before the !ok throw. Only reachable when priorEtag was sent.
  if (res.status === 304) {
    return { kind: "not_modified" };
  }

  if (!res.ok) {
    throw new GreenhouseFetchError(
      `Greenhouse fetch failed for board "${boardToken}": ${res.status} ${res.statusText}`,
      boardToken,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GreenhouseFetchError(
      `Greenhouse returned non-JSON response for board "${boardToken}"`,
      boardToken,
      res.status,
    );
  }

  const jobs = (body as { jobs?: unknown } | null)?.jobs;
  if (jobs === undefined) {
    // The real API always includes a `jobs` array, even for a board with zero
    // postings (`jobs: []`). A missing key means the response wasn't shaped how
    // we expect, not "no jobs" — treat it as a fetch failure, not an empty result.
    throw new GreenhouseFetchError(
      `Greenhouse response was missing a "jobs" field for board "${boardToken}"`,
      boardToken,
      res.status,
    );
  }
  if (!Array.isArray(jobs)) {
    throw new GreenhouseFetchError(
      `Greenhouse response had a non-array "jobs" field for board "${boardToken}"`,
      boardToken,
      res.status,
    );
  }
  // The etag is captured only from a fully-validated 200 — if any of the shape checks above
  // threw, no validator is returned, so a malformed response can never poison the stored etag
  // into 304-ing us past a future valid body.
  return { kind: "ok", jobs, etag: res.headers.get("etag") };
}
