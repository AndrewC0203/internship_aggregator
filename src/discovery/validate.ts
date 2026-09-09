import type { BoardFetcher } from "./types.js";

// Four outcomes so the orchestrator can act + log distinctly. "rate_limited" is separated
// from "error" because the orchestrator's response differs: an error skips one token, a
// 429 pauses the WHOLE source's loop (Decision 27) — collapsing them would hide the one
// signal the pacing posture must react to.
export type ValidationOutcome = "valid" | "empty" | "error" | "rate_limited";

// Confirm a candidate token is a live board (Decision 11: 200 + non-empty jobs = keep).
//  - "valid": board resolves with >=1 job -> becomes a crawl target
//  - "empty": board resolves with 0 jobs, OR doesn't exist (404) -> drop silently. Both are
//    expected for stale Common Crawl URLs; neither is a failure.
//  - "error": transient/unexpected failure (timeout, 5xx, network, malformed body) -> skip
//    THIS run and log. No retry here (retry/backoff is FIRST-DRAFT-MINE); nothing is
//    deactivated on a transient error — a flaky request shouldn't retire a known board.
export async function validateToken(
  token: string,
  fetchBoard: BoardFetcher,
): Promise<ValidationOutcome> {
  try {
    const result = await fetchBoard(token);
    // Discovery never passes a prior etag, so "not_modified" is unreachable in practice —
    // but if it ever arrives, the server just confirmed the board exists, which is "valid".
    if (result.kind === "not_modified") return "valid";
    return result.jobs.length > 0 ? "valid" : "empty";
  } catch (err) {
    // 404 = "no such board" — an expected drop, not an error. The board fetchers carry the
    // HTTP status on the error (e.g. GreenhouseFetchError.status); duck-typed so this stays
    // source-agnostic as Lever/Ashby discovery is added.
    const status = (err as { status?: number })?.status;
    if (status === 404) return "empty";
    if (status === 429) return "rate_limited";
    return "error";
  }
}
