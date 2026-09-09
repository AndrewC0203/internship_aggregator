import type { FetchResult } from "../../pipeline/types.js";

const BASE = "https://api.ashbyhq.com/posting-api/job-board";
const TIMEOUT_MS = 10_000;

// Thrown for every failure mode below so callers can inspect `boardToken`/`status`,
// matching GreenhouseFetchError/LeverFetchError's shape (validate.ts duck-types `status`).
export class AshbyFetchError extends Error {
  constructor(
    message: string,
    public readonly boardToken: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AshbyFetchError";
  }
}

// Fetch all live postings for one Ashby job board.
//
// The public posting-api returns the ENTIRE board in one `{ jobs, apiVersion }` response —
// no pagination (verified live against OpenAI's 780-job board, 2026-09-08). The old
// jobPosting.list note in this file's stub described Ashby's AUTHENTICATED API; the public
// one is a plain GET. `includeCompensation=true` opts into the comp block; boards that
// don't publish comp return a hollow object, which normalize maps to nulls.
//
// Conditional fetch (Decision 23): Ashby sends a weak ETag that genuinely covers the whole
// board (`W/"job-board:<hash>"` — verified live: If-None-Match answers 304). Because the
// response is single-shot, that validator has none of Lever's page-scoping problem, so
// `priorEtag` is actually sent here and `supportsFreshness` is flipped true in the
// orchestrator — the second real freshness source after Greenhouse.
//
// FREE-tier scope only: plain GET + timeout + edge-case handling. NO retry/backoff and NO
// rate-limit throttling baked in here — those apply at the orchestrator/crawl level once
// decided, same as Greenhouse/Lever.
export async function fetchAshby(
  jobBoardName: string,
  priorEtag: string | null = null,
): Promise<FetchResult> {
  const url = `${BASE}/${encodeURIComponent(jobBoardName)}?includeCompensation=true`;

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
      throw new AshbyFetchError(
        `Ashby fetch timed out after ${TIMEOUT_MS}ms for board "${jobBoardName}"`,
        jobBoardName,
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new AshbyFetchError(
      `Ashby fetch network error for board "${jobBoardName}": ${reason}`,
      jobBoardName,
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
    throw new AshbyFetchError(
      `Ashby fetch failed for board "${jobBoardName}": ${res.status} ${res.statusText}`,
      jobBoardName,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AshbyFetchError(
      `Ashby returned non-JSON response for board "${jobBoardName}"`,
      jobBoardName,
      res.status,
    );
  }

  const jobs = (body as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) {
    // The real API always includes a `jobs` array, even for an empty board. A missing or
    // non-array field means the response isn't shaped how we expect, not "no jobs" — treat
    // it as a fetch failure, not an empty result (same posture as Greenhouse/Lever).
    throw new AshbyFetchError(
      `Ashby response was missing a "jobs" array for board "${jobBoardName}"`,
      jobBoardName,
      res.status,
    );
  }

  // The etag is captured only from a fully-validated 200, so a malformed response can never
  // poison the stored validator into 304-ing us past a future valid body.
  return { kind: "ok", jobs, etag: res.headers.get("etag") };
}
