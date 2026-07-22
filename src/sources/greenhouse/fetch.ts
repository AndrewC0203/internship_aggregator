import type { RawJob } from "../../pipeline/types.js";

const BASE = "https://boards-api.greenhouse.io/v1/boards";

// Fetch all live postings for one Greenhouse board.
//
// The public Job Board API returns the full jobs list in a single response (no
// pagination), and `?content=true` includes each job's HTML description + departments.
//
// FREE-tier scope only: a plain GET. NO retry/backoff (FIRST-DRAFT-MINE) and NO rate-limit
// throttling (GATED) are baked in here — add them at the orchestrator level once decided.
export async function fetchGreenhouse(boardToken: string): Promise<RawJob[]> {
  const url = `${BASE}/${encodeURIComponent(boardToken)}/jobs?content=true`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });

  if (!res.ok) {
    throw new Error(
      `Greenhouse fetch failed for board "${boardToken}": ${res.status} ${res.statusText}`,
    );
  }

  const body = (await res.json()) as { jobs?: unknown[] };
  return body.jobs ?? [];
}
