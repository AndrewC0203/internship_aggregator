import type { RawJob } from "../../pipeline/types.js";

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
// FREE-tier scope only: a plain GET with timeout + edge-case handling. NO retry/backoff
// (FIRST-DRAFT-MINE) and NO rate-limit throttling (GATED) are baked in here — add them
// at the orchestrator level once decided.
export async function fetchGreenhouse(boardToken: string): Promise<RawJob[]> {
  const url = `${BASE}/${encodeURIComponent(boardToken)}/jobs?content=true`;

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
    return [];
  }
  if (!Array.isArray(jobs)) {
    throw new GreenhouseFetchError(
      `Greenhouse response had a non-array "jobs" field for board "${boardToken}"`,
      boardToken,
      res.status,
    );
  }
  return jobs;
}
