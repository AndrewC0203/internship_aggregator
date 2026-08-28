import type { FetchResult } from "../../pipeline/types.js";

// Fetch raw job postings for one Ashby job board.
// TODO: POST /jobPosting.list + cursor pagination (see research/ats-field-reference.md).
// `priorEtag` (Decision 23): accept-and-ignore until Ashby is implemented AND its validator
// support is verified — return kind "ok" with etag null if it sends none.
// NOTE: rate limiting (GATED) and retry/backoff (FIRST-DRAFT-MINE) are separate
// decisions — do not bake them in here.
export async function fetchAshby(
  jobBoardName: string,
  priorEtag: string | null = null,
): Promise<FetchResult> {
  throw new Error("fetchAshby not implemented");
}
